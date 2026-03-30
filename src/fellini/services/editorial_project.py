from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from fellini.adapters.ffmpeg import FFmpegAdapter, FFmpegError
from fellini.domain.models import (
    AudioTrackRole,
    ClipOrigin,
    EditorialProject,
    InputAsset,
    LaneTranscription,
    LaneTranscriptionStatus,
    ProjectAsset,
    ProjectAssetKind,
    ProjectSelection,
    ProjectSequence,
    SourceWordRef,
    SubtitleBlock,
    TimelineClip,
    TimelineTrack,
    TimelineTrackKind,
    TranscriptArtifact,
    utcnow,
)
from fellini.log import get_logger
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings

logger = get_logger(__name__)
DEFAULT_TRACK_PAIR_COUNT = 2
# Legacy-only track id kept for migration of older saved projects.
CAPTION_TRACK_ID = "track_subtitle_1"

if TYPE_CHECKING:
    from fellini.pipeline.context import PipelineContext


class EditorialProjectStore:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.ffmpeg = FFmpegAdapter(settings)

    def exists(self, workspace: JobWorkspace) -> bool:
        return workspace.editorial_project_path.exists()

    def load(self, workspace: JobWorkspace) -> EditorialProject:
        payload = json.loads(workspace.editorial_project_path.read_text(encoding="utf-8"))
        return EditorialProject.model_validate(payload)

    def save(self, workspace: JobWorkspace, project: EditorialProject) -> EditorialProject:
        project, _ = self._normalize_track_layout(project)
        current_revision = 0
        if workspace.editorial_project_path.exists():
            current_revision = self.load(workspace).revision
        project = project.model_copy(
            update={
                "revision": max(current_revision + 1, project.revision + 1),
                "updated_at": utcnow(),
            },
            deep=True,
        )
        workspace.project_dir.mkdir(parents=True, exist_ok=True)
        workspace.editorial_project_path.write_text(
            project.model_dump_json(indent=2),
            encoding="utf-8",
        )
        logger.info(
            "editorial_project.save workspace=%s revision=%s assets=%s tracks=%s clips=%s captions=%s",
            workspace.job_dir,
            project.revision,
            len(project.assets),
            len(project.tracks),
            len(project.clips),
            len(project.captions),
        )
        return project

    def save_with_revision_check(
        self, workspace: JobWorkspace, project: EditorialProject
    ) -> EditorialProject:
        if workspace.editorial_project_path.exists():
            current = self.load(workspace)
            if project.revision != current.revision:
                msg = (
                    f"Editorial project revision mismatch. Expected {current.revision}, "
                    f"received {project.revision}."
                )
                raise ValueError(msg)
        return self.save(workspace, project)

    def ensure(self, context: PipelineContext) -> EditorialProject:
        workspace = context.workspace
        if self.exists(workspace):
            project = self.load(workspace)
            if (
                not project.assets
                and not project.clips
                and context.state.mezzanine_path
                and Path(context.state.mezzanine_path).exists()
            ):
                project = self._bootstrap_from_context(context)
                return self.save(workspace, project)
            project, linked_migrated = self._normalize_linked_clip_groups(project)
            project, tracks_migrated = self._normalize_track_layout(project)
            hydrated = self._hydrate_legacy_captions(workspace, project)
            hydrated, source_labels_migrated = self._normalize_source_asset_labels(
                hydrated,
                context.request.input_assets,
            )
            hydrated, subtitles_migrated = self._normalize_generated_subtitles(hydrated)
            if (
                linked_migrated
                or tracks_migrated
                or source_labels_migrated
                or subtitles_migrated
                or len(hydrated.captions) != len(project.captions)
            ):
                return self.save(workspace, hydrated)
            return hydrated

        project = self._bootstrap_from_context(context)
        return self.save(workspace, project)

    def add_asset(
        self,
        workspace: JobWorkspace,
        *,
        original_name: str,
        payload: bytes,
    ) -> tuple[EditorialProject, ProjectAsset, str]:
        project = self.load(workspace)
        suffix = Path(original_name).suffix or ".bin"
        stored_name = f"lib_{uuid4().hex[:8]}{suffix}"
        target = workspace.upload_path(stored_name)
        target.write_bytes(payload)
        asset = self._asset_from_media(workspace, target, label=Path(original_name).name)
        project.assets.append(asset)
        project = self.save(workspace, project)
        return project, asset, stored_name

    def set_lane_transcription(
        self,
        workspace: JobWorkspace,
        *,
        project: EditorialProject,
        lane_id: str,
        transcript: TranscriptArtifact,
        source_audio_path: str,
    ) -> EditorialProject:
        next_lane = LaneTranscription(
            lane_id=lane_id,
            status=LaneTranscriptionStatus.completed,
            language=transcript.language,
            segments=transcript.segments,
            source_audio_path=source_audio_path,
            error=None,
        )
        project = project.model_copy(deep=True)
        project.lane_transcriptions = [
            lane for lane in project.lane_transcriptions if lane.lane_id != lane_id
        ]
        project.lane_transcriptions.append(next_lane)
        self._replace_generated_subtitle_blocks(project, lane_id, transcript)
        return self.save(workspace, project)

    def story_lane(self, project: EditorialProject) -> TimelineTrack | None:
        audio_tracks = [track for track in project.tracks if track.kind == TimelineTrackKind.audio]
        for track in audio_tracks:
            if track.role == AudioTrackRole.story:
                return track
        return audio_tracks[0] if audio_tracks else None

    def story_lane_transcription(self, project: EditorialProject) -> LaneTranscription | None:
        story_lane = self.story_lane(project)
        if not story_lane:
            return None
        return next(
            (lane for lane in project.lane_transcriptions if lane.lane_id == story_lane.id),
            None,
        )

    def subtitle_track(self, project: EditorialProject) -> TimelineTrack:
        video_tracks = sorted(
            (track for track in project.tracks if track.kind == TimelineTrackKind.video),
            key=lambda track: track.order,
        )
        match = next(
            (
                track
                for track in video_tracks
                if not any(clip.enabled and clip.track_id == track.id for clip in project.clips)
            ),
            None,
        )
        if not match:
            match = video_tracks[0] if video_tracks else None
        if not match:
            match = next(
                (track for track in project.tracks if track.kind == TimelineTrackKind.subtitle),
                None,
            )
        if not match:
            msg = "Editorial project is missing a video lane for subtitles."
            raise ValueError(msg)
        return match

    def track_clips(self, project: EditorialProject, track_id: str) -> list[TimelineClip]:
        return [clip for clip in project.clips if clip.track_id == track_id and clip.enabled]

    def set_story_lane(self, project: EditorialProject, lane_id: str) -> EditorialProject:
        updated = project.model_copy(deep=True)
        for track in updated.tracks:
            if track.kind != TimelineTrackKind.audio:
                continue
            track.role = AudioTrackRole.story if track.id == lane_id else AudioTrackRole.support
        return updated

    def _bootstrap_from_context(self, context: PipelineContext) -> EditorialProject:
        state = context.state
        project = EditorialProject(
            sequence=ProjectSequence(
                width=context.request.render.width,
                height=context.request.render.height,
                fps=state.probe_info[0].fps if state.probe_info and state.probe_info[0].fps else 30.0,
                sample_rate=state.probe_info[0].sample_rate if state.probe_info and state.probe_info[0].sample_rate else 48000,
            ),
            selection=ProjectSelection(),
        )

        project.tracks = [
            self._create_generated_track(TimelineTrackKind.video, 2, 0),
            self._create_generated_track(TimelineTrackKind.video, 1, 1),
            self._create_generated_track(
                TimelineTrackKind.audio,
                1,
                2,
                role=AudioTrackRole.story,
            ),
            self._create_generated_track(
                TimelineTrackKind.audio,
                2,
                3,
                role=AudioTrackRole.support,
            ),
        ]

        if state.mezzanine_path and Path(state.mezzanine_path).exists():
            source_asset = self._asset_from_media(
                context.workspace,
                Path(state.mezzanine_path),
                label=self._source_asset_label(
                    context.request.input_assets,
                    Path(state.mezzanine_path),
                ),
                origin="ingest",
            )
            project.assets.append(source_asset)

        return self._hydrate_legacy_captions(context.workspace, project)

    def _source_asset_label(self, input_assets: list[InputAsset], fallback_path: Path) -> str:
        labels = [Path(asset.original_name).name for asset in input_assets if asset.original_name]
        if not labels:
            return fallback_path.name
        if len(labels) == 1:
            return labels[0]
        return f"{labels[0]} +{len(labels) - 1}"

    def _normalize_source_asset_labels(
        self,
        project: EditorialProject,
        input_assets: list[InputAsset],
    ) -> tuple[EditorialProject, bool]:
        source_asset = next(
            (
                asset
                for asset in project.assets
                if asset.origin == "ingest" and asset.path.endswith("source_mezzanine.mp4")
            ),
            None,
        )
        if not source_asset:
            return project, False
        label = self._source_asset_label(input_assets, Path(source_asset.path))
        if source_asset.label == label:
            return project, False
        updated = project.model_copy(deep=True)
        for asset in updated.assets:
            if asset.id == source_asset.id:
                asset.label = label
                break
        return updated, True

    def _numeric_suffix(self, value: str) -> int | None:
        digits = []
        for char in reversed(value):
            if not char.isdigit():
                break
            digits.append(char)
        if not digits:
            return None
        return int("".join(reversed(digits)))

    def _track_pair_number(self, project: EditorialProject, track: TimelineTrack) -> int:
        if track.kind == TimelineTrackKind.subtitle:
            return 0
        direct = self._numeric_suffix(track.id) or self._numeric_suffix(track.name)
        if direct:
            return direct
        siblings = [item for item in sorted(project.tracks, key=lambda current: current.order) if item.kind == track.kind]
        for index, sibling in enumerate(siblings, start=1):
            if sibling.id == track.id:
                return index
        return 1

    def _next_pair_number(self, pair_numbers: list[int]) -> int:
        used = {value for value in pair_numbers if value > 0}
        next_pair = 1
        while next_pair in used:
            next_pair += 1
        return next_pair

    def _create_generated_track(
        self,
        kind: TimelineTrackKind,
        pair_number: int,
        order: int,
        *,
        role: AudioTrackRole | None = None,
    ) -> TimelineTrack:
        return TimelineTrack(
            id=f"track_{kind.value}_{pair_number}",
            kind=kind,
            name=f"{'Video' if kind == TimelineTrackKind.video else 'Audio'} {pair_number}",
            order=order,
            auto_generated=True,
            role=role,
        )

    def _normalize_track_layout(
        self, project: EditorialProject
    ) -> tuple[EditorialProject, bool]:
        updated = project.model_copy(deep=True)
        legacy_caption_track = next(
            (
                track
                for track in updated.tracks
                if track.id == CAPTION_TRACK_ID or track.kind == TimelineTrackKind.subtitle
            ),
            None,
        )

        av_tracks = [
            track for track in sorted(updated.tracks, key=lambda current: current.order)
            if track.kind in {TimelineTrackKind.video, TimelineTrackKind.audio}
            and track.id != CAPTION_TRACK_ID
        ]
        pair_numbers = sorted(
            {
                self._track_pair_number(updated, track)
                for track in av_tracks
                if self._track_pair_number(updated, track) > 0
            }
        )
        while len(pair_numbers) < DEFAULT_TRACK_PAIR_COUNT:
            pair_numbers.append(self._next_pair_number(pair_numbers))

        tracks_by_pair: dict[int, dict[str, TimelineTrack]] = {}
        for track in av_tracks:
            pair_number = self._track_pair_number(updated, track)
            pair_entry = tracks_by_pair.setdefault(pair_number, {})
            pair_entry[track.kind.value] = track

        track_lookup = {track.id: track for track in updated.tracks}
        occupied_pairs: set[int] = set()
        for clip in updated.clips:
            if not clip.enabled:
                continue
            track = track_lookup.get(clip.track_id)
            if not track or track.kind not in {TimelineTrackKind.video, TimelineTrackKind.audio}:
                continue
            occupied_pairs.add(self._track_pair_number(updated, track))
        if pair_numbers and all(pair_number in occupied_pairs for pair_number in pair_numbers):
            pair_numbers.append(self._next_pair_number(pair_numbers))

        sorted_pair_numbers = sorted(pair_numbers)
        next_video_tracks: list[TimelineTrack] = []
        next_audio_tracks: list[TimelineTrack] = []
        for pair_number in sorted_pair_numbers:
            pair_entry = tracks_by_pair.get(pair_number, {})
            video_track = pair_entry.get("video") or self._create_generated_track(
                TimelineTrackKind.video,
                pair_number,
                0,
            )
            audio_track = pair_entry.get("audio") or self._create_generated_track(
                TimelineTrackKind.audio,
                pair_number,
                0,
                role=AudioTrackRole.support,
            )
            next_video_tracks.append(
                video_track.model_copy(
                    update={
                        "name": f"Video {pair_number}",
                        "order": 0,
                        "role": None,
                    },
                    deep=True,
                )
            )
            next_audio_tracks.append(
                audio_track.model_copy(
                    update={
                        "name": f"Audio {pair_number}",
                        "order": 0,
                        "role": audio_track.role or AudioTrackRole.support,
                    },
                    deep=True,
                )
            )
        next_tracks = [
            track.model_copy(update={"order": index}, deep=True)
            for index, track in enumerate([*reversed(next_video_tracks), *next_audio_tracks])
        ]

        story_assigned = False
        for track in next_tracks:
            if track.kind != TimelineTrackKind.audio:
                continue
            if track.role == AudioTrackRole.story and not story_assigned:
                story_assigned = True
                continue
            if track.role == AudioTrackRole.story:
                track.role = AudioTrackRole.support
        if not story_assigned:
            first_audio = next(
                (track for track in next_tracks if track.kind == TimelineTrackKind.audio),
                None,
            )
            if first_audio:
                first_audio.role = AudioTrackRole.story

        host_track = self.subtitle_track(
            updated.model_copy(update={"tracks": next_tracks}, deep=True)
        )
        host_track_id = host_track.id
        next_captions = updated.captions
        if host_track_id:
            legacy_track_id = legacy_caption_track.id if legacy_caption_track else None
            next_captions = [
                caption.model_copy(
                    update={"track_id": host_track_id},
                    deep=True,
                )
                if caption.track_id in {CAPTION_TRACK_ID, legacy_track_id}
                else caption
                for caption in updated.captions
            ]

        next_selection = updated.selection.model_copy(deep=True)
        if next_selection.track_id in {
            CAPTION_TRACK_ID,
            legacy_caption_track.id if legacy_caption_track else None,
        }:
            next_selection.track_id = host_track_id

        changed = (
            updated.tracks != next_tracks
            or updated.captions != next_captions
            or updated.selection != next_selection
        )
        updated.tracks = next_tracks
        updated.captions = next_captions
        updated.selection = next_selection
        return updated, changed

    def _normalize_linked_clip_groups(
        self, project: EditorialProject
    ) -> tuple[EditorialProject, bool]:
        updated = project.model_copy(deep=True)
        tracks = {track.id: track for track in updated.tracks}
        buckets: dict[tuple[str, float, float, float], list[TimelineClip]] = {}
        for clip in updated.clips:
            track = tracks.get(clip.track_id)
            if not track or track.kind not in {TimelineTrackKind.video, TimelineTrackKind.audio}:
                continue
            key = (
                clip.asset_id,
                round(clip.start, 4),
                round(clip.source_in, 4),
                round(clip.source_out, 4),
            )
            buckets.setdefault(key, []).append(clip)

        changed = False
        for clips in buckets.values():
            if len(clips) != 2:
                continue
            kinds = {tracks[clip.track_id].kind for clip in clips if clip.track_id in tracks}
            if kinds != {TimelineTrackKind.video, TimelineTrackKind.audio}:
                continue
            linked_group_id = next(
                (clip.linked_group_id for clip in clips if clip.linked_group_id),
                f"link_{uuid4().hex[:8]}",
            )
            for clip in clips:
                if clip.linked_group_id == linked_group_id:
                    continue
                clip.linked_group_id = linked_group_id
                changed = True

        return updated, changed

    def _hydrate_legacy_captions(
        self, workspace: JobWorkspace, project: EditorialProject
    ) -> EditorialProject:
        legacy = workspace.artifact_path("07_caption_display.json")
        if not legacy.exists() or project.captions:
            return project

        payload = json.loads(legacy.read_text(encoding="utf-8"))
        track = self.subtitle_track(project)
        captions = list(project.captions)
        for index, chunk in enumerate(payload.get("chunks", [])):
            captions.append(
                SubtitleBlock(
                    id=f"legacy_caption_{index:04d}",
                    track_id=track.id,
                    source_lane_id="legacy",
                    start=float(chunk.get("start", 0.0)),
                    end=float(chunk.get("end", 0.0)),
                    text=" ".join(chunk.get("display_words", [])),
                    origin=ClipOrigin.generated,
                )
            )
        return project.model_copy(update={"captions": captions}, deep=True)

    def _asset_from_media(
        self,
        workspace: JobWorkspace,
        target: Path,
        *,
        label: str,
        origin: str = "library",
    ) -> ProjectAsset:
        try:
            probe = self.ffmpeg.probe_media(target)
            kind = ProjectAssetKind.video if probe.width or probe.height else ProjectAssetKind.audio
            return ProjectAsset(
                id=f"asset_{uuid4().hex[:10]}",
                origin=origin,
                kind=kind,
                label=label,
                path=workspace.relative(target),
                duration=probe.duration_seconds,
                width=probe.width,
                height=probe.height,
                fps=probe.fps,
                sample_rate=probe.sample_rate,
                has_audio=probe.has_audio,
            )
        except FFmpegError:
            suffix = target.suffix.lower()
            kind = ProjectAssetKind.audio if suffix in {".wav", ".mp3", ".m4a", ".aac"} else ProjectAssetKind.video
            logger.warning("editorial_project.asset_probe_fallback path=%s", target)
            return ProjectAsset(
                id=f"asset_{uuid4().hex[:10]}",
                origin=origin,
                kind=kind,
                label=label,
                path=workspace.relative(target),
                has_audio=kind == ProjectAssetKind.audio,
            )

    def _replace_generated_subtitle_blocks(
        self,
        project: EditorialProject,
        lane_id: str,
        transcript: TranscriptArtifact,
    ) -> None:
        subtitle_track = self.subtitle_track(project)
        captions = [
            caption
            for caption in project.captions
            if not (
                caption.source_lane_id == lane_id
                and caption.origin == ClipOrigin.generated
            )
        ]
        for segment_index, segment in enumerate(transcript.segments):
            if segment.words:
                for word_index, word in enumerate(segment.words):
                    captions.append(
                        SubtitleBlock(
                            id=f"subtitle_{lane_id}_{segment_index:04d}_{word_index:04d}",
                            track_id=subtitle_track.id,
                            source_lane_id=lane_id,
                            start=word.start,
                            end=max(word.end, word.start + 0.02),
                            text=word.text,
                            origin=ClipOrigin.generated,
                            source_word_refs=[
                                SourceWordRef(segment_id=segment.id, word_index=word_index)
                            ],
                        )
                    )
                continue
            captions.append(
                SubtitleBlock(
                    id=f"subtitle_{lane_id}_{segment_index:04d}",
                    track_id=subtitle_track.id,
                    source_lane_id=lane_id,
                    start=segment.start,
                    end=max(segment.end, segment.start + 0.02),
                    text=segment.text,
                    origin=ClipOrigin.generated,
                    source_word_refs=[],
                )
            )
        project.captions = captions

    def _normalize_generated_subtitles(
        self, project: EditorialProject
    ) -> tuple[EditorialProject, bool]:
        updated = project.model_copy(deep=True)
        changed = False
        for lane in updated.lane_transcriptions:
            total_words = sum(len(segment.words) for segment in lane.segments if segment.words)
            if total_words <= 0:
                continue
            generated = [
                caption
                for caption in updated.captions
                if caption.source_lane_id == lane.lane_id and caption.origin == ClipOrigin.generated
            ]
            is_word_level = (
                len(generated) == total_words
                and all(len(caption.source_word_refs) == 1 for caption in generated)
            )
            if is_word_level:
                continue
            self._replace_generated_subtitle_blocks(
                updated,
                lane.lane_id,
                TranscriptArtifact(
                    language=lane.language,
                    source=f"lane:{lane.lane_id}",
                    segments=lane.segments,
                ),
            )
            changed = True
        return updated, changed

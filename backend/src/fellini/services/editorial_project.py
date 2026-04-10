from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from fellini.adapters.ffmpeg import FFmpegAdapter, FFmpegError
from fellini.domain.models import (
    AssetTranscription,
    AssetTranscriptionWord,
    AudioTrackRole,
    ClipTranscriptionOptions,
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
        payload = self._migrate_legacy_clip_asset_variants(payload)
        return EditorialProject.model_validate(payload)

    def normalize_project(self, project: EditorialProject) -> EditorialProject:
        normalized, _ = self._normalize_linked_clip_groups(project)
        normalized, _ = self._normalize_track_layout(normalized)
        normalized, _ = self._normalize_generated_subtitles(normalized)
        return normalized

    def save(self, workspace: JobWorkspace, project: EditorialProject) -> EditorialProject:
        project = self.normalize_project(project)
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
        serialized = self._strip_runtime_asset_fields(project)
        workspace.project_dir.mkdir(parents=True, exist_ok=True)
        workspace.editorial_project_path.write_text(
            serialized.model_dump_json(indent=2),
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

    def _strip_runtime_asset_fields(self, project: EditorialProject) -> EditorialProject:
        stripped = project.model_copy(deep=True)
        for asset in stripped.assets:
            asset.preview = None
        return stripped

    def _migrate_legacy_clip_asset_variants(self, payload: dict) -> dict:
        assets = payload.get("assets")
        clips = payload.get("clips")
        tracks = payload.get("tracks")
        if not isinstance(assets, list) or not isinstance(clips, list):
            return payload

        tracks_by_id = {
            track.get("id"): track
            for track in tracks or []
            if isinstance(track, dict) and isinstance(track.get("id"), str)
        }
        assets_by_id = {
            asset.get("id"): asset
            for asset in assets
            if isinstance(asset, dict) and isinstance(asset.get("id"), str)
        }

        for asset in assets_by_id.values():
            background = asset.get("background_removal")
            if not isinstance(background, dict):
                continue
            original_path = background.get("original_path")
            if isinstance(original_path, str) and original_path:
                asset["path"] = original_path

        for clip in clips:
            if not isinstance(clip, dict) or "asset_variant" in clip:
                continue
            track = tracks_by_id.get(clip.get("track_id"))
            if not isinstance(track, dict) or track.get("kind") != "video":
                clip["asset_variant"] = "original"
                continue
            asset = assets_by_id.get(clip.get("asset_id"))
            background = asset.get("background_removal") if isinstance(asset, dict) else None
            if (
                isinstance(background, dict)
                and background.get("cutout_path")
                and background.get("active_variant") == "cutout"
            ):
                clip["asset_variant"] = "cutout"
            else:
                clip["asset_variant"] = "original"
        return payload

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

    def recover_interrupted_runtime_state(
        self,
        workspace: JobWorkspace,
        message: str,
    ) -> bool:
        if not self.exists(workspace):
            return False

        project = self.load(workspace)
        changed = False
        for lane in project.lane_transcriptions:
            if lane.status != LaneTranscriptionStatus.running:
                continue
            lane.status = LaneTranscriptionStatus.failed
            lane.error = message
            lane.updated_at = utcnow()
            changed = True

        for clip in project.clips:
            if clip.transcription_status != LaneTranscriptionStatus.running:
                continue
            clip.transcription_status = LaneTranscriptionStatus.failed
            clip.transcription_message = None
            clip.transcription_error = message
            clip.transcription_updated_at = utcnow()
            changed = True

        if changed:
            self.save(workspace, project)
        return changed

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
            linked_normalized, linked_migrated = self._normalize_linked_clip_groups(project)
            track_normalized, tracks_migrated = self._normalize_track_layout(linked_normalized)
            hydrated = self._hydrate_legacy_captions(workspace, track_normalized)
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
                or len(hydrated.asset_transcriptions) != len(project.asset_transcriptions)
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
        self._merge_asset_transcriptions_from_lane(
            project,
            lane_id,
            transcript,
            source_audio_path=source_audio_path,
        )
        project, _ = self._normalize_generated_subtitles(project)
        return self.save(workspace, project)

    def set_clip_transcription_running(
        self,
        workspace: JobWorkspace,
        *,
        project: EditorialProject,
        clip_id: str,
        options: ClipTranscriptionOptions | None = None,
    ) -> EditorialProject:
        updated = project.model_copy(deep=True)
        clip = next((item for item in updated.clips if item.id == clip_id), None)
        if clip is None:
            msg = f"Clip {clip_id} was not found."
            raise ValueError(msg)
        if options is not None:
            clip.transcription_options = options
        clip.transcription_status = LaneTranscriptionStatus.running
        clip.transcription_message = "Trascrizione in corso"
        clip.transcription_source_audio_path = None
        clip.transcription_updated_at = utcnow()
        clip.transcription_error = None
        return self.save(workspace, updated)

    def set_clip_transcription_failed(
        self,
        workspace: JobWorkspace,
        *,
        project: EditorialProject,
        clip_id: str,
        error: str,
    ) -> EditorialProject:
        updated = project.model_copy(deep=True)
        clip = next((item for item in updated.clips if item.id == clip_id), None)
        if clip is None:
            msg = f"Clip {clip_id} was not found."
            raise ValueError(msg)
        clip.transcription_status = LaneTranscriptionStatus.failed
        clip.transcription_message = None
        clip.transcription_updated_at = utcnow()
        clip.transcription_error = error
        return self.save(workspace, updated)

    def set_clip_transcription(
        self,
        workspace: JobWorkspace,
        *,
        project: EditorialProject,
        clip_id: str,
        transcript: TranscriptArtifact,
        source_audio_path: str,
        message: str | None = None,
    ) -> EditorialProject:
        updated = project.model_copy(deep=True)
        clip = next((item for item in updated.clips if item.id == clip_id), None)
        if clip is None:
            msg = f"Clip {clip_id} was not found."
            raise ValueError(msg)

        self._merge_asset_transcription_for_clip(
            updated,
            clip,
            transcript,
            source_audio_path=source_audio_path,
        )
        clip.transcription_status = LaneTranscriptionStatus.completed
        clip.transcription_message = message
        clip.transcription_source_audio_path = source_audio_path
        clip.transcription_updated_at = utcnow()
        clip.transcription_error = None
        updated, _ = self._normalize_generated_subtitles(updated)
        return self.save(workspace, updated)

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

    def asset_by_id(self, project: EditorialProject, asset_id: str) -> ProjectAsset | None:
        return next((asset for asset in project.assets if asset.id == asset_id), None)

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

    def _clip_contains_time(self, clip: TimelineClip, time: float) -> bool:
        return clip.start <= time <= clip.end

    def _clip_intersects_range(self, clip: TimelineClip, start: float, end: float) -> bool:
        return clip.start < end and clip.end > start

    def _clip_for_lane_range(
        self,
        lane_clips: list[TimelineClip],
        start: float,
        end: float,
    ) -> TimelineClip | None:
        midpoint = start + ((end - start) / 2)
        return next(
            (
                clip
                for clip in lane_clips
                if self._clip_contains_time(clip, midpoint)
            ),
            next(
                (
                    clip
                    for clip in lane_clips
                    if self._clip_intersects_range(clip, start, end)
                ),
                None,
            ),
        )

    def _asset_word_id(self, asset_id: str, start: float, end: float, text: str) -> str:
        start_ms = round(max(0.0, start) * 1000)
        end_ms = round(max(start, end) * 1000)
        slug = "".join(char.lower() for char in text if char.isalnum())[:24] or "word"
        return f"asset_word_{asset_id}_{start_ms:08d}_{end_ms:08d}_{slug}"

    def _asset_word_from_lane_range(
        self,
        clip: TimelineClip,
        *,
        text: str,
        start: float,
        end: float,
        source_word_refs: list[SourceWordRef],
    ) -> AssetTranscriptionWord:
        asset_start = max(0.0, clip.source_in + (start - clip.start))
        asset_end = max(asset_start + 0.02, clip.source_in + (end - clip.start))
        return AssetTranscriptionWord(
            id=self._asset_word_id(clip.asset_id, asset_start, asset_end, text),
            start=asset_start,
            end=asset_end,
            text=text,
            source_word_refs=source_word_refs,
        )

    def _asset_word_from_clip_range(
        self,
        clip: TimelineClip,
        *,
        text: str,
        start: float,
        end: float,
        source_word_refs: list[SourceWordRef],
    ) -> AssetTranscriptionWord:
        asset_start = max(0.0, clip.source_in + max(0.0, start))
        clip_asset_end = max(clip.source_in + 0.02, clip.source_out)
        asset_start = min(asset_start, max(clip.source_in, clip_asset_end - 0.02))
        asset_end = max(asset_start + 0.02, clip.source_in + max(start + 0.02, end))
        asset_end = min(asset_end, clip_asset_end)
        asset_end = max(asset_end, min(clip_asset_end, asset_start + 0.02))
        return AssetTranscriptionWord(
            id=self._asset_word_id(clip.asset_id, asset_start, asset_end, text),
            start=asset_start,
            end=asset_end,
            text=text,
            source_word_refs=source_word_refs,
        )

    def _ranges_intersect(
        self,
        left_start: float,
        left_end: float,
        right_start: float,
        right_end: float,
    ) -> bool:
        return left_start < right_end and left_end > right_start

    def _fallback_asset_for_lane_transcription(
        self,
        project: EditorialProject,
    ) -> ProjectAsset | None:
        return next(
            (
                asset
                for asset in project.assets
                if asset.has_audio
            ),
            None,
        )

    def _merge_asset_transcriptions_from_lane(
        self,
        project: EditorialProject,
        lane_id: str,
        transcript: TranscriptArtifact,
        *,
        source_audio_path: str | None,
    ) -> bool:
        lane_clips = self.track_clips(project, lane_id)
        fallback_asset = self._fallback_asset_for_lane_transcription(project) if not lane_clips else None
        if not lane_clips and fallback_asset is None:
            return False

        next_words_by_asset: dict[str, dict[str, AssetTranscriptionWord]] = {}
        touched_ranges_by_asset: dict[str, list[tuple[float, float]]] = {}

        for segment_index, segment in enumerate(transcript.segments):
            if segment.words:
                for word_index, word in enumerate(segment.words):
                    word_end = max(word.end, word.start + 0.02)
                    owner_clip = self._clip_for_lane_range(lane_clips, word.start, word_end)
                    if owner_clip is None and fallback_asset is not None:
                        asset_word = AssetTranscriptionWord(
                            id=self._asset_word_id(fallback_asset.id, word.start, word_end, word.text),
                            start=word.start,
                            end=word_end,
                            text=word.text,
                            source_word_refs=[SourceWordRef(segment_id=segment.id, word_index=word_index)],
                        )
                        next_words_by_asset.setdefault(fallback_asset.id, {})[asset_word.id] = asset_word
                        touched_ranges_by_asset.setdefault(fallback_asset.id, []).append(
                            (asset_word.start, asset_word.end)
                        )
                        continue
                    if owner_clip is None:
                        continue
                    asset_word = self._asset_word_from_lane_range(
                        owner_clip,
                        text=word.text,
                        start=word.start,
                        end=word_end,
                        source_word_refs=[SourceWordRef(segment_id=segment.id, word_index=word_index)],
                    )
                    next_words_by_asset.setdefault(owner_clip.asset_id, {})[asset_word.id] = asset_word
                    touched_ranges_by_asset.setdefault(owner_clip.asset_id, []).append(
                        (asset_word.start, asset_word.end)
                    )
                continue

            segment_end = max(segment.end, segment.start + 0.02)
            owner_clip = self._clip_for_lane_range(lane_clips, segment.start, segment_end)
            if owner_clip is None and fallback_asset is not None:
                asset_word = AssetTranscriptionWord(
                    id=self._asset_word_id(fallback_asset.id, segment.start, segment_end, segment.text),
                    start=segment.start,
                    end=segment_end,
                    text=segment.text,
                    source_word_refs=[SourceWordRef(segment_id=segment.id, word_index=0)],
                )
                next_words_by_asset.setdefault(fallback_asset.id, {})[asset_word.id] = asset_word
                touched_ranges_by_asset.setdefault(fallback_asset.id, []).append(
                    (asset_word.start, asset_word.end)
                )
                continue
            if owner_clip is None:
                continue
            asset_word = self._asset_word_from_lane_range(
                owner_clip,
                text=segment.text,
                start=segment.start,
                end=segment_end,
                source_word_refs=[SourceWordRef(segment_id=segment.id, word_index=0)],
            )
            next_words_by_asset.setdefault(owner_clip.asset_id, {})[asset_word.id] = asset_word
            touched_ranges_by_asset.setdefault(owner_clip.asset_id, []).append(
                (asset_word.start, asset_word.end)
            )

        if not next_words_by_asset:
            return False

        changed = False
        existing_by_asset = {item.asset_id: item for item in project.asset_transcriptions}
        updated_asset_transcriptions: list[AssetTranscription] = []
        processed_assets = set(next_words_by_asset)
        for item in project.asset_transcriptions:
            if item.asset_id not in processed_assets:
                updated_asset_transcriptions.append(item)
                continue

            ranges = touched_ranges_by_asset[item.asset_id]
            preserved = [
                word
                for word in item.words
                if not any(
                    self._ranges_intersect(word.start, word.end, range_start, range_end)
                    for range_start, range_end in ranges
                )
            ]
            merged_words = sorted(
                [*preserved, *next_words_by_asset[item.asset_id].values()],
                key=lambda word: (word.start, word.end, word.text, word.id),
            )
            updated_asset_transcriptions.append(
                item.model_copy(
                    update={
                        "language": transcript.language,
                        "words": merged_words,
                        "source_lane_id": lane_id,
                        "source_audio_path": source_audio_path,
                        "updated_at": utcnow(),
                        "error": None,
                    },
                    deep=True,
                )
            )
            if item.words != merged_words or item.source_lane_id != lane_id:
                changed = True

        for asset_id, words in next_words_by_asset.items():
            if asset_id in existing_by_asset:
                continue
            updated_asset_transcriptions.append(
                AssetTranscription(
                    asset_id=asset_id,
                    language=transcript.language,
                    words=sorted(words.values(), key=lambda word: (word.start, word.end, word.text, word.id)),
                    source_lane_id=lane_id,
                    source_audio_path=source_audio_path,
                    error=None,
                )
            )
            changed = True

        if not changed:
            # Asset may still need transcript_ref hydration even when words were identical.
            for asset in project.assets:
                if asset.id in next_words_by_asset and asset.transcript_ref != asset.id:
                    asset.transcript_ref = asset.id
                    changed = True
            if changed:
                project.asset_transcriptions = updated_asset_transcriptions
            return changed

        project.asset_transcriptions = updated_asset_transcriptions
        for asset in project.assets:
            if asset.id in next_words_by_asset:
                asset.transcript_ref = asset.id
        return True

    def _merge_asset_transcription_for_clip(
        self,
        project: EditorialProject,
        clip: TimelineClip,
        transcript: TranscriptArtifact,
        *,
        source_audio_path: str | None,
    ) -> None:
        touched_start = clip.source_in
        touched_end = max(clip.source_in + 0.02, clip.source_out)
        next_words: dict[str, AssetTranscriptionWord] = {}

        for segment_index, segment in enumerate(transcript.segments):
            if segment.words:
                for word_index, word in enumerate(segment.words):
                    asset_word = self._asset_word_from_clip_range(
                        clip,
                        text=word.text,
                        start=word.start,
                        end=max(word.end, word.start + 0.02),
                        source_word_refs=[SourceWordRef(segment_id=segment.id, word_index=word_index)],
                    )
                    next_words[asset_word.id] = asset_word
                continue

            asset_word = self._asset_word_from_clip_range(
                clip,
                text=segment.text,
                start=segment.start,
                end=max(segment.end, segment.start + 0.02),
                source_word_refs=[SourceWordRef(segment_id=segment.id, word_index=segment_index)],
            )
            next_words[asset_word.id] = asset_word

        updated_asset_transcriptions: list[AssetTranscription] = []
        asset_entry_written = False
        for item in project.asset_transcriptions:
            if item.asset_id != clip.asset_id:
                updated_asset_transcriptions.append(item)
                continue

            preserved = [
                word
                for word in item.words
                if not self._ranges_intersect(word.start, word.end, touched_start, touched_end)
            ]
            merged_words = sorted(
                [*preserved, *next_words.values()],
                key=lambda word: (word.start, word.end, word.text, word.id),
            )
            if merged_words:
                updated_asset_transcriptions.append(
                    item.model_copy(
                        update={
                            "language": transcript.language,
                            "words": merged_words,
                            "source_lane_id": clip.track_id,
                            "source_audio_path": source_audio_path,
                            "updated_at": utcnow(),
                            "error": None,
                        },
                        deep=True,
                    )
                )
                asset_entry_written = True
            continue

        if next_words and not asset_entry_written:
            updated_asset_transcriptions.append(
                AssetTranscription(
                    asset_id=clip.asset_id,
                    language=transcript.language,
                    words=sorted(next_words.values(), key=lambda word: (word.start, word.end, word.text, word.id)),
                    source_lane_id=clip.track_id,
                    source_audio_path=source_audio_path,
                    error=None,
                )
            )

        project.asset_transcriptions = updated_asset_transcriptions
        for asset in project.assets:
            if asset.id != clip.asset_id:
                continue
            asset.transcript_ref = asset.id if any(
                item.asset_id == clip.asset_id and item.words for item in updated_asset_transcriptions
            ) else None
            break

    def _materialized_generated_subtitle_blocks(
        self,
        project: EditorialProject,
    ) -> list[SubtitleBlock]:
        subtitle_track = self.subtitle_track(project)
        asset_words_by_asset = {
            item.asset_id: item.words
            for item in project.asset_transcriptions
            if item.words
        }
        captions: list[SubtitleBlock] = []
        materialized_assets: set[str] = set()
        audio_clips = sorted(
            (
                clip
                for clip in project.clips
                if clip.enabled
                and clip.captions_enabled
                and (track := next((item for item in project.tracks if item.id == clip.track_id), None))
                and track.kind == TimelineTrackKind.audio
            ),
            key=lambda clip: (clip.start, clip.id),
        )
        for clip in audio_clips:
            materialized_assets.add(clip.asset_id)
            for word in asset_words_by_asset.get(clip.asset_id, []):
                if word.end <= clip.source_in or word.start >= clip.source_out:
                    continue
                visible_start = max(word.start, clip.source_in)
                visible_end = min(word.end, clip.source_out)
                start = clip.start + (visible_start - clip.source_in)
                end = clip.start + (visible_end - clip.source_in)
                captions.append(
                    SubtitleBlock(
                        id=f"subtitle_{clip.id}_{word.id}",
                        track_id=subtitle_track.id,
                        source_lane_id=clip.track_id,
                        source_clip_id=clip.id,
                        source_asset_id=clip.asset_id,
                        source_asset_start=word.start,
                        source_asset_end=word.end,
                        start=start,
                        end=max(start + 0.02, end),
                        text=word.text,
                        origin=ClipOrigin.generated,
                        source_word_refs=list(word.source_word_refs),
                    )
                )
        fallback_lane_id = next(
            (track.id for track in sorted(project.tracks, key=lambda item: item.order) if track.kind == TimelineTrackKind.audio),
            subtitle_track.id,
        )
        for transcription in project.asset_transcriptions:
            if transcription.asset_id in materialized_assets:
                continue
            for word in transcription.words:
                captions.append(
                    SubtitleBlock(
                        id=f"subtitle_standalone_{transcription.asset_id}_{word.id}",
                        track_id=subtitle_track.id,
                        source_lane_id=transcription.source_lane_id or fallback_lane_id,
                        source_clip_id=None,
                        source_asset_id=transcription.asset_id,
                        source_asset_start=word.start,
                        source_asset_end=word.end,
                        start=word.start,
                        end=max(word.start + 0.02, word.end),
                        text=word.text,
                        origin=ClipOrigin.generated,
                        source_word_refs=list(word.source_word_refs),
                    )
                )
        return captions

    def _normalize_generated_subtitles(
        self, project: EditorialProject
    ) -> tuple[EditorialProject, bool]:
        updated = project.model_copy(deep=True)
        changed = False
        has_structural_generated = bool(updated.asset_transcriptions) or any(
            caption.origin == ClipOrigin.generated and caption.source_asset_id
            for caption in updated.captions
        )
        if not has_structural_generated:
            for lane in updated.lane_transcriptions:
                if not lane.segments:
                    continue
                if self._merge_asset_transcriptions_from_lane(
                    updated,
                    lane.lane_id,
                    TranscriptArtifact(
                        language=lane.language,
                        source=f"lane:{lane.lane_id}",
                        segments=lane.segments,
                    ),
                    source_audio_path=lane.source_audio_path,
                ):
                    changed = True

        materialized = self._materialized_generated_subtitle_blocks(updated)
        manual = [caption for caption in updated.captions if caption.origin != ClipOrigin.generated]
        legacy_generated = [
            caption
            for caption in updated.captions
            if caption.origin == ClipOrigin.generated and not caption.source_asset_id
        ]
        next_captions = [
            *manual,
            *(legacy_generated if not updated.asset_transcriptions else []),
            *sorted(materialized, key=lambda caption: (caption.start, caption.end, caption.id)),
        ]
        if updated.captions != next_captions:
            updated.captions = next_captions
            changed = True
        return updated, changed

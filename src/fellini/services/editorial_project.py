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
            hydrated = self._hydrate_legacy_captions(workspace, project)
            if linked_migrated or len(hydrated.captions) != len(project.captions):
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
        asset = self._asset_from_media(workspace, target, label=Path(original_name).stem)
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
        match = next(
            (track for track in project.tracks if track.kind == TimelineTrackKind.subtitle),
            None,
        )
        if not match:
            msg = "Editorial project is missing the subtitle track."
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
            TimelineTrack(
                id="track_video_1",
                kind=TimelineTrackKind.video,
                name="Video 1",
                order=0,
                auto_generated=True,
            ),
            TimelineTrack(
                id="track_audio_1",
                kind=TimelineTrackKind.audio,
                name="Audio 1",
                order=1,
                auto_generated=True,
                role=AudioTrackRole.story,
            ),
            TimelineTrack(
                id="track_subtitle_1",
                kind=TimelineTrackKind.subtitle,
                name="Subtitles",
                order=2,
                auto_generated=True,
            ),
        ]

        if state.mezzanine_path and Path(state.mezzanine_path).exists():
            source_asset = self._asset_from_media(
                context.workspace,
                Path(state.mezzanine_path),
                label="Source",
                origin="ingest",
            )
            project.assets.append(source_asset)

        return self._hydrate_legacy_captions(context.workspace, project)

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
            refs = [
                SourceWordRef(segment_id=segment.id, word_index=word_index)
                for word_index, _word in enumerate(segment.words)
            ]
            captions.append(
                SubtitleBlock(
                    id=f"subtitle_{lane_id}_{segment_index:04d}",
                    track_id=subtitle_track.id,
                    source_lane_id=lane_id,
                    start=segment.start,
                    end=segment.end,
                    text=segment.text,
                    origin=ClipOrigin.generated,
                    source_word_refs=refs,
                )
            )
        project.captions = captions

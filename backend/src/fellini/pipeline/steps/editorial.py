from __future__ import annotations

from uuid import uuid4

from fellini.domain.models import (
    ClipOrigin,
    StepName,
    TimelineClip,
    TimelineTrackKind,
    TranscriptArtifact,
)
from fellini.log import get_logger
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep

logger = get_logger(__name__)


class EditorialStep(PipelineStep):
    name = StepName.editorial
    description = "Label spans, build EDL and subtitle payloads."

    def run(self, context: PipelineContext) -> list[str]:
        project = context.editorial_projects.ensure(context)
        story_lane = context.editorial_projects.story_lane(project)
        lane_transcription = (
            context.editorial_projects.story_lane_transcription(project) if story_lane else None
        )
        transcript = (
            TranscriptArtifact(
                language=lane_transcription.language,
                segments=lane_transcription.segments,
                source=f"lane:{lane_transcription.lane_id}",
            )
            if lane_transcription
            else context.state.aligned_transcript
            or context.state.raw_transcript
            or context.transcriber._empty_transcript(
                context.request.language,
                "empty",
            )
        )
        logger.info(
            "step.editorial.start transcript_source=%s transcript_segments=%s duration=%.3f llm_refine=%s",
            transcript.source,
            len(transcript.segments),
            context.state.duration_seconds,
            context.request.toggles.use_local_llm,
        )
        context.report_progress(self.name, 10, "Analisi del transcript")
        bundle = context.decision_engine.build_editorial_bundle(
            transcript,
            context.state.duration_seconds,
            "source_mezzanine.mp4",
            context.request.subtitle,
            context.request.decision,
        )
        context.report_progress(
            self.name,
            40,
            "Refine degli span con LLM" if context.request.toggles.use_local_llm else "Etichettatura degli span",
        )
        spans = context.llm_refiner.refine(
            bundle.spans,
            enabled=context.request.toggles.use_local_llm,
            model_name=context.request.decision.local_model_name,
        )
        context.state.labeled_spans = spans
        context.report_progress(self.name, 65, "Costruzione EDL e captions")
        context.state.edl = context.decision_engine.build_edl(
            spans,
            context.state.duration_seconds,
            "source_mezzanine.mp4",
            context.request.decision,
        )
        context.state.captions = context.decision_engine.build_captions(
            spans, context.request.subtitle
        )
        context.state.render_plan = bundle.render_plan

        context.report_progress(self.name, 90, "Salvataggio artefatti editorial")
        source_asset = next((asset for asset in project.assets if asset.origin == "ingest"), None)
        if source_asset and story_lane:
            primary_video_track = next(
                (track for track in project.tracks if track.kind == TimelineTrackKind.video),
                None,
            )
            if primary_video_track:
                preserved = []
                for clip in project.clips:
                    if clip.origin != ClipOrigin.generated:
                        preserved.append(clip)
                        continue
                    if clip.track_id not in {primary_video_track.id, story_lane.id}:
                        preserved.append(clip)
                project.clips = preserved
                cursor = 0.0
                for index, keep_range in enumerate(context.state.edl.keep_ranges):
                    duration = max(0.02, keep_range.end - keep_range.start)
                    linked_group_id = f"link_gen_{uuid4().hex[:8]}_{index:03d}"
                    project.clips.append(
                        TimelineClip(
                            id=f"clip_gen_v_{uuid4().hex[:8]}_{index:03d}",
                            asset_id=source_asset.id,
                            track_id=primary_video_track.id,
                            linked_group_id=linked_group_id,
                            start=cursor,
                            source_in=keep_range.start,
                            source_out=keep_range.end,
                            origin=ClipOrigin.generated,
                        )
                    )
                    project.clips.append(
                        TimelineClip(
                            id=f"clip_gen_a_{uuid4().hex[:8]}_{index:03d}",
                            asset_id=source_asset.id,
                            track_id=story_lane.id,
                            linked_group_id=linked_group_id,
                            start=cursor,
                            source_in=keep_range.start,
                            source_out=keep_range.end,
                            origin=ClipOrigin.generated,
                        )
                    )
                    cursor += duration
                project = context.editorial_projects.save(context.workspace, project)
        spans_artifact = context.save_json_artifact(
            "05_spans_labeled.json",
            {"spans": [span.model_dump(mode="json") for span in spans]},
        )
        edl_artifact = context.save_json_artifact("06_edit_decision_list.json", context.state.edl)
        captions_artifact = context.save_json_artifact(
            "07_caption_display.json", context.state.captions
        )
        plan_artifact = context.save_json_artifact("09_render_plan.json", context.state.render_plan)
        context.report_progress(self.name, 100, "Editorial completato")
        logger.info(
            "step.editorial.done spans=%s keep_ranges=%s captions=%s",
            len(spans),
            len(context.state.edl.keep_ranges) if context.state.edl else 0,
            len(context.state.captions.chunks) if context.state.captions else 0,
        )
        return [
            spans_artifact,
            edl_artifact,
            captions_artifact,
            plan_artifact,
            context.workspace.relative(context.workspace.editorial_project_path),
        ]

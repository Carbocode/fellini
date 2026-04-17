from __future__ import annotations

from fellini.domain.models import (
    StepName,
)
from fellini.log import get_logger
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep
from fellini.workspace_layout import (
    ARTIFACT_CAPTION_DISPLAY_FILENAME,
    ARTIFACT_EDIT_DECISION_LIST_FILENAME,
    ARTIFACT_RENDER_PLAN_FILENAME,
    ARTIFACT_SPANS_FILENAME,
    ARTIFACT_STORY_LANE_UNIFIED_TRANSCRIPT_FILENAME,
    SOURCE_MEZZANINE_FILENAME,
)

logger = get_logger(__name__)


class EditorialStep(PipelineStep):
    name = StepName.editorial
    description = "Label spans, build EDL and subtitle payloads."

    def run(self, context: PipelineContext) -> list[str]:
        project = context.editorial_projects.ensure(context)
        story_lane = context.editorial_projects.story_lane(project)
        transcript = (
            context.editorial_projects.story_lane_editorial_transcript(project)
            if story_lane
            else context.state.aligned_transcript
        ) or context.state.aligned_transcript or context.state.raw_transcript or context.transcriber._empty_transcript(
            context.request.language,
            "empty",
        )
        logger.info(
            "step.editorial.start transcript_source=%s transcript_segments=%s duration=%.3f llm_refine=%s",
            transcript.source,
            len(transcript.segments),
            context.state.duration_seconds,
            context.request.toggles.use_local_llm,
        )
        unified_transcript_artifact = context.save_json_artifact(
            ARTIFACT_STORY_LANE_UNIFIED_TRANSCRIPT_FILENAME,
            transcript,
        )
        context.report_progress(self.name, 10, "Analisi del transcript")
        bundle = context.decision_engine.build_editorial_bundle(
            transcript,
            context.state.duration_seconds,
            SOURCE_MEZZANINE_FILENAME,
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
            SOURCE_MEZZANINE_FILENAME,
            context.request.decision,
        )
        context.state.captions = context.decision_engine.build_captions(
            spans, context.request.subtitle
        )
        context.state.render_plan = bundle.render_plan

        context.report_progress(self.name, 90, "Salvataggio artefatti editorial")
        if story_lane:
            project = context.editorial_projects.clear_generated_clips(project)
            project = context.editorial_projects.replace_editorial_result_captions(
                project,
                story_lane_id=story_lane.id,
                spans=context.state.labeled_spans,
            )
        if story_lane:
            project = context.editorial_projects.save(context.workspace, project)
        spans_artifact = context.save_json_artifact(
            ARTIFACT_SPANS_FILENAME,
            {"spans": [span.model_dump(mode="json") for span in spans]},
        )
        edl_artifact = context.save_json_artifact(ARTIFACT_EDIT_DECISION_LIST_FILENAME, context.state.edl)
        captions_artifact = context.save_json_artifact(
            ARTIFACT_CAPTION_DISPLAY_FILENAME, context.state.captions
        )
        plan_artifact = context.save_json_artifact(ARTIFACT_RENDER_PLAN_FILENAME, context.state.render_plan)
        context.report_progress(self.name, 100, "Editorial completato")
        logger.info(
            "step.editorial.done spans=%s keep_ranges=%s captions=%s",
            len(spans),
            len(context.state.edl.keep_ranges) if context.state.edl else 0,
            len(context.state.captions.chunks) if context.state.captions else 0,
        )
        return [
            unified_transcript_artifact,
            spans_artifact,
            edl_artifact,
            captions_artifact,
            plan_artifact,
            context.workspace.relative(context.workspace.editorial_project_path),
        ]

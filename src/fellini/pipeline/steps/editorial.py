from __future__ import annotations

from fellini.domain.models import StepName
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep


class EditorialStep(PipelineStep):
    name = StepName.editorial
    description = "Label spans, build EDL and subtitle payloads."

    def run(self, context: PipelineContext) -> list[str]:
        transcript = (
            context.state.aligned_transcript
            or context.state.raw_transcript
            or context.transcriber._empty_transcript(
                context.request.language,
                "empty",
            )
        )
        bundle = context.decision_engine.build_editorial_bundle(
            transcript,
            context.state.duration_seconds,
            "source_mezzanine.mp4",
            context.request.subtitle,
            context.request.decision,
        )
        spans = context.llm_refiner.refine(
            bundle.spans,
            enabled=context.request.toggles.use_local_llm,
            model_name=context.request.decision.local_model_name,
        )
        context.state.labeled_spans = spans
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

        spans_artifact = context.save_json_artifact(
            "05_spans_labeled.json",
            {"spans": [span.model_dump(mode="json") for span in spans]},
        )
        edl_artifact = context.save_json_artifact("06_edit_decision_list.json", context.state.edl)
        captions_artifact = context.save_json_artifact(
            "07_caption_display.json", context.state.captions
        )
        plan_artifact = context.save_json_artifact("09_render_plan.json", context.state.render_plan)
        return [spans_artifact, edl_artifact, captions_artifact, plan_artifact]

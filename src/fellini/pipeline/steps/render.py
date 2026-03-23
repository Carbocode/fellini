from __future__ import annotations

from pathlib import Path

from fellini.domain.models import StepName
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep


class RenderStep(PipelineStep):
    name = StepName.render
    description = "Render edited master, clean output and captioned output."

    def run(self, context: PipelineContext) -> list[str]:
        if (
            not context.state.mezzanine_path
            or not context.state.edl
            or not context.state.render_plan
        ):
            msg = "Render step requires mezzanine, EDL and render plan."
            raise RuntimeError(msg)

        mezzanine = Path(context.state.mezzanine_path)
        edited_master = context.ffmpeg.render_from_edl(
            mezzanine, context.state.edl, context.workspace.output_dir
        )
        context.state.render_plan.edited_master = context.output_relative(edited_master)

        subtitles_artifact = ""
        if context.state.captions and context.request.toggles.render_captioned:
            subtitles_content = context.subtitle_builder.build(
                context.state.captions,
                context.request.subtitle,
                context.request.render.width,
                context.request.render.height,
            )
            subtitles_artifact = context.save_text_artifact("08_subtitles.ass", subtitles_content)
            context.state.render_plan.subtitles_path = subtitles_artifact

        outputs = [context.output_relative(edited_master)]
        if context.request.toggles.render_clean:
            clean_output = context.workspace.output_path("master_vertical_clean.mp4")
            context.ffmpeg.render_vertical(edited_master, clean_output, context.request.render)
            context.state.render_plan.clean_output = context.output_relative(clean_output)
            outputs.append(context.output_relative(clean_output))

        if context.request.toggles.render_captioned and subtitles_artifact:
            captioned_output = context.workspace.output_path("master_vertical_captioned.mp4")
            context.ffmpeg.render_vertical(
                edited_master,
                captioned_output,
                context.request.render,
                subtitles_path=context.workspace.resolve_relative(subtitles_artifact),
            )
            context.state.render_plan.captioned_output = context.output_relative(captioned_output)
            outputs.append(context.output_relative(captioned_output))

        artifacts = [context.save_json_artifact("09_render_plan.json", context.state.render_plan)]
        if subtitles_artifact:
            artifacts.append(subtitles_artifact)
        return outputs + artifacts

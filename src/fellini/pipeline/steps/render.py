from __future__ import annotations

from fellini.domain.models import StepName
from fellini.log import get_logger
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep

logger = get_logger(__name__)


class RenderStep(PipelineStep):
    name = StepName.render
    description = "Render edited master, clean output and captioned output."

    def run(self, context: PipelineContext) -> list[str]:
        project = context.editorial_projects.ensure(context)
        if not any(clip.enabled for clip in project.clips):
            msg = "Render step requires at least one enabled timeline clip."
            raise RuntimeError(msg)

        logger.info(
            "step.render.start timeline_clips=%s render_clean=%s render_captioned=%s",
            len(project.clips),
            context.request.toggles.render_clean,
            context.request.toggles.render_captioned,
        )
        context.report_progress(self.name, 10, "Rendering del timeline master")
        edited_master = context.workspace.output_path("edited_master.mp4")
        context.ffmpeg.render_project_master(
            workspace_root=context.workspace.job_dir,
            project=project,
            render_config=context.request.render,
            target=edited_master,
        )
        context.state.render_plan.edited_master = context.output_relative(edited_master)

        outputs = [context.output_relative(edited_master)]
        if context.request.toggles.render_clean:
            context.report_progress(self.name, 60, "Rendering output clean")
            clean_output = context.workspace.output_path("master_vertical_clean.mp4")
            if clean_output != edited_master:
                context.ffmpeg.render_vertical(edited_master, clean_output, context.request.render)
            context.state.render_plan.clean_output = context.output_relative(clean_output)
            outputs.append(context.output_relative(clean_output))

        context.state.render_plan.captioned_output = None
        context.state.render_plan.subtitles_path = None
        artifacts = [
            context.save_json_artifact("09_render_plan.json", context.state.render_plan),
            context.workspace.relative(context.workspace.editorial_project_path),
        ]
        context.report_progress(self.name, 100, "Render completato")
        logger.info("step.render.done outputs=%s artifacts=%s", outputs, artifacts)
        return outputs + artifacts

from __future__ import annotations

from fellini.domain.models import RenderPlan, StepName
from fellini.log import get_logger
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep
from fellini.workspace_layout import ARTIFACT_RENDER_PLAN_FILENAME, EDITED_MASTER_FILENAME

logger = get_logger(__name__)


class RenderStep(PipelineStep):
    name = StepName.render
    description = "Render final timeline output."

    def run(self, context: PipelineContext) -> list[str]:
        project = context.editorial_projects.ensure(context)
        if not any(clip.enabled for clip in project.clips):
            msg = "Render step requires at least one enabled timeline clip."
            raise RuntimeError(msg)
        if context.state.render_plan is None:
            context.state.render_plan = RenderPlan()

        logger.info(
            "step.render.start timeline_clips=%s",
            len(project.clips),
        )
        context.report_progress(self.name, 10, "Rendering finale della timeline")
        edited_master = context.workspace.output_path(EDITED_MASTER_FILENAME)
        context.ffmpeg.render_project_master(
            workspace_root=context.workspace.job_dir,
            project=project,
            render_config=context.request.render,
            target=edited_master,
        )
        context.state.render_plan.edited_master = context.output_relative(edited_master)
        context.state.render_plan.clean_output = None
        context.state.render_plan.captioned_output = None
        context.state.render_plan.subtitles_path = None
        outputs = [context.output_relative(edited_master)]
        artifacts = [
            context.save_json_artifact(ARTIFACT_RENDER_PLAN_FILENAME, context.state.render_plan),
            context.workspace.relative(context.workspace.editorial_project_path),
        ]
        context.report_progress(self.name, 100, "Render completato")
        logger.info("step.render.done outputs=%s artifacts=%s", outputs, artifacts)
        return outputs + artifacts

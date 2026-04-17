from __future__ import annotations

from fellini.domain.models import JobSnapshot, StepName
from fellini.log import get_logger
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.editorial import EditorialStep
from fellini.pipeline.steps.ingest import IngestStep
from fellini.pipeline.steps.render import RenderStep
from fellini.pipeline.steps.transcription import TranscriptionStep
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings

logger = get_logger(__name__)


class PipelineOrchestrator:
    def __init__(self, settings: AppSettings, store: JobStore) -> None:
        self.settings = settings
        self.store = store
        self.steps = [
            IngestStep(),
            TranscriptionStep(),
            EditorialStep(),
            RenderStep(),
        ]
        self.steps_by_name = {step.name: step for step in self.steps}

    def run(self, snapshot: JobSnapshot) -> JobSnapshot:
        return self._run(snapshot, start_at=StepName.ingest, stop_after=None)

    def run_step(self, snapshot: JobSnapshot, step_name: StepName) -> JobSnapshot:
        return self._run(snapshot, start_at=step_name, stop_after=step_name)

    def prepare_run(self, snapshot: JobSnapshot) -> JobSnapshot:
        return self._prepare(snapshot, start_at=StepName.ingest, stop_after=None)

    def prepare_step_run(self, snapshot: JobSnapshot, step_name: StepName) -> JobSnapshot:
        return self._prepare(snapshot, start_at=step_name, stop_after=step_name)

    def run_prepared(self, snapshot: JobSnapshot) -> JobSnapshot:
        return self._run(snapshot, start_at=StepName.ingest, stop_after=None, prepared=True)

    def run_step_prepared(self, snapshot: JobSnapshot, step_name: StepName) -> JobSnapshot:
        return self._run(snapshot, start_at=step_name, stop_after=step_name, prepared=True)

    def _run(
        self,
        snapshot: JobSnapshot,
        *,
        start_at: StepName,
        stop_after: StepName | None,
        prepared: bool = False,
    ) -> JobSnapshot:
        logger.info(
            "pipeline.run job_id=%s start_at=%s stop_after=%s prepared=%s",
            snapshot.id,
            start_at.value,
            stop_after.value if stop_after else None,
            prepared,
        )
        workspace = JobWorkspace(self.settings.projects_root, snapshot.id)
        context = PipelineContext(
            settings=self.settings,
            request=snapshot.request,
            workspace=workspace,
            store=self.store,
        )
        steps_to_run = self._steps_for_run(start_at, stop_after)
        logger.debug(
            "pipeline.run.steps job_id=%s steps=%s",
            snapshot.id,
            [step.name.value for step in steps_to_run],
        )
        context.load_state()
        if not prepared:
            context.prune_from_step(start_at)
            context.save_state()
            self.store.invalidate_workspace_from_step(
                snapshot.id,
                start_at,
                preserve_outputs=start_at == StepName.render,
            )
            self.store.reset_from_step(
                snapshot.id,
                start_at,
                preserve_outputs=start_at == StepName.render,
            )
            self.store.mark_running(snapshot.id)

        try:
            for index, step in enumerate(steps_to_run):
                logger.info("pipeline.step.start job_id=%s step=%s", snapshot.id, step.name.value)
                if not (prepared and index == 0):
                    self.store.begin_step(snapshot.id, step.name, step.description)
                    self.store.append_log(snapshot.id, f"{step.name}: {step.description}")
                artifacts = step.run(context)
                context.save_state()
                self.store.complete_step(
                    snapshot.id,
                    step.name,
                    message=f"{step.description} completed.",
                    artifacts=artifacts,
                )
                logger.info(
                    "pipeline.step.done job_id=%s step=%s artifacts=%s",
                    snapshot.id,
                    step.name.value,
                    artifacts,
                )

            latest = self.store.load(snapshot.id)
            if all(step.status.value == "completed" for step in latest.steps):
                logger.info("pipeline.run.completed job_id=%s status=completed", snapshot.id)
                return self.store.mark_completed(snapshot.id, self._collect_outputs(context))
            logger.info("pipeline.run.completed job_id=%s status=pending", snapshot.id)
            return self.store.mark_pending(snapshot.id)
        except Exception as exc:
            failed_step = self.store.load(snapshot.id).current_step or start_at
            logger.exception(
                "pipeline.run.failed job_id=%s step=%s error=%s",
                snapshot.id,
                failed_step.value,
                exc,
            )
            self.store.fail_step(snapshot.id, failed_step, str(exc))
            self.store.append_log(snapshot.id, f"failed: {exc}")
            return self.store.mark_failed(snapshot.id, str(exc))
        finally:
            workspace.clear_temp()

    def _prepare(
        self,
        snapshot: JobSnapshot,
        *,
        start_at: StepName,
        stop_after: StepName | None,
    ) -> JobSnapshot:
        logger.info(
            "pipeline.prepare job_id=%s start_at=%s stop_after=%s",
            snapshot.id,
            start_at.value,
            stop_after.value if stop_after else None,
        )
        workspace = JobWorkspace(self.settings.projects_root, snapshot.id)
        context = PipelineContext(
            settings=self.settings,
            request=snapshot.request,
            workspace=workspace,
            store=self.store,
        )
        context.load_state()
        context.prune_from_step(start_at)
        context.save_state()

        self.store.invalidate_workspace_from_step(
            snapshot.id,
            start_at,
            preserve_outputs=start_at == StepName.render,
        )
        self.store.reset_from_step(
            snapshot.id,
            start_at,
            preserve_outputs=start_at == StepName.render,
        )
        self.store.mark_running(snapshot.id)
        first_step = self._steps_for_run(start_at, stop_after)[0]
        self.store.begin_step(snapshot.id, first_step.name, first_step.description)
        self.store.append_log(snapshot.id, f"{first_step.name}: {first_step.description}")
        logger.info(
            "pipeline.prepare.ready job_id=%s first_step=%s",
            snapshot.id,
            first_step.name.value,
        )
        return self.store.load(snapshot.id)

    def _steps_for_run(
        self,
        start_at: StepName,
        stop_after: StepName | None,
    ) -> list:
        start_index = next(
            index for index, step in enumerate(self.steps) if step.name == start_at
        )
        if stop_after is None:
            return self.steps[start_index:]
        stop_index = next(
            index for index, step in enumerate(self.steps) if step.name == stop_after
        )
        return self.steps[start_index : stop_index + 1]

    @staticmethod
    def _collect_outputs(context: PipelineContext) -> list[str]:
        outputs: list[str] = []
        render_plan = context.state.render_plan
        if not render_plan or not render_plan.edited_master:
            return outputs

        outputs.append(render_plan.edited_master)
        return outputs

from __future__ import annotations

from fellini.domain.models import JobSnapshot, StepName
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.alignment import AlignmentStep
from fellini.pipeline.steps.editorial import EditorialStep
from fellini.pipeline.steps.ingest import IngestStep
from fellini.pipeline.steps.render import RenderStep
from fellini.pipeline.steps.transcription import TranscriptionStep
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings


class PipelineOrchestrator:
    def __init__(self, settings: AppSettings, store: JobStore) -> None:
        self.settings = settings
        self.store = store
        self.steps = [
            IngestStep(),
            TranscriptionStep(),
            AlignmentStep(),
            EditorialStep(),
            RenderStep(),
        ]
        self.steps_by_name = {step.name: step for step in self.steps}

    def run(self, snapshot: JobSnapshot) -> JobSnapshot:
        return self._run(snapshot, start_at=StepName.ingest, stop_after=None)

    def run_step(self, snapshot: JobSnapshot, step_name: StepName) -> JobSnapshot:
        return self._run(snapshot, start_at=step_name, stop_after=step_name)

    def _run(
        self,
        snapshot: JobSnapshot,
        *,
        start_at: StepName,
        stop_after: StepName | None,
    ) -> JobSnapshot:
        workspace = JobWorkspace(self.settings.jobs_root, snapshot.id)
        context = PipelineContext(
            settings=self.settings,
            request=snapshot.request,
            workspace=workspace,
            store=self.store,
        )
        context.load_state()
        context.prune_from_step(start_at)
        self.store.reset_from_step(snapshot.id, start_at)
        self.store.mark_running(snapshot.id)
        steps_to_run = self._steps_for_run(start_at, stop_after)

        try:
            for step in steps_to_run:
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

            latest = self.store.load(snapshot.id)
            if all(step.status.value == "completed" for step in latest.steps):
                return self.store.mark_completed(snapshot.id, self._collect_outputs(context))
            return self.store.mark_pending(snapshot.id)
        except Exception as exc:
            failed_step = self.store.load(snapshot.id).current_step or start_at
            self.store.fail_step(snapshot.id, failed_step, str(exc))
            self.store.append_log(snapshot.id, f"failed: {exc}")
            return self.store.mark_failed(snapshot.id, str(exc))

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
        if not render_plan:
            return outputs

        for candidate in (
            render_plan.edited_master,
            render_plan.clean_output,
            render_plan.captioned_output,
        ):
            if candidate and candidate not in outputs:
                outputs.append(candidate)
        return outputs

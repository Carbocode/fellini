from __future__ import annotations

from pathlib import Path
from threading import Thread
from uuid import uuid4

from fellini.domain.models import InputAsset, JobRequest, JobSnapshot, StepName
from fellini.log import get_logger
from fellini.pipeline.orchestrator import PipelineOrchestrator
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings

logger = get_logger(__name__)


class JobManager:
    def __init__(self, settings: AppSettings, store: JobStore | None = None) -> None:
        self.settings = settings
        self.store = store or JobStore(settings)
        self.orchestrator = PipelineOrchestrator(settings, self.store)

    def create_job(self, request: JobRequest) -> tuple[JobSnapshot, JobWorkspace]:
        logger.info(
            "job_manager.create_job title=%s language=%s",
            request.title,
            request.language,
        )
        return self.store.create_job(request)

    def save_inputs(self, workspace: JobWorkspace, input_paths: list[Path]) -> list[InputAsset]:
        assets: list[InputAsset] = []
        for index, source in enumerate(input_paths):
            suffix = source.suffix or ".bin"
            stored_name = f"{index:02d}_{uuid4().hex[:8]}{suffix}"
            target = workspace.upload_path(stored_name)
            target.write_bytes(source.read_bytes())
            assets.append(InputAsset(original_name=source.name, stored_name=stored_name))
            logger.info(
                "job_manager.save_input workspace=%s source=%s stored_name=%s",
                workspace.job_dir,
                source,
                stored_name,
            )
        return assets

    def create_from_paths(self, request: JobRequest, input_paths: list[Path]) -> JobSnapshot:
        snapshot, workspace = self.create_job(request)
        assets = self.save_inputs(workspace, input_paths)
        snapshot = snapshot.model_copy(
            update={"request": snapshot.request.model_copy(update={"input_assets": assets})}
        )
        self.store.save(snapshot, workspace)
        return snapshot

    def create_from_uploads(
        self, request: JobRequest, files: list[tuple[str, bytes]]
    ) -> JobSnapshot:
        snapshot, workspace = self.create_job(request)
        assets: list[InputAsset] = []
        for index, (original_name, payload) in enumerate(files):
            suffix = Path(original_name).suffix or ".bin"
            stored_name = f"{index:02d}_{uuid4().hex[:8]}{suffix}"
            target = workspace.upload_path(stored_name)
            target.write_bytes(payload)
            assets.append(InputAsset(original_name=original_name, stored_name=stored_name))
            logger.info(
                "job_manager.save_upload workspace=%s original_name=%s stored_name=%s size=%s",
                workspace.job_dir,
                original_name,
                stored_name,
                len(payload),
            )
        snapshot = snapshot.model_copy(
            update={"request": snapshot.request.model_copy(update={"input_assets": assets})}
        )
        self.store.save(snapshot, workspace)
        return snapshot

    def save_upload_to_workspace(
        self,
        workspace: JobWorkspace,
        *,
        original_name: str,
        payload: bytes,
    ) -> InputAsset:
        suffix = Path(original_name).suffix or ".bin"
        stored_name = f"{uuid4().hex[:8]}{suffix}"
        target = workspace.upload_path(stored_name)
        target.write_bytes(payload)
        asset = InputAsset(original_name=original_name, stored_name=stored_name)
        logger.info(
            "job_manager.save_project_upload workspace=%s original_name=%s stored_name=%s size=%s",
            workspace.job_dir,
            original_name,
            stored_name,
            len(payload),
        )
        return asset

    def start(self, job_id: str) -> JobSnapshot:
        logger.info("job_manager.start job_id=%s", job_id)
        prepared = self.orchestrator.prepare_run(self.store.load(job_id))
        thread = Thread(
            target=lambda: self.orchestrator.run_prepared(self.store.load(job_id)),
            daemon=True,
        )
        thread.start()
        logger.debug("job_manager.start.thread_started job_id=%s", job_id)
        return prepared

    def start_step(self, job_id: str, step_name: StepName) -> JobSnapshot:
        logger.info("job_manager.start_step job_id=%s step=%s", job_id, step_name.value)
        prepared = self.orchestrator.prepare_step_run(self.store.load(job_id), step_name)
        thread = Thread(
            target=lambda: self.orchestrator.run_step_prepared(
                self.store.load(job_id),
                step_name,
            ),
            daemon=True,
        )
        thread.start()
        logger.debug("job_manager.start_step.thread_started job_id=%s step=%s", job_id, step_name.value)
        return prepared

    def run_sync(self, job_id: str) -> JobSnapshot:
        logger.info("job_manager.run_sync job_id=%s", job_id)
        snapshot = self.store.load(job_id)
        return self.orchestrator.run(snapshot)

    def run_step_sync(self, job_id: str, step_name: StepName) -> JobSnapshot:
        logger.info("job_manager.run_step_sync job_id=%s step=%s", job_id, step_name.value)
        snapshot = self.store.load(job_id)
        return self.orchestrator.run_step(snapshot, step_name)

    def update_request(self, job_id: str, request: JobRequest) -> JobSnapshot:
        logger.info("job_manager.update_request job_id=%s title=%s", job_id, request.title)
        return self.store.replace_request(job_id, request)

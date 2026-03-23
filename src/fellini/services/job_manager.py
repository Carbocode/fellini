from __future__ import annotations

from pathlib import Path
from threading import Thread
from uuid import uuid4

from fellini.domain.models import InputAsset, JobRequest, JobSnapshot, StepName
from fellini.pipeline.orchestrator import PipelineOrchestrator
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings


class JobManager:
    def __init__(self, settings: AppSettings, store: JobStore | None = None) -> None:
        self.settings = settings
        self.store = store or JobStore(settings)
        self.orchestrator = PipelineOrchestrator(settings, self.store)

    def create_job(self, request: JobRequest) -> tuple[JobSnapshot, JobWorkspace]:
        return self.store.create_job(request)

    def save_inputs(self, workspace: JobWorkspace, input_paths: list[Path]) -> list[InputAsset]:
        assets: list[InputAsset] = []
        for index, source in enumerate(input_paths):
            suffix = source.suffix or ".bin"
            stored_name = f"{index:02d}_{uuid4().hex[:8]}{suffix}"
            target = workspace.upload_path(stored_name)
            target.write_bytes(source.read_bytes())
            assets.append(InputAsset(original_name=source.name, stored_name=stored_name))
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
        snapshot = snapshot.model_copy(
            update={"request": snapshot.request.model_copy(update={"input_assets": assets})}
        )
        self.store.save(snapshot, workspace)
        return snapshot

    def start(self, job_id: str) -> None:
        thread = Thread(
            target=lambda: self.orchestrator.run(self.store.load(job_id)),
            daemon=True,
        )
        thread.start()

    def start_step(self, job_id: str, step_name: StepName) -> None:
        thread = Thread(
            target=lambda: self.orchestrator.run_step(self.store.load(job_id), step_name),
            daemon=True,
        )
        thread.start()

    def run_sync(self, job_id: str) -> JobSnapshot:
        snapshot = self.store.load(job_id)
        return self.orchestrator.run(snapshot)

    def run_step_sync(self, job_id: str, step_name: StepName) -> JobSnapshot:
        snapshot = self.store.load(job_id)
        return self.orchestrator.run_step(snapshot, step_name)

    def update_request(self, job_id: str, request: JobRequest) -> JobSnapshot:
        return self.store.replace_request(job_id, request)

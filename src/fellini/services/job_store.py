from __future__ import annotations

import json
from threading import Lock
from uuid import uuid4

from fellini.domain.models import (
    JobRequest,
    JobSnapshot,
    JobStatus,
    StepName,
    StepStatus,
    default_step_snapshots,
    utcnow,
)
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings


class JobStore:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.settings.ensure_directories()
        self._lock = Lock()

    def create_job(self, request: JobRequest) -> tuple[JobSnapshot, JobWorkspace]:
        job_id = uuid4().hex[:12]
        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        workspace.bootstrap()
        snapshot = JobSnapshot(
            id=job_id,
            title=request.title,
            request=request,
            steps=default_step_snapshots(),
            workspace=str(workspace.job_dir),
        )
        self.save(snapshot, workspace)
        return snapshot, workspace

    def save(self, snapshot: JobSnapshot, workspace: JobWorkspace | None = None) -> None:
        target = (
            workspace.snapshot_path
            if workspace
            else JobWorkspace(self.settings.jobs_root, snapshot.id).snapshot_path
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")

    def load(self, job_id: str) -> JobSnapshot:
        path = JobWorkspace(self.settings.jobs_root, job_id).snapshot_path
        data = json.loads(path.read_text(encoding="utf-8"))
        return JobSnapshot.model_validate(data)

    def list_jobs(self) -> list[JobSnapshot]:
        jobs: list[JobSnapshot] = []
        for path in self.settings.jobs_root.glob("*/job.json"):
            data = json.loads(path.read_text(encoding="utf-8"))
            jobs.append(JobSnapshot.model_validate(data))
        return sorted(jobs, key=lambda item: item.updated_at, reverse=True)[
            : self.settings.recent_jobs
        ]

    def update(self, job_id: str, mutator) -> JobSnapshot:
        with self._lock:
            snapshot = self.load(job_id)
            mutator(snapshot)
            snapshot.updated_at = utcnow()
            self.save(snapshot)
            return snapshot

    def mark_running(self, job_id: str) -> JobSnapshot:
        return self.update(
            job_id,
            lambda snapshot: (
                setattr(snapshot, "status", JobStatus.running),
                setattr(snapshot, "error", None),
            ),
        )

    def mark_completed(self, job_id: str, outputs: list[str]) -> JobSnapshot:
        return self.update(
            job_id,
            lambda snapshot: (
                setattr(snapshot, "status", JobStatus.completed),
                setattr(snapshot, "current_step", None),
                setattr(snapshot, "outputs", outputs),
            ),
        )

    def mark_pending(self, job_id: str) -> JobSnapshot:
        return self.update(
            job_id,
            lambda snapshot: (
                setattr(snapshot, "status", JobStatus.pending),
                setattr(snapshot, "current_step", None),
                setattr(snapshot, "error", None),
            ),
        )

    def mark_failed(self, job_id: str, error: str) -> JobSnapshot:
        return self.update(
            job_id,
            lambda snapshot: (
                setattr(snapshot, "status", JobStatus.failed),
                setattr(snapshot, "current_step", None),
                setattr(snapshot, "error", error),
            ),
        )

    def append_log(self, job_id: str, message: str) -> JobSnapshot:
        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.logs.append(message)
            snapshot.logs = snapshot.logs[-100:]

        return self.update(job_id, mutate)

    def replace_request(self, job_id: str, request: JobRequest) -> JobSnapshot:
        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.request = request
            snapshot.title = request.title
            snapshot.error = None

        return self.update(job_id, mutate)

    def reset_from_step(self, job_id: str, step_name: StepName) -> JobSnapshot:
        start_index = next(
            index
            for index, candidate in enumerate(default_step_snapshots())
            if candidate.name == step_name
        )

        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.status = JobStatus.pending
            snapshot.current_step = None
            snapshot.error = None
            snapshot.outputs = []
            for step in snapshot.steps[start_index:]:
                step.status = StepStatus.pending
                step.message = ""
                step.started_at = None
                step.finished_at = None
                step.artifacts = []

        return self.update(job_id, mutate)

    def begin_step(self, job_id: str, step_name: StepName, message: str) -> JobSnapshot:
        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.current_step = step_name
            step = snapshot.step(step_name)
            step.status = StepStatus.running
            step.started_at = utcnow()
            step.message = message

        return self.update(job_id, mutate)

    def complete_step(
        self,
        job_id: str,
        step_name: StepName,
        message: str,
        artifacts: list[str] | None = None,
    ) -> JobSnapshot:
        def mutate(snapshot: JobSnapshot) -> None:
            step = snapshot.step(step_name)
            step.status = StepStatus.completed
            step.finished_at = utcnow()
            step.message = message
            if artifacts:
                step.artifacts = artifacts

        return self.update(job_id, mutate)

    def fail_step(self, job_id: str, step_name: StepName, message: str) -> JobSnapshot:
        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.current_step = step_name
            step = snapshot.step(step_name)
            step.status = StepStatus.failed
            step.finished_at = utcnow()
            step.message = message

        return self.update(job_id, mutate)

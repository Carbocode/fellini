from __future__ import annotations

import json
import shutil
from threading import Lock
from uuid import uuid4

from fellini.domain.models import (
    JobRequest,
    JobSnapshot,
    JobStatus,
    StepName,
    StepSnapshot,
    StepStatus,
    default_step_snapshots,
    utcnow,
)
from fellini.log import get_logger
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings

logger = get_logger(__name__)


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
        logger.info(
            "job_store.create job_id=%s title=%s workspace=%s",
            job_id,
            request.title,
            workspace.job_dir,
        )
        return snapshot, workspace

    def save(self, snapshot: JobSnapshot, workspace: JobWorkspace | None = None) -> None:
        target = (
            workspace.snapshot_path
            if workspace
            else JobWorkspace(self.settings.jobs_root, snapshot.id).snapshot_path
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(snapshot.model_dump_json(indent=2), encoding="utf-8")
        logger.debug("job_store.save job_id=%s target=%s", snapshot.id, target)

    def load(self, job_id: str) -> JobSnapshot:
        path = JobWorkspace(self.settings.jobs_root, job_id).snapshot_path
        data = json.loads(path.read_text(encoding="utf-8"))
        snapshot = self._normalize_snapshot(JobSnapshot.model_validate(data))
        logger.debug("job_store.load job_id=%s path=%s", job_id, path)
        return snapshot

    def list_jobs(self) -> list[JobSnapshot]:
        jobs: list[JobSnapshot] = []
        for path in self.settings.jobs_root.glob("*/job.json"):
            data = json.loads(path.read_text(encoding="utf-8"))
            jobs.append(self._normalize_snapshot(JobSnapshot.model_validate(data)))
        logger.debug("job_store.list jobs=%s", len(jobs))
        return sorted(jobs, key=lambda item: item.updated_at, reverse=True)[
            : self.settings.recent_jobs
        ]

    def delete(self, job_id: str) -> None:
        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        if workspace.job_dir.exists():
            shutil.rmtree(workspace.job_dir)
            logger.info("job_store.delete job_id=%s workspace=%s", job_id, workspace.job_dir)

    def update(self, job_id: str, mutator) -> JobSnapshot:
        with self._lock:
            snapshot = self.load(job_id)
            mutator(snapshot)
            snapshot.updated_at = utcnow()
            self.save(snapshot)
            logger.debug(
                "job_store.update job_id=%s status=%s current_step=%s",
                job_id,
                snapshot.status.value,
                snapshot.current_step.value if snapshot.current_step else None,
            )
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
        logger.info("job_store.append_log job_id=%s message=%s", job_id, message)
        entry = self._format_log_entry(message)

        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.logs.append(entry)
            snapshot.logs = snapshot.logs[-100:]

        return self.update(job_id, mutate)

    def replace_request(self, job_id: str, request: JobRequest) -> JobSnapshot:
        logger.info(
            "job_store.replace_request job_id=%s title=%s",
            job_id,
            request.title,
        )
        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.request = request
            snapshot.title = request.title
            snapshot.error = None

        return self.update(job_id, mutate)

    def invalidate_workspace_from_step(
        self,
        job_id: str,
        step_name: StepName,
        *,
        preserve_outputs: bool = False,
    ) -> None:
        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        logger.info(
            "job_store.invalidate_workspace job_id=%s step=%s preserve_outputs=%s",
            job_id,
            step_name.value,
            preserve_outputs,
        )
        artifact_map: dict[StepName, tuple[str, ...]] = {
            StepName.ingest: (
                "01_media_probe.json",
                "02_vad_segments.json",
                "03_transcript_raw.json",
                "04_transcript_aligned.json",
                "05_spans_labeled.json",
                "06_edit_decision_list.json",
                "07_caption_display.json",
                "08_subtitles.ass",
                "09_render_plan.json",
            ),
            StepName.transcription: (
                "02_vad_segments.json",
                "03_transcript_raw.json",
                "04_transcript_aligned.json",
                "05_spans_labeled.json",
                "06_edit_decision_list.json",
                "07_caption_display.json",
                "08_subtitles.ass",
                "09_render_plan.json",
            ),
            StepName.alignment: (
                "04_transcript_aligned.json",
                "05_spans_labeled.json",
                "06_edit_decision_list.json",
                "07_caption_display.json",
                "08_subtitles.ass",
                "09_render_plan.json",
            ),
            StepName.editorial: (
                "05_spans_labeled.json",
                "06_edit_decision_list.json",
                "07_caption_display.json",
                "08_subtitles.ass",
                "09_render_plan.json",
            ),
            StepName.render: ("08_subtitles.ass",),
        }

        for artifact_name in artifact_map.get(step_name, ()):
            artifact = workspace.artifact_path(artifact_name)
            if artifact.exists():
                artifact.unlink()

        if step_name == StepName.ingest:
            for temp_name in ("source_mezzanine.mp4", "audio_16k_mono.wav"):
                temp_file = workspace.temp_path(temp_name)
                if temp_file.exists():
                    temp_file.unlink()

        if not preserve_outputs:
            for output_name in (
                "edited_master.mp4",
                "master_vertical_clean.mp4",
                "master_vertical_captioned.mp4",
            ):
                output = workspace.output_path(output_name)
                if output.exists():
                    output.unlink()

        if workspace.state_path.exists():
            workspace.state_path.unlink()

    def reset_from_step(
        self,
        job_id: str,
        step_name: StepName,
        *,
        preserve_outputs: bool = False,
    ) -> JobSnapshot:
        logger.info(
            "job_store.reset_from_step job_id=%s step=%s preserve_outputs=%s",
            job_id,
            step_name.value,
            preserve_outputs,
        )
        start_index = next(
            index
            for index, candidate in enumerate(default_step_snapshots())
            if candidate.name == step_name
        )

        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.status = JobStatus.pending
            snapshot.current_step = None
            snapshot.error = None
            if not preserve_outputs:
                snapshot.outputs = []
            for step in snapshot.steps[start_index:]:
                step.status = StepStatus.pending
                step.progress = 0
                step.message = ""
                step.started_at = None
                step.finished_at = None
                step.artifacts = []
                step.can_run = False
                step.blocked_reason = ""

        return self.update(job_id, mutate)

    def begin_step(self, job_id: str, step_name: StepName, message: str) -> JobSnapshot:
        logger.info("job_store.begin_step job_id=%s step=%s", job_id, step_name.value)
        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.current_step = step_name
            step = snapshot.step(step_name)
            step.status = StepStatus.running
            step.progress = 0
            step.started_at = utcnow()
            step.message = message

        return self.update(job_id, mutate)

    def update_step_progress(
        self,
        job_id: str,
        step_name: StepName,
        progress: int,
        message: str,
    ) -> JobSnapshot:
        clamped = max(0, min(100, progress))
        logger.debug(
            "job_store.update_step_progress job_id=%s step=%s progress=%s message=%s",
            job_id,
            step_name.value,
            clamped,
            message,
        )

        def mutate(snapshot: JobSnapshot) -> None:
            step = snapshot.step(step_name)
            if step.status == StepStatus.pending:
                step.status = StepStatus.running
            step.progress = clamped
            step.message = message

        return self.update(job_id, mutate)

    def complete_step(
        self,
        job_id: str,
        step_name: StepName,
        message: str,
        artifacts: list[str] | None = None,
    ) -> JobSnapshot:
        logger.info(
            "job_store.complete_step job_id=%s step=%s artifacts=%s",
            job_id,
            step_name.value,
            artifacts or [],
        )
        def mutate(snapshot: JobSnapshot) -> None:
            step = snapshot.step(step_name)
            step.status = StepStatus.completed
            step.progress = 100
            step.finished_at = utcnow()
            step.message = message
            if artifacts:
                step.artifacts = artifacts

        return self.update(job_id, mutate)

    def fail_step(self, job_id: str, step_name: StepName, message: str) -> JobSnapshot:
        logger.error("job_store.fail_step job_id=%s step=%s error=%s", job_id, step_name.value, message)
        def mutate(snapshot: JobSnapshot) -> None:
            snapshot.current_step = step_name
            step = snapshot.step(step_name)
            step.status = StepStatus.failed
            step.finished_at = utcnow()
            step.message = message

        return self.update(job_id, mutate)

    @staticmethod
    def _normalize_snapshot(snapshot: JobSnapshot) -> JobSnapshot:
        steps_by_name = {step.name: step.model_copy(deep=True) for step in snapshot.steps}
        alignment_step = steps_by_name.get(StepName.alignment)

        if alignment_step is None and len(snapshot.steps) == len(default_step_snapshots()):
            return snapshot

        normalized_steps: list[StepSnapshot] = []
        for candidate in default_step_snapshots():
            if candidate.name == StepName.transcription and alignment_step is not None:
                transcription_step = steps_by_name.get(
                    StepName.transcription,
                    StepSnapshot(name=StepName.transcription),
                )
                normalized_steps.append(
                    JobStore._merge_transcription_step(transcription_step, alignment_step)
                )
                continue
            normalized_steps.append(
                steps_by_name.get(candidate.name, StepSnapshot(name=candidate.name))
            )

        current_step = snapshot.current_step
        if current_step == StepName.alignment:
            current_step = StepName.transcription
            logger.info("job_store.normalize legacy_alignment_current_step job_id=%s", snapshot.id)

        return snapshot.model_copy(
            update={
                "steps": normalized_steps,
                "current_step": current_step,
            }
        )

    @staticmethod
    def _merge_transcription_step(
        transcription_step: StepSnapshot,
        alignment_step: StepSnapshot,
    ) -> StepSnapshot:
        status = transcription_step.status
        if alignment_step.status == StepStatus.failed:
            status = StepStatus.failed
        elif alignment_step.status == StepStatus.running:
            status = StepStatus.running
        elif alignment_step.status == StepStatus.completed:
            status = StepStatus.completed
        elif transcription_step.status == StepStatus.completed:
            status = StepStatus.pending

        artifacts = list(dict.fromkeys(transcription_step.artifacts + alignment_step.artifacts))
        message = (
            alignment_step.message
            if alignment_step.status != StepStatus.pending
            else transcription_step.message
        )
        progress = max(transcription_step.progress, alignment_step.progress)
        started_at = transcription_step.started_at or alignment_step.started_at
        finished_at = (
            alignment_step.finished_at
            if alignment_step.status == StepStatus.completed
            else None
        )

        return transcription_step.model_copy(
            update={
                "status": status,
                "progress": 100 if status == StepStatus.completed else progress,
                "message": message,
                "started_at": started_at,
                "finished_at": finished_at,
                "artifacts": artifacts,
                "can_run": transcription_step.can_run or alignment_step.can_run,
                "blocked_reason": transcription_step.blocked_reason or alignment_step.blocked_reason,
            }
        )

    @staticmethod
    def _format_log_entry(message: str) -> str:
        timestamp = utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
        return f"[{timestamp}] {message}"

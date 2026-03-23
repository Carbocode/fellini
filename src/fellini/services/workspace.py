from __future__ import annotations

from pathlib import Path


class JobWorkspace:
    def __init__(self, jobs_root: Path, job_id: str) -> None:
        self.jobs_root = jobs_root
        self.job_id = job_id
        self.job_dir = jobs_root / job_id
        self.uploads_dir = self.job_dir / "uploads"
        self.artifacts_dir = self.job_dir / "artifacts"
        self.output_dir = self.job_dir / "output"
        self.temp_dir = self.job_dir / "temp"
        self.snapshot_path = self.job_dir / "job.json"
        self.state_path = self.temp_dir / "pipeline_state.json"

    def bootstrap(self) -> None:
        for path in (
            self.job_dir,
            self.uploads_dir,
            self.artifacts_dir,
            self.output_dir,
            self.temp_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    def upload_path(self, stored_name: str) -> Path:
        return self.uploads_dir / stored_name

    def artifact_path(self, name: str) -> Path:
        return self.artifacts_dir / name

    def output_path(self, name: str) -> Path:
        return self.output_dir / name

    def temp_path(self, name: str) -> Path:
        return self.temp_dir / name

    def relative(self, path: Path) -> str:
        return str(path.relative_to(self.job_dir))

    def resolve_relative(self, relative_path: str) -> Path:
        target = (self.job_dir / relative_path).resolve()
        if not target.is_relative_to(self.job_dir.resolve()):
            msg = f"Path escapes workspace: {relative_path}"
            raise ValueError(msg)
        return target

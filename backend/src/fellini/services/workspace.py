from __future__ import annotations

import shutil
from pathlib import Path

from fellini.workspace_layout import (
    ASSET_PREVIEW_STATE_FILENAME,
    CANONICAL_AUDIO_FILENAME,
    EDITORIAL_PROJECT_FILENAME,
    JOBS_BACKGROUND_REMOVAL_DIRNAME,
    JOBS_PREVIEWS_DIRNAME,
    JOBS_RUNTIME_DIRNAME,
    JOBS_TRANSCRIPTIONS_DIRNAME,
    PIPELINE_STATE_FILENAME,
    PROJECT_JOBS_DIRNAME,
    PROJECT_OUTPUT_DIRNAME,
    PROJECT_SNAPSHOT_FILENAME,
    PROJECT_STATE_DIRNAME,
    PROJECT_TEMP_DIRNAME,
    PROJECT_UPLOADS_DIRNAME,
    SOURCE_MEZZANINE_FILENAME,
)


class JobWorkspace:
    def __init__(self, projects_root: Path, job_id: str) -> None:
        self.projects_root = projects_root
        self.jobs_root = projects_root
        self.project_id = job_id
        self.job_id = job_id
        self.project_root = projects_root / job_id
        self.job_dir = self.project_root
        self.uploads_dir = self.project_root / PROJECT_UPLOADS_DIRNAME
        self.jobs_dir = self.project_root / PROJECT_JOBS_DIRNAME
        self.artifacts_dir = self.jobs_dir
        self.output_dir = self.project_root / PROJECT_OUTPUT_DIRNAME
        self.project_state_dir = self.project_root / PROJECT_STATE_DIRNAME
        self.project_dir = self.project_state_dir
        self.temp_dir = self.project_root / PROJECT_TEMP_DIRNAME
        self.preview_dir = self.jobs_dir / JOBS_PREVIEWS_DIRNAME
        self.background_removal_dir = self.jobs_dir / JOBS_BACKGROUND_REMOVAL_DIRNAME
        self.runtime_dir = self.jobs_dir / JOBS_RUNTIME_DIRNAME
        self.transcriptions_dir = self.jobs_dir / JOBS_TRANSCRIPTIONS_DIRNAME
        self.snapshot_path = self.project_root / PROJECT_SNAPSHOT_FILENAME
        self.state_path = self.runtime_dir / PIPELINE_STATE_FILENAME
        self.mezzanine_path = self.runtime_dir / SOURCE_MEZZANINE_FILENAME
        self.audio_path = self.runtime_dir / CANONICAL_AUDIO_FILENAME
        self.editorial_project_path = self.project_state_dir / EDITORIAL_PROJECT_FILENAME
        self.asset_preview_state_path = self.project_state_dir / ASSET_PREVIEW_STATE_FILENAME

    def bootstrap(self) -> None:
        for path in (
            self.project_root,
            self.uploads_dir,
            self.jobs_dir,
            self.preview_dir,
            self.background_removal_dir,
            self.runtime_dir,
            self.output_dir,
            self.project_state_dir,
            self.transcriptions_dir,
            self.temp_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    def upload_path(self, stored_name: str) -> Path:
        return self.uploads_dir / stored_name

    def artifact_path(self, name: str) -> Path:
        return self.jobs_dir / name

    def preview_artifact_path(self, asset_id: str, variant: str, name: str) -> Path:
        target = self.preview_dir / asset_id / variant / name
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def output_path(self, name: str) -> Path:
        return self.output_dir / name

    def temp_path(self, name: str) -> Path:
        return self.temp_dir / name

    def runtime_path(self, name: str) -> Path:
        return self.runtime_dir / name

    def transcription_path(self, scope_id: str, name: str) -> Path:
        target = self.transcriptions_dir / scope_id / name
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def clear_temp(self) -> None:
        if not self.temp_dir.exists():
            self.temp_dir.mkdir(parents=True, exist_ok=True)
            return
        for child in list(self.temp_dir.iterdir()):
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)

    def relative(self, path: Path) -> str:
        return str(path.relative_to(self.project_root))

    def resolve_relative(self, relative_path: str) -> Path:
        target = (self.project_root / relative_path).resolve()
        if not target.is_relative_to(self.project_root.resolve()):
            msg = f"Path escapes workspace: {relative_path}"
            raise ValueError(msg)
        return target

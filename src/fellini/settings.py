from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class AppSettings(BaseModel):
    app_name: str = "Fellini"
    workspace_root: Path = Field(default_factory=lambda: Path("workspace"))
    log_level: str = "INFO"
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    host: str = "127.0.0.1"
    port: int = 8123
    recent_jobs: int = 12
    fonts_dir: Path | None = None
    degraded_mode_when_ai_missing: bool = True

    @property
    def jobs_root(self) -> Path:
        return self.workspace_root / "jobs"

    def ensure_directories(self) -> None:
        self.jobs_root.mkdir(parents=True, exist_ok=True)


def load_settings(config_path: Path | None = None) -> AppSettings:
    candidate = config_path or Path("fellini.yaml")
    if candidate.exists():
        with candidate.open("r", encoding="utf-8") as handle:
            data: dict[str, Any] = yaml.safe_load(handle) or {}
        settings = AppSettings.model_validate(data)
    else:
        settings = AppSettings()

    settings.ensure_directories()
    return settings

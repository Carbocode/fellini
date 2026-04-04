from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _default_workspace_root() -> Path:
    return project_root() / "workspace"


def _default_config_candidates() -> tuple[Path, ...]:
    root = project_root()
    return (root / "backend" / "fellini.yaml", root / "fellini.yaml")


def _resolve_relative_path(path: Path | None, *, base_dir: Path) -> Path | None:
    if path is None or path.is_absolute():
        return path
    return (base_dir / path).resolve()


def _normalize_settings(settings: AppSettings, *, base_dir: Path) -> AppSettings:
    settings.workspace_root = _resolve_relative_path(settings.workspace_root, base_dir=base_dir)
    settings.fonts_dir = _resolve_relative_path(settings.fonts_dir, base_dir=base_dir)
    return settings


class AppSettings(BaseModel):
    app_name: str = "Fellini"
    workspace_root: Path = Field(default_factory=_default_workspace_root)
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
    candidate: Path | None = None
    if config_path is not None:
        if config_path.exists():
            candidate = config_path.resolve()
    else:
        for default_candidate in _default_config_candidates():
            if default_candidate.exists():
                candidate = default_candidate
                break

    if candidate is not None:
        with candidate.open("r", encoding="utf-8") as handle:
            data: dict[str, Any] = yaml.safe_load(handle) or {}
        settings = AppSettings.model_validate(data)
        settings = _normalize_settings(settings, base_dir=candidate.parent)
    else:
        settings = AppSettings()
        settings = _normalize_settings(settings, base_dir=project_root())

    settings.ensure_directories()
    return settings

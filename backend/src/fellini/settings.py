from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from fellini.workspace_layout import (
    CANONICAL_AUDIO_FILENAME,
    EDITORIAL_PROJECT_FILENAME,
    JOBS_PREVIEWS_DIRNAME,
    JOBS_RUNTIME_DIRNAME,
    JOBS_TRANSCRIPTIONS_DIRNAME,
    PIPELINE_STATE_FILENAME,
    PROJECT_JOBS_DIRNAME,
    PROJECT_LEGACY_JOBS_DIRNAME,
    PROJECT_LEGACY_SNAPSHOT_FILENAME,
    PROJECT_SNAPSHOT_FILENAME,
    PROJECT_STATE_DIRNAME,
    PROJECT_TEMP_DIRNAME,
    SOURCE_MEZZANINE_FILENAME,
    TRANSCRIPTION_LANE_SCOPE_PREFIX,
    TRANSCRIPTION_ORPHAN_SCOPE_DIRNAME,
    WORKSPACE_LEGACY_PROJECTS_DIRNAME,
    WORKSPACE_PROJECTS_DIRNAME,
)


def project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _default_workspace_root() -> Path:
    return project_root() / "workspace"


TEXT_FILE_SUFFIXES = {
    ".json",
    ".log",
    ".md",
    ".txt",
    ".yaml",
    ".yml",
}

PREVIEW_FILENAME_RE = re.compile(
    r"^(?P<asset_id>[^.]+)\.(?P<variant>[^.]+)\.(?P<kind>filmstrip|waveform)\.(?P<ext>png|json)$"
)
TRANSCRIPTION_FILENAME_RE = re.compile(
    r"^(?P<kind>clip|lane)_(?P<identifier>.+)_bounce\.wav$"
)


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


def _replace_text(path: Path, replacements: dict[str, str]) -> None:
    if path.suffix.lower() not in TEXT_FILE_SUFFIXES and path.name not in {
        PROJECT_SNAPSHOT_FILENAME,
        PIPELINE_STATE_FILENAME,
    }:
        return
    try:
        original = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    updated = original
    for source, target in replacements.items():
        updated = updated.replace(source, target)
    if updated != original:
        path.write_text(updated, encoding="utf-8")


def _move_file(source: Path, target: Path) -> bool:
    if not source.exists() or target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    return True


def _migrate_preview_layout(project_root: Path, replacements: dict[str, str]) -> None:
    preview_root = project_root / PROJECT_JOBS_DIRNAME / JOBS_PREVIEWS_DIRNAME
    if not preview_root.exists():
        return
    for source in list(preview_root.iterdir()):
        if not source.is_file():
            continue
        match = PREVIEW_FILENAME_RE.match(source.name)
        if not match:
            continue
        target = (
            preview_root
            / match.group("asset_id")
            / match.group("variant")
            / f"{match.group('kind')}.{match.group('ext')}"
        )
        if _move_file(source, target):
            replacements[
                str(Path(PROJECT_JOBS_DIRNAME) / JOBS_PREVIEWS_DIRNAME / source.name)
            ] = str(target.relative_to(project_root))


def _load_editorial_project_payload(project_root: Path) -> dict[str, Any]:
    path = project_root / PROJECT_STATE_DIRNAME / EDITORIAL_PROJECT_FILENAME
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _track_asset_ids(project_payload: dict[str, Any], lane_id: str) -> set[str]:
    clips = project_payload.get("clips")
    if not isinstance(clips, list):
        return set()
    asset_ids: set[str] = set()
    for clip in clips:
        if not isinstance(clip, dict):
            continue
        if not clip.get("enabled", True):
            continue
        if clip.get("track_id") != lane_id:
            continue
        asset_id = clip.get("asset_id")
        if isinstance(asset_id, str) and asset_id:
            asset_ids.add(asset_id)
    return asset_ids


def _fallback_audio_asset_id(project_payload: dict[str, Any]) -> str | None:
    assets = project_payload.get("assets")
    if not isinstance(assets, list):
        return None
    for asset in assets:
        if not isinstance(asset, dict) or not asset.get("has_audio"):
            continue
        asset_id = asset.get("id")
        if isinstance(asset_id, str) and asset_id:
            return asset_id
    return None


def _transcription_scope_for_lane_payload(project_payload: dict[str, Any], lane_id: str) -> str:
    asset_ids = _track_asset_ids(project_payload, lane_id)
    if len(asset_ids) == 1:
        return next(iter(asset_ids))
    if not asset_ids:
        fallback_asset_id = _fallback_audio_asset_id(project_payload)
        if fallback_asset_id:
            return fallback_asset_id
    return f"{TRANSCRIPTION_LANE_SCOPE_PREFIX}{lane_id}"


def _migrate_transcription_layout(project_root: Path, replacements: dict[str, str]) -> None:
    transcriptions_root = project_root / PROJECT_JOBS_DIRNAME / JOBS_TRANSCRIPTIONS_DIRNAME
    if not transcriptions_root.exists():
        return

    project_payload = _load_editorial_project_payload(project_root)
    clip_asset_ids: dict[str, str] = {}
    clips = project_payload.get("clips")
    if isinstance(clips, list):
        for clip in clips:
            if not isinstance(clip, dict):
                continue
            clip_id = clip.get("id")
            asset_id = clip.get("asset_id")
            if isinstance(clip_id, str) and isinstance(asset_id, str) and clip_id and asset_id:
                clip_asset_ids[clip_id] = asset_id

    targets_by_relative_path: dict[str, Path] = {}

    lane_transcriptions = project_payload.get("lane_transcriptions")
    if isinstance(lane_transcriptions, list):
        for lane in lane_transcriptions:
            if not isinstance(lane, dict):
                continue
            source_audio_path = lane.get("source_audio_path")
            lane_id = lane.get("lane_id")
            if not isinstance(source_audio_path, str) or not isinstance(lane_id, str):
                continue
            if source_audio_path.count("/") != 2:
                continue
            targets_by_relative_path[source_audio_path] = (
                transcriptions_root
                / _transcription_scope_for_lane_payload(project_payload, lane_id)
                / Path(source_audio_path).name
            )

    asset_transcriptions = project_payload.get("asset_transcriptions")
    if isinstance(asset_transcriptions, list):
        for item in asset_transcriptions:
            if not isinstance(item, dict):
                continue
            source_audio_path = item.get("source_audio_path")
            asset_id = item.get("asset_id")
            if not isinstance(source_audio_path, str) or not isinstance(asset_id, str):
                continue
            if source_audio_path.count("/") != 2 or source_audio_path in targets_by_relative_path:
                continue
            targets_by_relative_path[source_audio_path] = (
                transcriptions_root / asset_id / Path(source_audio_path).name
            )

    if isinstance(clips, list):
        for clip in clips:
            if not isinstance(clip, dict):
                continue
            source_audio_path = clip.get("transcription_source_audio_path")
            clip_id = clip.get("id")
            if not isinstance(source_audio_path, str) or not isinstance(clip_id, str):
                continue
            if source_audio_path.count("/") != 2 or source_audio_path in targets_by_relative_path:
                continue
            asset_id = clip_asset_ids.get(clip_id)
            if asset_id is None:
                continue
            targets_by_relative_path[source_audio_path] = (
                transcriptions_root / asset_id / Path(source_audio_path).name
            )

    for source in list(transcriptions_root.iterdir()):
        if not source.is_file():
            continue
        relative_source = str(source.relative_to(project_root))
        target = targets_by_relative_path.get(relative_source)
        if target is None:
            match = TRANSCRIPTION_FILENAME_RE.match(source.name)
            if match and match.group("kind") == "lane":
                target = (
                    transcriptions_root
                    / f"{TRANSCRIPTION_LANE_SCOPE_PREFIX}{match.group('identifier')}"
                    / source.name
                )
            else:
                target = transcriptions_root / TRANSCRIPTION_ORPHAN_SCOPE_DIRNAME / source.name
        if _move_file(source, target):
            replacements[relative_source] = str(target.relative_to(project_root))


def _migrate_project_layout(project_root: Path, *, original_project_root: Path) -> None:
    legacy_snapshot = project_root / PROJECT_LEGACY_SNAPSHOT_FILENAME
    next_snapshot = project_root / PROJECT_SNAPSHOT_FILENAME
    if legacy_snapshot.exists() and not next_snapshot.exists():
        legacy_snapshot.rename(next_snapshot)

    legacy_artifacts = project_root / PROJECT_LEGACY_JOBS_DIRNAME
    next_jobs = project_root / PROJECT_JOBS_DIRNAME
    if legacy_artifacts.exists() and not next_jobs.exists():
        legacy_artifacts.rename(next_jobs)

    runtime_dir = next_jobs / JOBS_RUNTIME_DIRNAME
    transcriptions_dir = next_jobs / JOBS_TRANSCRIPTIONS_DIRNAME
    runtime_dir.mkdir(parents=True, exist_ok=True)
    transcriptions_dir.mkdir(parents=True, exist_ok=True)

    replacements = {
        str(original_project_root): str(project_root),
        str(Path(PROJECT_LEGACY_JOBS_DIRNAME)): str(Path(PROJECT_JOBS_DIRNAME)),
        f"{PROJECT_LEGACY_JOBS_DIRNAME}/": f"{PROJECT_JOBS_DIRNAME}/",
        f"/{PROJECT_LEGACY_JOBS_DIRNAME}/": f"/{PROJECT_JOBS_DIRNAME}/",
        str(Path("temp") / PIPELINE_STATE_FILENAME): str(
            Path(PROJECT_JOBS_DIRNAME) / JOBS_RUNTIME_DIRNAME / PIPELINE_STATE_FILENAME
        ),
        str(Path("temp") / SOURCE_MEZZANINE_FILENAME): str(
            Path(PROJECT_JOBS_DIRNAME) / JOBS_RUNTIME_DIRNAME / SOURCE_MEZZANINE_FILENAME
        ),
        str(Path("temp") / CANONICAL_AUDIO_FILENAME): str(
            Path(PROJECT_JOBS_DIRNAME) / JOBS_RUNTIME_DIRNAME / CANONICAL_AUDIO_FILENAME
        ),
    }

    temp_dir = project_root / PROJECT_TEMP_DIRNAME
    if temp_dir.exists():
        _move_file(temp_dir / PIPELINE_STATE_FILENAME, runtime_dir / PIPELINE_STATE_FILENAME)
        _move_file(temp_dir / SOURCE_MEZZANINE_FILENAME, runtime_dir / SOURCE_MEZZANINE_FILENAME)
        _move_file(temp_dir / CANONICAL_AUDIO_FILENAME, runtime_dir / CANONICAL_AUDIO_FILENAME)

        for bounce_file in list(temp_dir.glob("*_bounce.wav")):
            target = transcriptions_dir / bounce_file.name
            if _move_file(bounce_file, target):
                replacements[str(Path("temp") / bounce_file.name)] = str(target.relative_to(project_root))

    _migrate_preview_layout(project_root, replacements)
    _migrate_transcription_layout(project_root, replacements)

    for path in project_root.rglob("*"):
        if path.is_file():
            _replace_text(path, replacements)

    if temp_dir.exists():
        for child in list(temp_dir.iterdir()):
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)


def _migrate_workspace_layout(workspace_root: Path) -> None:
    legacy_projects_root = workspace_root / WORKSPACE_LEGACY_PROJECTS_DIRNAME
    projects_root = workspace_root / WORKSPACE_PROJECTS_DIRNAME
    migrated_project_ids: set[str] = set()

    if legacy_projects_root.exists():
        projects_root.mkdir(parents=True, exist_ok=True)
        for legacy_project in list(legacy_projects_root.iterdir()):
            target = projects_root / legacy_project.name
            if target.exists():
                continue
            legacy_project.rename(target)
            _migrate_project_layout(target, original_project_root=legacy_project)
            migrated_project_ids.add(target.name)
        try:
            legacy_projects_root.rmdir()
        except OSError:
            pass

    if not projects_root.exists():
        return

    for project_root in projects_root.iterdir():
        if not project_root.is_dir():
            continue
        if project_root.name in migrated_project_ids:
            continue
        _migrate_project_layout(project_root, original_project_root=project_root)


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
    def projects_root(self) -> Path:
        return self.workspace_root / WORKSPACE_PROJECTS_DIRNAME

    @property
    def jobs_root(self) -> Path:
        # Legacy alias kept for internal compatibility while the runtime layout
        # transitions from workspace/jobs to workspace/projects.
        return self.projects_root

    def ensure_directories(self) -> None:
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        _migrate_workspace_layout(self.workspace_root)
        self.projects_root.mkdir(parents=True, exist_ok=True)


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

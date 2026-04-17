from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fellini.domain.models import StepName

_LAYOUT_PATH = Path(__file__).resolve().parents[3] / "shared" / "workspace_layout.json"
_LAYOUT: dict[str, Any] = json.loads(_LAYOUT_PATH.read_text(encoding="utf-8"))


def _section(name: str) -> dict[str, Any]:
    return _LAYOUT[name]


def _string(section: str, key: str) -> str:
    value = _section(section)[key]
    if not isinstance(value, str):
        msg = f"Layout value {section}.{key} must be a string."
        raise TypeError(msg)
    return value


def _step_map(section: str) -> dict[StepName, tuple[str, ...]]:
    source = _section(section)
    mapping: dict[StepName, tuple[str, ...]] = {}
    for step_name, filenames in source.items():
        mapping[StepName(step_name)] = tuple(filenames)
    return mapping


WORKSPACE_PROJECTS_DIRNAME = _string("workspace", "projects_dirname")
WORKSPACE_LEGACY_PROJECTS_DIRNAME = _string("workspace", "legacy_projects_dirname")

PROJECT_UPLOADS_DIRNAME = _string("project", "uploads_dirname")
PROJECT_JOBS_DIRNAME = _string("project", "jobs_dirname")
PROJECT_LEGACY_JOBS_DIRNAME = _string("project", "legacy_jobs_dirname")
PROJECT_OUTPUT_DIRNAME = _string("project", "output_dirname")
PROJECT_STATE_DIRNAME = _string("project", "state_dirname")
PROJECT_TEMP_DIRNAME = _string("project", "temp_dirname")

PROJECT_SNAPSHOT_FILENAME = _string("project_files", "snapshot")
PROJECT_LEGACY_SNAPSHOT_FILENAME = _string("project_files", "legacy_snapshot")
EDITORIAL_PROJECT_FILENAME = _string("project_files", "editorial_project")
ASSET_PREVIEW_STATE_FILENAME = _string("project_files", "asset_preview_state")

JOBS_PREVIEWS_DIRNAME = _string("job_dirs", "previews")
JOBS_BACKGROUND_REMOVAL_DIRNAME = _string("job_dirs", "background_removal")
JOBS_RUNTIME_DIRNAME = _string("job_dirs", "runtime")
JOBS_TRANSCRIPTIONS_DIRNAME = _string("job_dirs", "transcriptions")

PIPELINE_STATE_FILENAME = _string("runtime_files", "pipeline_state")
SOURCE_MEZZANINE_FILENAME = _string("runtime_files", "source_mezzanine")
CANONICAL_AUDIO_FILENAME = _string("runtime_files", "canonical_audio")
EDITED_MASTER_FILENAME = _string("runtime_files", "edited_master")
TRANSCRIPTION_LANE_SCOPE_PREFIX = _string("naming", "transcription_lane_scope_prefix")
TRANSCRIPTION_ORPHAN_SCOPE_DIRNAME = _string("naming", "transcription_orphan_scope_dirname")

ARTIFACT_MEDIA_PROBE_FILENAME = _string("artifacts", "media_probe")
ARTIFACT_VAD_SEGMENTS_FILENAME = _string("artifacts", "vad_segments")
ARTIFACT_TRANSCRIPT_RAW_FILENAME = _string("artifacts", "transcript_raw")
ARTIFACT_TRANSCRIPT_ALIGNED_FILENAME = _string("artifacts", "transcript_aligned")
ARTIFACT_STORY_LANE_UNIFIED_TRANSCRIPT_FILENAME = _string(
    "artifacts", "story_lane_unified_transcript"
)
ARTIFACT_SPANS_FILENAME = _string("artifacts", "spans_labeled")
ARTIFACT_EDIT_DECISION_LIST_FILENAME = _string("artifacts", "edit_decision_list")
ARTIFACT_CAPTION_DISPLAY_FILENAME = _string("artifacts", "caption_display")
ARTIFACT_RENDER_PLAN_FILENAME = _string("artifacts", "render_plan")

STEP_ARTIFACT_FILENAMES = _step_map("step_artifacts")
RECOVERABLE_STEP_ARTIFACT_FILENAMES = _step_map("recoverable_step_artifacts")

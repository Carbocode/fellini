# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Fellini

Local-first pipeline for AI-assisted social video editing. Takes raw video, runs ASR transcription, word-level alignment, deterministic + LLM editorial decisions, and renders vertical (9:16) exports with animated ASS subtitles. Italian-focused but language-configurable.

## Commands

```bash
# Fresh clone bootstrap from repo root
make setup

# Fresh clone bootstrap with full AI stack
make setup-full

# Install (dev only)
cd backend && poetry install --with dev

# Install (full AI stack: faster-whisper, whisperx, torch, transformers)
cd backend && poetry install --with dev,asr,llm

# Run tests
cd backend && poetry run pytest

# Run a single test
cd backend && poetry run pytest tests/test_decision_engine.py::test_filler_removal -x

# Lint
cd backend && poetry run ruff check .

# Dev server with hot reload
cd backend && poetry run uvicorn fellini.app:create_app --factory --reload

# Production server
cd backend && poetry run fellini serve

# CLI single run
cd backend && poetry run fellini run ./clip.mp4 --title "Test" --profile balanced
```

## Architecture

The project follows a layered architecture with strict separation between domain models, adapters (external tools), pipeline orchestration, and services.

### Pipeline flow

Five sequential steps, each producing numbered JSON artifacts in `workspace/jobs/<job_id>/artifacts/`:

1. **ingest** - `ffprobe` media, build `source_mezzanine.mp4`, extract `audio_16k_mono.wav`
2. **transcription** - VAD-aware ASR via `faster-whisper` (produces `02_vad_segments.json`, `03_transcript_raw.json`)
3. **alignment** - Word-level timestamps via WhisperX or heuristic fallback (`04_transcript_aligned.json`)
4. **editorial** - Rule-based span labeling (KEEP/CUT/SHORTEN/MAYBE) + optional LLM refinement, builds EDL and caption chunks (`05_spans_labeled.json`, `06_edit_decision_list.json`, `07_caption_display.json`)
5. **render** - FFmpeg trim+concat from EDL, vertical crop/scale, ASS subtitle burn-in (`08_subtitles.ass`, `09_render_plan.json`)

### Key design decisions

- **Degraded mode**: When AI dependencies (`faster-whisper`, `whisperx`, `torch`) are missing, the pipeline continues without transcript-derived edits. Controlled by `degraded_mode_when_ai_missing` in settings.
- **Codec fallback**: If `libx264` is unavailable, FFmpeg adapter auto-falls back to `libopenh264` then `mpeg4`.
- **Pipeline state**: `PipelineContext` persists `PipelineState` to `temp/pipeline_state.json`, enabling step reruns from intermediate artifacts.
- **Job execution**: `JobManager.start()` and `start_step()` run pipeline steps in daemon threads. `run_sync()` blocks.
- **Step dependencies**: `_validate_step_run` in `app.py` enforces that all prior steps must be completed before running a step.

### Layer responsibilities

- **`backend/src/fellini/domain/models.py`** - All Pydantic models: `JobSnapshot`, `PipelineState`, `JobRequest` with nested configs (`TranscriptionConfig`, `SubtitleConfig`, `RenderConfig`, `DecisionConfig`), transcript/EDL/caption types. `JobRequest.with_profile()` applies preset overrides for fast/balanced/quality profiles.
- **`backend/src/fellini/adapters/`** - Wrappers around external tools. Each checks dependency availability at runtime via `importlib.util.find_spec`. `FFmpegAdapter` shells out to ffmpeg/ffprobe. `RuleBasedDecisionEngine` is pure Python (no external deps). `LocalLLMRefiner` is a stub/extension point.
- **`backend/src/fellini/pipeline/`** - `PipelineOrchestrator` runs steps sequentially, `PipelineContext` holds state and adapter instances, `steps/base.py` defines the `PipelineStep` ABC (each step returns a list of relative artifact paths).
- **`backend/src/fellini/services/`** - `JobStore` handles JSON persistence with a thread lock, `JobWorkspace` manages the per-job directory layout, `JobManager` coordinates creation and execution.
- **`backend/src/fellini/app.py`** - FastAPI app factory. Multipart form for job creation, JSON body for config updates. Serves the bundled frontend from `frontend/dist` when available.

## Configuration

Runtime config via `backend/fellini.yaml` (optional, see `backend/fellini.example.yaml`). Parsed into `AppSettings` Pydantic model. Python/Poetry config is separate.

## Tech stack

- Python 3.12 (strict, no 3.13+)
- Poetry with in-project virtualenv (`backend/.venv/`)
- FastAPI + Uvicorn + Jinja2
- Pydantic v2 for all models
- Ruff for linting (line-length 100, rules: E, F, I, B, UP, N, S, RUF)
- pytest + httpx for tests

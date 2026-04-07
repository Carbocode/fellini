# CLAUDE.md

This file provides guidance to Claude Code and similar coding agents working in this repository.

## Canonical product framing

`Agent.md` is the canonical product description.

Fellini is a local-first, non-destructive video editor with:

- a single workspace-oriented UI
- an asset library with previews
- a multi-lane timeline
- editable subtitle blocks
- tool-style automations triggered from the editor

Do not describe Fellini as a pipeline-first or automatic-editing-first product. Internal jobs, steps and orchestration still exist, but they are implementation details for heavy asynchronous work.

## Commands

```bash
# Fresh clone bootstrap from repo root
make setup

# Fresh clone bootstrap with full AI stack
make setup-full

# Install backend only
cd backend && poetry install --with dev

# Install backend with ASR + local model dependencies
cd backend && poetry install --with dev,asr,llm

# Backend dev server
cd backend && poetry run python -m fellini serve

# Backend + frontend dev
make dev-all

# Run tests
cd backend && poetry run pytest

# Lint
cd backend && poetry run ruff check .

# Validate Poetry metadata
cd backend && poetry check
```

## Product mental model

The primary application model is `EditorialProject`, not `JobSnapshot`.

`EditorialProject` owns:

- `sequence`
- `assets`
- `tracks`
- `clips`
- `captions`
- `asset_transcriptions`
- `lane_transcriptions`
- `selection`

Use that model when reasoning about product behavior, future features, and UI integrations.

`JobSnapshot`, `StepName`, pipeline state and numbered artifacts are backend wrappers for async execution, retries, and workspace persistence. They are not the primary public abstraction.

## User-facing workflow

The current intended flow is:

1. create a project and choose the canvas
2. upload source and library assets
3. preview media
4. place clips on timeline lanes
5. set the audio `story lane`
6. transcribe an audio lane when needed
7. edit clips and subtitle blocks
8. run `Editorial` or `Render` tools from the UI

The first uploaded source asset may trigger an internal ingest/bootstrap pass to create the mezzanine source asset, but this should still be framed as editor initialization, not as the product's main workflow.

## Repo map

- `frontend/src/components/Workspace.tsx` - main editor UI: library, preview, timeline, playhead, interactions
- `frontend/src/components/ParamsInspector.tsx` - contextual editing for tracks, clips and subtitle blocks
- `frontend/src/lib/editorial.ts` - client-side project normalization and timeline helpers
- `backend/src/fellini/services/editorial_project.py` - source of truth for loading, saving, normalizing and migrating `EditorialProject`
- `backend/src/fellini/app.py` - API surface for project CRUD, timeline persistence, lane transcription, asset previews and internal tool execution
- `backend/src/fellini/adapters/ffmpeg.py` - preview generation, lane bounce, project render, legacy render helpers
- `backend/src/fellini/pipeline/` - internal orchestration for heavy background tools; keep as implementation detail in explanations

## Internal execution model

The codebase still contains a legacy/internal step engine:

- `PipelineOrchestrator` and `JobManager` execute heavy tasks
- `JobWorkspace` persists uploads, project state, artifacts, previews, outputs and temp files
- `/api/jobs/{job_id}/steps/{step_name}/run` is still used for internal tool execution
- numbered artifacts and `pipeline_state.json` support recovery and reruns

When documenting or explaining the product, mention these only as backend internals.

## Current product capabilities to keep in mind

- project creation with configurable canvas dimensions
- asset library and media previews
- filmstrip and waveform preview generation
- linked audio/video clip placement on timeline lanes
- non-destructive clip timing, transform, crop, gain and fade editing
- story-lane selection
- lane transcription and word timing persistence
- generated subtitle blocks that can be edited after generation
- editorial and render tools triggered from the UI

## Guidance for future AI/tooling proposals

When proposing local models or automation features, always frame them by editor integration surface:

- `asset-level`
- `clip-level`
- `lane-level`
- `timeline-level`
- `export-level`

For each candidate feature, explicitly classify:

- whether a model or a classical algorithm makes more sense
- model weight / operational heaviness
- minimum realistic hardware
- platform compatibility
- exact invocation point in the editor

Do not frame future work as "adding another pipeline step" unless the change is purely internal and explicitly about backend execution plumbing.

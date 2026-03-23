from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from fellini.domain.models import (
    DEFAULT_STEPS,
    DecisionConfig,
    ExecutionMode,
    JobRequest,
    JobStatus,
    RenderConfig,
    RunProfile,
    StepName,
    SubtitleConfig,
    TranscriptionConfig,
)
from fellini.services.job_manager import JobManager
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings, load_settings


def _merge_model(model, payload: dict[str, Any], model_type):
    return model_type.model_validate({**model.model_dump(mode="json"), **payload})


def _build_request_model(
    payload: dict[str, Any],
    *,
    existing_request: JobRequest | None = None,
) -> JobRequest:
    profile = RunProfile(payload.get("profile", RunProfile.balanced))
    execution_mode = ExecutionMode(payload.get("execution_mode", ExecutionMode.automatic))
    request_model = JobRequest.with_profile(
        title=payload.get("title", "Nuovo progetto"),
        profile=profile,
        execution_mode=execution_mode,
        language=payload.get("language", "it"),
        editorial_notes=payload.get("editorial_notes", ""),
    )

    toggles_payload = payload.get("toggles", {})
    if toggles_payload:
        request_model.toggles = _merge_model(
            request_model.toggles,
            toggles_payload,
            type(request_model.toggles),
        )

    subtitle_payload = payload.get("subtitle", {})
    if subtitle_payload:
        request_model.subtitle = _merge_model(
            request_model.subtitle,
            subtitle_payload,
            SubtitleConfig,
        )

    if profile == RunProfile.custom:
        transcription_payload = payload.get("transcription", {})
        if transcription_payload:
            request_model.transcription = _merge_model(
                request_model.transcription,
                transcription_payload,
                TranscriptionConfig,
            )

        render_payload = payload.get("render", {})
        if render_payload:
            request_model.render = _merge_model(
                request_model.render,
                render_payload,
                RenderConfig,
            )

        decision_payload = payload.get("decision", {})
        if decision_payload:
            request_model.decision = _merge_model(
                request_model.decision,
                decision_payload,
                DecisionConfig,
            )

    if existing_request:
        request_model = request_model.model_copy(
            update={"input_assets": existing_request.input_assets}
        )

    return request_model


def _require_job(store: JobStore, job_id: str):
    try:
        return store.load(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc


def _validate_step_run(snapshot, step_name: StepName) -> None:
    if snapshot.status == JobStatus.running:
        raise HTTPException(status_code=409, detail="A run is already in progress for this job.")

    steps = snapshot.steps
    target_index = next(
        (index for index, step in enumerate(steps) if step.name == step_name),
        None,
    )
    if target_index is None:
        raise HTTPException(status_code=404, detail="Unknown step.")

    unmet_dependency = next(
        (step for step in steps[:target_index] if step.status.value != "completed"),
        None,
    )
    if unmet_dependency:
        raise HTTPException(
            status_code=409,
            detail=f"Complete the {unmet_dependency.name} step before running {step_name}.",
        )


def create_app(settings: AppSettings | None = None) -> FastAPI:
    app_settings = settings or load_settings()
    store = JobStore(app_settings)
    manager = JobManager(app_settings, store=store)

    app = FastAPI(title=app_settings.app_name)
    app.state.settings = app_settings
    app.state.store = store
    app.state.manager = manager

    base_dir = Path(__file__).parent / "ui"
    templates = Jinja2Templates(directory=str(base_dir / "templates"))
    app.mount("/static", StaticFiles(directory=str(base_dir / "static")), name="static")

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> HTMLResponse:
        return templates.TemplateResponse(
            request=request,
            name="index.html",
            context={
                "jobs": [job.model_dump(mode="json") for job in store.list_jobs()],
                "profiles": [profile.value for profile in RunProfile],
                "execution_modes": [mode.value for mode in ExecutionMode],
                "step_names": [step.value for step in DEFAULT_STEPS],
            },
        )

    @app.get("/api/jobs")
    async def list_jobs():
        return store.list_jobs()

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        return _require_job(store, job_id)

    @app.post("/api/jobs")
    async def create_job(
        job_payload: str = Form(...),
        files: list[UploadFile] = File(...),
    ):
        if not files:
            raise HTTPException(status_code=400, detail="At least one input file is required.")

        try:
            payload = json.loads(job_payload)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid job payload.") from exc

        request_model = _build_request_model(payload)

        payloads = [(upload.filename or "input.bin", await upload.read()) for upload in files]
        snapshot = manager.create_from_uploads(request_model, payloads)
        if request_model.execution_mode == ExecutionMode.automatic:
            manager.start(snapshot.id)
        return store.load(snapshot.id)

    @app.put("/api/jobs/{job_id}/request")
    async def update_job_request(job_id: str, payload: dict[str, Any] = Body(...)):
        snapshot = _require_job(store, job_id)
        if snapshot.status == JobStatus.running:
            raise HTTPException(
                status_code=409,
                detail="Stop the current run before changing the job configuration.",
            )

        request_model = _build_request_model(payload, existing_request=snapshot.request)
        updated = manager.update_request(job_id, request_model)
        return updated

    @app.post("/api/jobs/{job_id}/steps/{step_name}/run")
    async def run_job_step(job_id: str, step_name: StepName):
        snapshot = _require_job(store, job_id)
        _validate_step_run(snapshot, step_name)
        manager.start_step(job_id, step_name)
        return {"accepted": True, "job_id": job_id, "step": step_name.value}

    @app.get("/jobs/{job_id}/files/{relative_path:path}")
    async def get_job_file(job_id: str, relative_path: str):
        workspace = JobWorkspace(app_settings.jobs_root, job_id)
        try:
            target = workspace.resolve_relative(relative_path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not target.exists():
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(target)

    return app

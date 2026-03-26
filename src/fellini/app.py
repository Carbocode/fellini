from __future__ import annotations

import json
from pathlib import Path
from time import perf_counter
from typing import Any, Literal

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from fellini.domain.models import (
    DEFAULT_STEPS,
    ExecutionMode,
    JobRequest,
    JobSnapshot,
    JobStatus,
    RunProfile,
    StepName,
    StepStatus,
)
from fellini.log import configure_logging, get_logger
from fellini.services.job_manager import JobManager
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings, load_settings
from fellini.pipeline.context import PipelineContext

logger = get_logger(__name__)


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = {**base}
    for key, value in patch.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged[key] = _deep_merge(current, value)
        else:
            merged[key] = value
    return merged


def _build_request_model(
    payload: dict[str, Any],
    *,
    existing_request: JobRequest | None = None,
) -> JobRequest:
    if existing_request:
        base_payload = existing_request.model_dump(mode="json")
    else:
        profile = RunProfile(payload.get("profile", RunProfile.balanced))
        execution_mode = ExecutionMode(payload.get("execution_mode", ExecutionMode.automatic))
        base_payload = JobRequest.with_profile(
            title=payload.get("title", "Nuovo progetto"),
            profile=profile,
            execution_mode=execution_mode,
            language=payload.get("language", "it"),
            editorial_notes=payload.get("editorial_notes", ""),
        ).model_dump(mode="json")

    merged_payload = _deep_merge(base_payload, payload)
    if existing_request:
        merged_payload["input_assets"] = base_payload["input_assets"]
    request_model = JobRequest.model_validate(merged_payload)
    return request_model.apply_profile_overrides()


def _require_job(store: JobStore, job_id: str):
    try:
        return store.load(job_id)
    except FileNotFoundError as exc:
        logger.warning("job.not_found job_id=%s", job_id)
        raise HTTPException(status_code=404, detail="Job not found") from exc


def _validate_step_run(snapshot, step_name: StepName) -> None:
    if snapshot.status == JobStatus.running:
        logger.warning(
            "step.run.denied job_id=%s step=%s reason=job_running",
            snapshot.id,
            step_name.value,
        )
        raise HTTPException(status_code=409, detail="A run is already in progress for this job.")

    try:
        step = snapshot.step(step_name)
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Step {step_name.value} is not available for this job.",
        ) from exc
    if not step.can_run:
        detail = step.blocked_reason or f"Dependencies for {step_name.value} are not ready."
        logger.warning(
            "step.run.denied job_id=%s step=%s reason=%s",
            snapshot.id,
            step_name.value,
            detail,
        )
        raise HTTPException(status_code=409, detail=detail)


def _resolve_frontend_dist() -> Path | None:
    candidate = Path(__file__).resolve().parent.parent.parent.parent / "frontend" / "dist"
    if candidate.is_dir() and (candidate / "index.html").is_file():
        return candidate
    return None


def create_app(settings: AppSettings | None = None) -> FastAPI:
    app_settings = settings or load_settings()
    configure_logging(app_settings.log_level)
    store = JobStore(app_settings)
    manager = JobManager(app_settings, store=store)
    logger.info(
        "app.create settings workspace_root=%s jobs_root=%s host=%s port=%s log_level=%s",
        app_settings.workspace_root,
        app_settings.jobs_root,
        app_settings.host,
        app_settings.port,
        app_settings.log_level,
    )

    app = FastAPI(title=app_settings.app_name)
    app.state.settings = app_settings
    app.state.store = store
    app.state.manager = manager

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        started_at = perf_counter()
        client_host = request.client.host if request.client else "-"
        logger.info(
            "http.request.start method=%s path=%s client=%s",
            request.method,
            request.url.path,
            client_host,
        )
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = (perf_counter() - started_at) * 1000
            logger.exception(
                "http.request.error method=%s path=%s client=%s duration_ms=%.1f",
                request.method,
                request.url.path,
                client_host,
                duration_ms,
            )
            raise

        duration_ms = (perf_counter() - started_at) * 1000
        logger.info(
            "http.request.done method=%s path=%s status=%s duration_ms=%.1f",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
        )
        return response

    def build_context(snapshot: JobSnapshot) -> PipelineContext:
        logger.debug("context.build job_id=%s", snapshot.id)
        workspace = JobWorkspace(app_settings.jobs_root, snapshot.id)
        context = PipelineContext(
            settings=app_settings,
            request=snapshot.request,
            workspace=workspace,
            store=store,
        )
        context.load_state()
        return context

    def step_readiness(
        snapshot: JobSnapshot,
        step_name: StepName,
        *,
        context: PipelineContext | None = None,
    ) -> tuple[bool, str]:
        context = context or build_context(snapshot)
        workspace = context.workspace

        if step_name == StepName.ingest:
            if not snapshot.request.input_assets:
                return False, "Carica almeno un file sorgente."
            missing = [
                asset.original_name
                for asset in snapshot.request.input_assets
                if not workspace.upload_path(asset.stored_name).exists()
            ]
            if missing:
                return False, "Alcuni file sorgente non sono disponibili nel workspace."
            return True, ""

        if step_name == StepName.transcription:
            if not context.state.mezzanine_path or not Path(context.state.mezzanine_path).exists():
                return False, "Transcription richiede l'ingest completato."
            if not context.state.audio_path or not Path(context.state.audio_path).exists():
                return False, "Audio canonico mancante. Riesegui ingest."
            return True, ""

        if step_name == StepName.editorial:
            if not context.state.mezzanine_path or not Path(context.state.mezzanine_path).exists():
                return False, "Editorial richiede l'ingest completato."
            transcript = context.state.aligned_transcript or context.state.raw_transcript
            if not transcript or not transcript.segments:
                return False, "Editorial richiede una transcription disponibile."
            return True, ""

        if step_name == StepName.render:
            if not context.state.mezzanine_path or not Path(context.state.mezzanine_path).exists():
                return False, "Render richiede l'ingest completato."
            if not context.state.edl or not context.state.edl.keep_ranges:
                return False, "Render richiede uno step editorial valido."
            if not context.state.render_plan:
                return False, "Render plan mancante. Riesegui editorial."
            if snapshot.request.toggles.render_captioned and not context.state.captions:
                return False, "Render captioned richiede i captions dello step editorial."
            return True, ""

        return False, "Unknown step."

    def existing_artifacts(context: PipelineContext, filenames: tuple[str, ...]) -> list[str]:
        artifacts: list[str] = []
        for filename in filenames:
            artifact = context.workspace.artifact_path(filename)
            if artifact.exists():
                artifacts.append(context.workspace.relative(artifact))
        return artifacts

    def render_outputs_ready(snapshot: JobSnapshot, context: PipelineContext) -> list[str]:
        plan = context.state.render_plan
        if not plan or not plan.edited_master:
            return []

        required = [plan.edited_master]
        if snapshot.request.toggles.render_clean:
            if not plan.clean_output:
                return []
            required.append(plan.clean_output)
        if snapshot.request.toggles.render_captioned:
            if not plan.captioned_output:
                return []
            required.append(plan.captioned_output)

        resolved: list[str] = []
        for relative_path in required:
            target = context.workspace.resolve_relative(relative_path)
            if not target.exists():
                return []
            resolved.append(relative_path)
        return resolved

    def hydrate_snapshot_progress(
        snapshot: JobSnapshot,
        context: PipelineContext,
    ) -> None:
        artifact_map: dict[StepName, tuple[str, ...]] = {
            StepName.ingest: ("01_media_probe.json",),
            StepName.transcription: (
                "02_vad_segments.json",
                "03_transcript_raw.json",
                "04_transcript_aligned.json",
            ),
            StepName.editorial: (
                "05_spans_labeled.json",
                "06_edit_decision_list.json",
                "07_caption_display.json",
                "09_render_plan.json",
            ),
            StepName.render: (
                "08_subtitles.ass",
                "09_render_plan.json",
            ),
        }

        for step in snapshot.steps:
            recovered = existing_artifacts(context, artifact_map.get(step.name, ()))
            if recovered:
                logger.debug(
                    "job.artifacts.recovered job_id=%s step=%s artifacts=%s",
                    snapshot.id,
                    step.name.value,
                    recovered,
                )
                step.artifacts = list(dict.fromkeys(step.artifacts + recovered))

        output_paths = render_outputs_ready(snapshot, context)
        if output_paths:
            snapshot.outputs = list(dict.fromkeys(snapshot.outputs + output_paths))

        if snapshot.status == JobStatus.running:
            return

        ingest_ready = (
            bool(context.state.probe_info)
            and bool(context.state.mezzanine_path)
            and Path(context.state.mezzanine_path).exists()
            and bool(context.state.audio_path)
            and Path(context.state.audio_path).exists()
        )
        transcript = context.state.aligned_transcript or context.state.raw_transcript
        transcription_ready = bool(transcript and transcript.segments)
        editorial_ready = bool(
            context.state.edl
            and context.state.render_plan
            and (
                not snapshot.request.toggles.render_captioned
                or context.state.captions
            )
        )

        recovered_completion = {
            StepName.ingest: ingest_ready,
            StepName.transcription: transcription_ready,
            StepName.editorial: editorial_ready,
            StepName.render: bool(output_paths),
        }

        for step in snapshot.steps:
            if step.status == StepStatus.failed:
                continue
            if step.status == StepStatus.pending and recovered_completion.get(step.name, False):
                logger.info(
                    "job.step.recovered job_id=%s step=%s source=workspace_artifacts",
                    snapshot.id,
                    step.name.value,
                )
                step.status = StepStatus.completed
                step.progress = 100

        if all(step.status.value == "completed" for step in snapshot.steps):
            snapshot.status = JobStatus.completed
            snapshot.current_step = None
        elif snapshot.status == JobStatus.completed:
            snapshot.status = JobStatus.pending

    def enrich_snapshot(snapshot: JobSnapshot) -> JobSnapshot:
        enriched = snapshot.model_copy(deep=True)
        context = build_context(enriched)
        hydrate_snapshot_progress(enriched, context)
        for step in enriched.steps:
            can_run, blocked_reason = step_readiness(enriched, step.name, context=context)
            step.can_run = can_run and enriched.status != JobStatus.running
            step.blocked_reason = "Run already in progress." if enriched.status == JobStatus.running else blocked_reason
        return enriched

    frontend_dist = _resolve_frontend_dist()

    if frontend_dist:
        assets_dir = frontend_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/api/config")
    async def get_config():
        return {
            "profiles": [profile.value for profile in RunProfile],
            "execution_modes": [mode.value for mode in ExecutionMode],
            "step_names": [step.value for step in DEFAULT_STEPS],
        }

    @app.get("/api/jobs")
    async def list_jobs():
        logger.debug("api.jobs.list")
        return [enrich_snapshot(snapshot) for snapshot in store.list_jobs()]

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        logger.debug("api.jobs.get job_id=%s", job_id)
        return enrich_snapshot(_require_job(store, job_id))

    @app.delete("/api/jobs/{job_id}")
    async def delete_job(job_id: str):
        snapshot = _require_job(store, job_id)
        if snapshot.status == JobStatus.running:
            logger.warning("api.jobs.delete.denied job_id=%s reason=job_running", job_id)
            raise HTTPException(status_code=409, detail="Cannot delete a running job.")
        logger.info("api.jobs.delete job_id=%s title=%s", job_id, snapshot.title)
        store.delete(job_id)
        return {"deleted": True, "job_id": job_id}

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

        payloads = [(upload.filename or "input.bin", await upload.read()) for upload in files]
        request_model = _build_request_model(payload)
        logger.info(
            "api.jobs.create title=%s profile=%s execution_mode=%s files=%s",
            request_model.title,
            request_model.profile.value,
            request_model.execution_mode.value,
            [name for name, _payload in payloads],
        )
        snapshot = manager.create_from_uploads(request_model, payloads)
        if request_model.execution_mode == ExecutionMode.automatic:
            return enrich_snapshot(manager.start(snapshot.id))
        return enrich_snapshot(store.load(snapshot.id))

    @app.put("/api/jobs/{job_id}/request")
    async def update_job_request(job_id: str, payload: dict[str, Any] = Body(...)):
        snapshot = _require_job(store, job_id)
        snapshot = enrich_snapshot(snapshot)
        if snapshot.status == JobStatus.running:
            logger.warning("api.jobs.request.update.denied job_id=%s reason=job_running", job_id)
            raise HTTPException(
                status_code=409,
                detail="Stop the current run before changing the job configuration.",
            )

        request_model = _build_request_model(payload, existing_request=snapshot.request)
        logger.info(
            "api.jobs.request.update job_id=%s title=%s",
            job_id,
            request_model.title,
        )
        updated = manager.update_request(job_id, request_model)
        return enrich_snapshot(updated)

    @app.put("/api/jobs/{job_id}/transcript")
    async def update_transcript(
        job_id: str,
        payload: dict[str, Any] = Body(...),
        target: Literal["transcription", "alignment"] = Query("transcription"),
    ):
        snapshot = _require_job(store, job_id)
        if snapshot.status == JobStatus.running:
            logger.warning(
                "api.jobs.transcript.update.denied job_id=%s target=%s reason=job_running",
                job_id,
                target,
            )
            raise HTTPException(
                status_code=409,
                detail="Cannot edit transcript while a run is in progress.",
            )

        from fellini.domain.models import TranscriptArtifact

        try:
            transcript = TranscriptArtifact.model_validate(payload)
        except Exception as exc:
            logger.warning(
                "api.jobs.transcript.update.invalid job_id=%s target=%s error=%s",
                job_id,
                target,
                exc,
            )
            raise HTTPException(status_code=400, detail=f"Invalid transcript: {exc}") from exc

        workspace = JobWorkspace(app_settings.jobs_root, job_id)
        logger.info(
            "api.jobs.transcript.update job_id=%s target=%s segments=%s source=%s",
            job_id,
            target,
            len(transcript.segments),
            transcript.source,
        )
        if target == "transcription":
            payload_json = transcript.model_dump_json(indent=2)
            workspace.artifact_path("03_transcript_raw.json").write_text(
                payload_json, encoding="utf-8"
            )
            workspace.artifact_path("04_transcript_aligned.json").write_text(
                payload_json, encoding="utf-8"
            )
        else:
            workspace.artifact_path("04_transcript_aligned.json").write_text(
                transcript.model_dump_json(indent=2), encoding="utf-8"
            )
        return enrich_snapshot(store.load(job_id))

    @app.post("/api/jobs/{job_id}/steps/{step_name}/run")
    async def run_job_step(job_id: str, step_name: StepName):
        snapshot = enrich_snapshot(_require_job(store, job_id))
        _validate_step_run(snapshot, step_name)
        logger.info("api.jobs.step.run job_id=%s step=%s", job_id, step_name.value)
        prepared = manager.start_step(job_id, step_name)
        return enrich_snapshot(prepared)

    @app.get("/jobs/{job_id}/files/{relative_path:path}")
    async def get_job_file(job_id: str, relative_path: str):
        workspace = JobWorkspace(app_settings.jobs_root, job_id)
        try:
            target = workspace.resolve_relative(relative_path)
        except ValueError as exc:
            logger.warning(
                "api.jobs.file.invalid_path job_id=%s path=%s",
                job_id,
                relative_path,
            )
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not target.exists():
            logger.warning(
                "api.jobs.file.not_found job_id=%s path=%s",
                job_id,
                relative_path,
            )
            raise HTTPException(status_code=404, detail="File not found")
        logger.debug("api.jobs.file.get job_id=%s path=%s", job_id, relative_path)
        return FileResponse(target)

    if frontend_dist:
        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str):
            return FileResponse(frontend_dist / "index.html")

    return app

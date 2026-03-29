from __future__ import annotations

import json
from pathlib import Path
from time import perf_counter
from typing import Any, Literal

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from fellini.domain.models import (
    EditorialProject,
    InputAsset,
    JobRequest,
    JobSnapshot,
    JobStatus,
    StepName,
    StepStatus,
    TimelineTrackKind,
    TranscriptArtifact,
)
from fellini.log import configure_logging, get_logger
from fellini.pipeline.context import PipelineContext
from fellini.services.editorial_project import EditorialProjectStore
from fellini.services.job_manager import JobManager
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings, load_settings

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
        base_payload = JobRequest(
            title=payload.get("title", "Nuovo progetto"),
            language=payload.get("language", "it"),
            editorial_notes=payload.get("editorial_notes", ""),
        ).model_dump(mode="json")

    merged_payload = _deep_merge(base_payload, payload)
    if existing_request:
        merged_payload["input_assets"] = base_payload["input_assets"]
    return JobRequest.model_validate(merged_payload)


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
    editorial_projects = EditorialProjectStore(app_settings)
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
    app.state.editorial_projects = editorial_projects

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

    def ensure_editorial_project(snapshot: JobSnapshot):
        context = build_context(snapshot)
        return editorial_projects.ensure(context)

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
            project = editorial_projects.ensure(context)
            if not any(track.kind == TimelineTrackKind.audio for track in project.tracks):
                return False, "Seleziona o crea almeno una audio lane."
            return True, ""

        if step_name == StepName.editorial:
            if not context.state.mezzanine_path or not Path(context.state.mezzanine_path).exists():
                return False, "Editorial richiede l'ingest completato."
            project = editorial_projects.ensure(context)
            story_lane = editorial_projects.story_lane(project)
            story_transcription = editorial_projects.story_lane_transcription(project)
            legacy_transcript = context.state.aligned_transcript or context.state.raw_transcript
            if not story_lane or (not story_transcription and not legacy_transcript):
                return False, "Editorial richiede una story lane trascritta."
            return True, ""

        if step_name == StepName.render:
            project = editorial_projects.ensure(context)
            if not any(clip.enabled for clip in project.clips):
                return False, "Render richiede una timeline con clip attive."
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
                "09_render_plan.json",
            ),
            StepName.render: (
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
        project = editorial_projects.ensure(context)
        story_transcription = editorial_projects.story_lane_transcription(project)
        transcription_ready = story_transcription is not None or bool(
            context.state.aligned_transcript or context.state.raw_transcript
        )
        editorial_ready = bool(context.state.edl and context.state.render_plan)

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

    def sync_story_lane_artifacts(
        *,
        context: PipelineContext,
        transcript: TranscriptArtifact,
        speech_segments: list[dict[str, Any]] | None = None,
    ) -> list[str]:
        artifacts: list[str] = []
        if speech_segments is not None:
            artifacts.append(
                context.save_json_artifact("02_vad_segments.json", {"segments": speech_segments})
            )
        artifacts.append(context.save_json_artifact("03_transcript_raw.json", transcript))
        artifacts.append(context.save_json_artifact("04_transcript_aligned.json", transcript))
        context.state.raw_transcript = transcript
        context.state.aligned_transcript = transcript
        context.save_state()
        return artifacts

    def run_lane_transcription(job_id: str, lane_id: str) -> dict[str, Any]:
        snapshot = enrich_snapshot(_require_job(store, job_id))
        if snapshot.status == JobStatus.running:
            raise HTTPException(status_code=409, detail="A run is already in progress for this job.")

        context = build_context(snapshot)
        project = editorial_projects.ensure(context)
        lane = next((track for track in project.tracks if track.id == lane_id), None)
        if not lane or lane.kind != TimelineTrackKind.audio:
            raise HTTPException(status_code=404, detail="Audio lane not found.")

        store.invalidate_workspace_from_step(job_id, StepName.transcription)
        store.reset_from_step(job_id, StepName.transcription)
        store.mark_running(job_id)
        store.begin_step(job_id, StepName.transcription, f"Transcribing audio lane {lane.name}")

        bounce_path = context.workspace.temp_path(f"lane_{lane_id}_bounce.wav")
        try:
            store.update_step_progress(job_id, StepName.transcription, 15, "Bounce della audio lane")
            context.ffmpeg.mix_audio_lane(
                workspace_root=context.workspace.job_dir,
                project=project,
                track_id=lane_id,
                target=bounce_path,
            )

            store.update_step_progress(job_id, StepName.transcription, 45, "Trascrizione della lane")
            speech_segments, transcript = context.transcriber.transcribe(
                bounce_path,
                context.request.transcription,
                context.request.language,
            )

            store.update_step_progress(job_id, StepName.transcription, 70, "Allineamento della lane")
            aligned = context.aligner.align(
                bounce_path,
                transcript,
                context.request.transcription,
                context.request.language,
                context.request.toggles.use_whisperx,
            )
            saved_project = editorial_projects.set_lane_transcription(
                context.workspace,
                project=project,
                lane_id=lane_id,
                transcript=aligned,
                source_audio_path=context.workspace.relative(bounce_path),
            )

            artifacts = [context.workspace.relative(context.workspace.editorial_project_path)]
            story_lane = editorial_projects.story_lane(saved_project)
            if story_lane and story_lane.id == lane_id:
                artifacts.extend(
                    sync_story_lane_artifacts(
                        context=context,
                        transcript=aligned,
                        speech_segments=[segment.model_dump(mode="json") for segment in speech_segments],
                    )
                )

            store.update_step_progress(job_id, StepName.transcription, 100, "Transcription completata")
            store.complete_step(
                job_id,
                StepName.transcription,
                message=f"Audio lane {lane.name} transcribed.",
                artifacts=artifacts,
            )

            latest = enrich_snapshot(store.load(job_id))
            if all(step.status.value == "completed" for step in latest.steps):
                store.mark_completed(job_id, latest.outputs)
            else:
                store.mark_pending(job_id)
            return {
                "job": enrich_snapshot(store.load(job_id)),
                "project": editorial_projects.load(context.workspace),
            }
        except Exception as exc:
            store.fail_step(job_id, StepName.transcription, str(exc))
            store.mark_failed(job_id, str(exc))
            raise

    frontend_dist = _resolve_frontend_dist()

    if frontend_dist:
        assets_dir = frontend_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

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
        files: list[UploadFile] | None = File(None),
    ):
        try:
            payload = json.loads(job_payload)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid job payload.") from exc

        request_model = _build_request_model(payload)
        payloads = [
            (upload.filename or "input.bin", await upload.read())
            for upload in (files or [])
        ]
        logger.info(
            "api.jobs.create title=%s files=%s",
            request_model.title,
            [name for name, _payload in payloads],
        )
        snapshot = (
            manager.create_from_uploads(request_model, payloads)
            if payloads
            else manager.create_job(request_model)[0]
        )
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
        context = build_context(snapshot)
        project = editorial_projects.ensure(context)
        story_lane = editorial_projects.story_lane(project)
        if story_lane:
            editorial_projects.set_lane_transcription(
                workspace,
                project=project,
                lane_id=story_lane.id,
                transcript=transcript,
                source_audio_path=context.workspace.relative(context.workspace.temp_path("audio_16k_mono.wav")),
            )
        return enrich_snapshot(store.load(job_id))

    @app.get("/api/jobs/{job_id}/editorial-project")
    async def get_editorial_project(job_id: str):
        snapshot = _require_job(store, job_id)
        project = ensure_editorial_project(snapshot)
        return project

    @app.put("/api/jobs/{job_id}/editorial-project")
    async def update_editorial_project(job_id: str, payload: dict[str, Any] = Body(...)):
        snapshot = _require_job(store, job_id)
        if snapshot.status == JobStatus.running:
            raise HTTPException(status_code=409, detail="Cannot edit the project while a run is in progress.")
        try:
            project = EditorialProject.model_validate(payload)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid editorial project: {exc}") from exc

        story_count = sum(
            1
            for track in project.tracks
            if track.kind == TimelineTrackKind.audio and track.role and track.role.value == "story"
        )
        if story_count > 1:
            raise HTTPException(status_code=400, detail="Only one audio lane can be marked as story.")
        enabled_clips = [clip for clip in project.clips if clip.enabled]
        for track in project.tracks:
            track_clips = sorted(
                (clip for clip in enabled_clips if clip.track_id == track.id),
                key=lambda clip: (clip.start, clip.end, clip.id),
            )
            previous_end = 0.0
            previous_clip_id: str | None = None
            for clip in track_clips:
                if clip.start < previous_end - 1e-6:
                    detail = f"Track {track.name} has overlapping clips."
                    if previous_clip_id:
                        detail = (
                            f"Track {track.name} has overlapping clips: "
                            f"{previous_clip_id} overlaps {clip.id}."
                        )
                    raise HTTPException(status_code=400, detail=detail)
                previous_end = max(previous_end, clip.end)
                previous_clip_id = clip.id
        workspace = JobWorkspace(app_settings.jobs_root, job_id)
        try:
            saved = editorial_projects.save_with_revision_check(workspace, project)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return saved

    @app.post("/api/jobs/{job_id}/assets")
    async def upload_editorial_asset(job_id: str, file: UploadFile = File(...)):
        snapshot = _require_job(store, job_id)
        if snapshot.status == JobStatus.running:
            raise HTTPException(status_code=409, detail="Cannot upload assets while a run is in progress.")
        workspace = JobWorkspace(app_settings.jobs_root, job_id)
        payload = await file.read()
        original_name = file.filename or "asset.bin"

        if not snapshot.request.input_assets:
            source_asset = manager.save_upload_to_workspace(
                workspace,
                original_name=original_name,
                payload=payload,
            )
            store.update(
                job_id,
                lambda current: current.request.input_assets.append(
                    InputAsset(
                        original_name=source_asset.original_name,
                        stored_name=source_asset.stored_name,
                        media_kind=source_asset.media_kind,
                    )
                ),
            )
            manager.run_step_sync(job_id, StepName.ingest)
            snapshot = _require_job(store, job_id)
            project = ensure_editorial_project(snapshot)
            asset = next(
                (item for item in project.assets if item.origin == "ingest"),
                None,
            )
            if asset is None:
                raise HTTPException(status_code=500, detail="Failed to bootstrap the source asset.")
            return {"asset": asset, "project": project}

        if not editorial_projects.exists(workspace):
            ensure_editorial_project(snapshot)
        project, asset, _stored_name = editorial_projects.add_asset(
            workspace,
            original_name=original_name,
            payload=payload,
        )
        return {"asset": asset, "project": project}

    @app.post("/api/jobs/{job_id}/audio-lanes/{lane_id}/transcribe")
    async def transcribe_audio_lane(job_id: str, lane_id: str):
        try:
            return run_lane_transcription(job_id, lane_id)
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception(
                "api.jobs.audio_lane.transcribe.failed job_id=%s lane_id=%s error=%s",
                job_id,
                lane_id,
                exc,
            )
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.post("/api/jobs/{job_id}/steps/{step_name}/run")
    async def run_job_step(job_id: str, step_name: StepName):
        snapshot = enrich_snapshot(_require_job(store, job_id))
        _validate_step_run(snapshot, step_name)
        logger.info("api.jobs.step.run job_id=%s step=%s", job_id, step_name.value)
        if step_name == StepName.transcription:
            project = ensure_editorial_project(snapshot)
            story_lane = editorial_projects.story_lane(project)
            if not story_lane:
                raise HTTPException(status_code=409, detail="Select an audio lane before running transcription.")
            return run_lane_transcription(job_id, story_lane.id)["job"]
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

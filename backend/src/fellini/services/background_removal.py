from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from fellini.domain.models import (
    AssetBackgroundRemoval,
    AssetProcessingStatus,
    AssetVariantKind,
    EditorialProject,
    JobStatus,
    ProjectAsset,
    ProjectAssetKind,
    utcnow,
)
from fellini.log import get_logger
from fellini.services.asset_previews import AssetPreviewService
from fellini.services.editorial_project import EditorialProjectStore
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings, project_root

logger = get_logger(__name__)


class BackgroundRemovalError(RuntimeError):
    pass


class BackgroundRemovalService:
    DEFAULT_MAX_SIZE = 256
    DEFAULT_WARMUP = 1
    DEFAULT_SAM2_MODEL = "facebook/sam2.1-hiera-small"
    DEFAULT_SAM2_DEVICE = "mps"
    DEFAULT_PERSON_DETECTOR_DEVICE = "cpu"
    PROGRESS_POLL_SECONDS = 0.8

    def __init__(
        self,
        settings: AppSettings,
        *,
        store: JobStore,
        editorial_projects: EditorialProjectStore,
        asset_previews: AssetPreviewService,
    ) -> None:
        self.settings = settings
        self.store = store
        self.editorial_projects = editorial_projects
        self.asset_previews = asset_previews
        self._lock = threading.Lock()
        self._active_assets: set[tuple[str, str]] = set()

    def start(self, job_id: str, asset_id: str) -> EditorialProject:
        snapshot = self.store.load(job_id)
        if snapshot.status == JobStatus.running:
            msg = "Attendi la fine del job corrente prima di avviare lo scontorno."
            raise BackgroundRemovalError(msg)

        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        workspace.bootstrap()
        project = self._load_project(workspace)
        asset = self._require_video_asset(project, asset_id)
        if self._is_active(job_id, asset_id):
            msg = "Lo scontorno di questo asset è già in esecuzione."
            raise BackgroundRemovalError(msg)

        background = self._background_removal_for(asset)
        if background.status == AssetProcessingStatus.running:
            msg = "Lo scontorno di questo asset è già in esecuzione."
            raise BackgroundRemovalError(msg)

        source_path = background.original_path or asset.path
        run_dir = (
            workspace.artifacts_dir
            / "background-removal"
            / asset.id
            / datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        )
        progress_path = run_dir / "progress.json"

        updated_background = background.model_copy(
            update={
                "status": AssetProcessingStatus.running,
                "phase": "queued",
                "progress": 0.0,
                "message": "Preparazione scontorno video",
                "error": None,
                "original_path": source_path,
                "progress_path": workspace.relative(progress_path),
                "updated_at": utcnow(),
            },
            deep=True,
        )

        updated_project = self._patch_asset(
            project,
            asset_id,
            background_removal=updated_background,
        )
        saved = self.editorial_projects.save(workspace, updated_project)
        self._mark_active(job_id, asset_id)
        self.store.append_log(job_id, f"Background removal queued for asset {asset.label}.")

        thread = threading.Thread(
            target=self._run_background_removal,
            args=(job_id, asset_id, source_path, run_dir),
            daemon=True,
            name=f"background-removal-{job_id[:8]}-{asset_id}",
        )
        thread.start()
        return self.asset_previews.enrich_project(workspace, saved)

    def set_active_variant(
        self,
        job_id: str,
        asset_id: str,
        variant: AssetVariantKind,
    ) -> EditorialProject:
        snapshot = self.store.load(job_id)
        if snapshot.status == JobStatus.running:
            msg = "Attendi la fine del job corrente prima di cambiare variante."
            raise BackgroundRemovalError(msg)

        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        workspace.bootstrap()
        project = self._load_project(workspace)
        asset = self._require_video_asset(project, asset_id)
        background = self._background_removal_for(asset)

        if variant == AssetVariantKind.cutout and not background.cutout_path:
            msg = "Non esiste ancora una variante scontornata disponibile."
            raise BackgroundRemovalError(msg)
        if variant == AssetVariantKind.original and not background.original_path:
            msg = "L'asset non ha un percorso originale registrato."
            raise BackgroundRemovalError(msg)

        target_path = (
            background.cutout_path
            if variant == AssetVariantKind.cutout
            else background.original_path
        )
        if not target_path:
            msg = "Variante non disponibile."
            raise BackgroundRemovalError(msg)

        updated_background = background.model_copy(
            update={
                "active_variant": variant,
                "message": (
                    "Variante scontornata attiva"
                    if variant == AssetVariantKind.cutout
                    else "Variante originale attiva"
                ),
                "updated_at": utcnow(),
            },
            deep=True,
        )
        updated_project = self._patch_asset(
            project,
            asset_id,
            background_removal=updated_background,
        )
        self.editorial_projects.save(workspace, updated_project)
        enriched = self.asset_previews.enrich_project(workspace, self.editorial_projects.load(workspace))
        self.store.append_log(job_id, f"Background removal variant set to {variant.value} for asset {asset.label}.")
        return enriched

    def _run_background_removal(
        self,
        job_id: str,
        asset_id: str,
        source_path: str,
        run_dir: Path,
    ) -> None:
        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        workspace.bootstrap()
        run_dir.mkdir(parents=True, exist_ok=True)
        progress_path = run_dir / "progress.json"
        benchmark_path = run_dir / "benchmark.json"
        log_path = run_dir / "runner.log"

        source_abspath = workspace.resolve_relative(source_path)
        command = [
            sys.executable,
            str(project_root() / "backend" / "scripts" / "run_matanyone_benchmark.py"),
            "--video",
            str(source_abspath),
            "--output-dir",
            str(run_dir),
            "--matanyone-root",
            str(project_root() / "backend" / "third_party" / "MatAnyone2"),
            "--mask-generator",
            "sam2",
            "--sam2-model",
            self.DEFAULT_SAM2_MODEL,
            "--sam2-device",
            self.DEFAULT_SAM2_DEVICE,
            "--person-detector-device",
            self.DEFAULT_PERSON_DETECTOR_DEVICE,
            "--max-size",
            str(self.DEFAULT_MAX_SIZE),
            "--warmup",
            str(self.DEFAULT_WARMUP),
            "--enable-mps-fallback",
            "--preserve-audio",
            "--make-compare",
        ]
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"

        logger.info(
            "background_removal.start job_id=%s asset_id=%s source=%s run_dir=%s",
            job_id,
            asset_id,
            source_abspath,
            run_dir,
        )

        try:
            with log_path.open("w", encoding="utf-8") as log_handle:
                process = subprocess.Popen(
                    command,
                    cwd=project_root(),
                    env=env,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                while True:
                    self._sync_progress(job_id, asset_id, progress_path)
                    return_code = process.poll()
                    if return_code is not None:
                        break
                    time.sleep(self.PROGRESS_POLL_SECONDS)

            self._sync_progress(job_id, asset_id, progress_path, force=True)
            if return_code != 0:
                msg = self._tail_file(log_path) or "MatAnyone exited with a non-zero status."
                raise BackgroundRemovalError(msg)

            benchmark = json.loads(benchmark_path.read_text(encoding="utf-8"))
            cutout_path = benchmark.get("foreground_with_audio_path") or benchmark.get("foreground_path")
            if not isinstance(cutout_path, str) or not cutout_path:
                msg = "MatAnyone completed without producing a foreground output."
                raise BackgroundRemovalError(msg)

            alpha_path = benchmark.get("alpha_path")
            compare_path = benchmark.get("compare_path")
            relative_cutout_path = workspace.relative(Path(cutout_path))
            relative_alpha_path = (
                workspace.relative(Path(alpha_path))
                if isinstance(alpha_path, str) and Path(alpha_path).exists()
                else None
            )
            relative_compare_path = (
                workspace.relative(Path(compare_path))
                if isinstance(compare_path, str) and Path(compare_path).exists()
                else None
            )
            relative_benchmark_path = workspace.relative(benchmark_path)
            relative_progress_path = workspace.relative(progress_path)

            project = self._load_project(workspace)
            asset = self._require_video_asset(project, asset_id)
            background = self._background_removal_for(asset)
            updated_background = background.model_copy(
                update={
                    "status": AssetProcessingStatus.completed,
                    "active_variant": AssetVariantKind.cutout,
                    "phase": "completed",
                    "progress": 1.0,
                    "message": "Scontorno completato",
                    "error": None,
                    "original_path": background.original_path or source_path,
                    "cutout_path": relative_cutout_path,
                    "alpha_path": relative_alpha_path,
                    "compare_path": relative_compare_path,
                    "benchmark_path": relative_benchmark_path,
                    "progress_path": relative_progress_path,
                    "updated_at": utcnow(),
                },
                deep=True,
            )
            updated_project = self._patch_asset(
                project,
                asset_id,
                background_removal=updated_background,
            )
            saved = self.editorial_projects.save(workspace, updated_project)
            self.asset_previews.invalidate_asset_variants(
                workspace,
                asset,
                [AssetVariantKind.cutout],
            )
            self.asset_previews.enrich_project(workspace, saved)
            self.store.append_log(
                job_id,
                f"Background removal completed for asset {asset.label}.",
            )
        except Exception as exc:
            logger.exception(
                "background_removal.failed job_id=%s asset_id=%s error=%s",
                job_id,
                asset_id,
                exc,
            )
            self._mark_failed(job_id, asset_id, str(exc))
            self.store.append_log(job_id, f"Background removal failed for asset {asset_id}: {exc}")
        finally:
            self._clear_active(job_id, asset_id)

    def _sync_progress(
        self,
        job_id: str,
        asset_id: str,
        progress_path: Path,
        *,
        force: bool = False,
    ) -> None:
        if not progress_path.exists():
            return
        try:
            payload = json.loads(progress_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return

        phase = str(payload.get("phase") or "running")
        ratio = payload.get("ratio")
        explicit_progress = float(ratio) if isinstance(ratio, (float, int)) else None
        progress_value = explicit_progress if explicit_progress is not None else self._phase_progress(phase)
        message = str(payload.get("message") or "Scontorno video in corso")
        status = str(payload.get("status") or "running")

        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        project = self._load_project(workspace)
        asset = self.editorial_projects.asset_by_id(project, asset_id)
        if asset is None:
            return
        background = self._background_removal_for(asset)
        next_status = (
            AssetProcessingStatus.completed
            if status == "completed"
            else AssetProcessingStatus.running
        )

        if (
            not force
            and background.status == next_status
            and background.phase == phase
            and abs(background.progress - progress_value) < 0.001
            and background.message == message
        ):
            return

        updated_background = background.model_copy(
            update={
                "status": next_status,
                "phase": phase,
                "progress": progress_value,
                "message": message,
                "updated_at": utcnow(),
            },
            deep=True,
        )
        updated_project = self._patch_asset(project, asset_id, background_removal=updated_background)
        self.editorial_projects.save(workspace, updated_project)

    def _mark_failed(self, job_id: str, asset_id: str, error: str) -> None:
        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        project = self._load_project(workspace)
        asset = self.editorial_projects.asset_by_id(project, asset_id)
        if asset is None:
            return
        background = self._background_removal_for(asset)
        updated_background = background.model_copy(
            update={
                "status": AssetProcessingStatus.failed,
                "phase": "failed",
                "message": "Scontorno fallito",
                "error": error,
                "updated_at": utcnow(),
            },
            deep=True,
        )
        updated_project = self._patch_asset(project, asset_id, background_removal=updated_background)
        self.editorial_projects.save(workspace, updated_project)

    def _background_removal_for(self, asset: ProjectAsset) -> AssetBackgroundRemoval:
        current = asset.background_removal
        if current is not None:
            return current.model_copy(deep=True)
        return AssetBackgroundRemoval(
            original_path=asset.path,
            active_variant=AssetVariantKind.original,
        )

    def _patch_asset(
        self,
        project: EditorialProject,
        asset_id: str,
        *,
        background_removal: AssetBackgroundRemoval,
    ) -> EditorialProject:
        updated = project.model_copy(deep=True)
        for asset in updated.assets:
            if asset.id == asset_id:
                asset.background_removal = background_removal
                break
        return updated

    def _load_project(self, workspace: JobWorkspace) -> EditorialProject:
        if not self.editorial_projects.exists(workspace):
            msg = "Editorial project not initialized for this job."
            raise BackgroundRemovalError(msg)
        return self.editorial_projects.load(workspace)

    def _require_video_asset(self, project: EditorialProject, asset_id: str) -> ProjectAsset:
        asset = self.editorial_projects.asset_by_id(project, asset_id)
        if asset is None:
            msg = "Asset not found."
            raise BackgroundRemovalError(msg)
        if asset.kind != ProjectAssetKind.video:
            msg = "Background removal is available only for video assets."
            raise BackgroundRemovalError(msg)
        return asset

    def _is_active(self, job_id: str, asset_id: str) -> bool:
        with self._lock:
            return (job_id, asset_id) in self._active_assets

    def _mark_active(self, job_id: str, asset_id: str) -> None:
        with self._lock:
            self._active_assets.add((job_id, asset_id))

    def _clear_active(self, job_id: str, asset_id: str) -> None:
        with self._lock:
            self._active_assets.discard((job_id, asset_id))

    @staticmethod
    def _phase_progress(phase: str) -> float:
        phase_map = {
            "setup": 0.02,
            "queued": 0.03,
            "preparing_input": 0.08,
            "normalizing_orientation": 0.14,
            "extracting_first_frame": 0.20,
            "generating_mask": 0.32,
            "loading_checkpoint": 0.38,
            "loading_model": 0.44,
            "reading_input": 0.52,
            "preprocessing_frames": 0.58,
            "preparing_mask": 0.64,
            "encoding_outputs": 0.94,
            "muxing_audio": 0.97,
            "building_compare": 0.99,
            "completed": 1.0,
            "failed": 1.0,
        }
        if phase == "inferencing":
            return 0.75
        return phase_map.get(phase, 0.0)

    @staticmethod
    def _tail_file(path: Path, *, max_chars: int = 4000) -> str:
        if not path.exists():
            return ""
        text = path.read_text(encoding="utf-8", errors="replace")
        return text[-max_chars:].strip()

from __future__ import annotations

import json
import math
import threading
from pathlib import Path

from fellini.adapters.ffmpeg import FFmpegAdapter
from fellini.domain.models import (
    AssetPreviewBundle,
    AssetPreviewEntry,
    AssetPreviewStatus,
    EditorialProject,
    JobSnapshot,
    JobStatus,
    ProjectAsset,
)
from fellini.log import get_logger
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings

logger = get_logger(__name__)
FILMSTRIP_VERSION = 3
WAVEFORM_VERSION = 1
FILMSTRIP_INTERVAL_SECONDS = 2.0
FILMSTRIP_CELL_HEIGHT = 72
FILMSTRIP_FALLBACK_CELL_WIDTH = 96
FILMSTRIP_MIN_CELL_WIDTH = 40
FILMSTRIP_MAX_CELL_WIDTH = 160
FILMSTRIP_MAX_FRAMES = 120
WAVEFORM_BUCKETS_PER_SECOND = 32
WAVEFORM_MIN_BUCKETS = 1024
WAVEFORM_MAX_BUCKETS = 32768
WAVEFORM_SAMPLE_RATE = 8000


class AssetPreviewService:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.ffmpeg = FFmpegAdapter(settings)
        self._lock = threading.Lock()
        self._active_assets: set[tuple[str, str]] = set()

    def enrich_project(self, workspace: JobWorkspace, project: EditorialProject) -> EditorialProject:
        state = self.load_state(workspace)
        changed = False
        enriched = project.model_copy(deep=True)
        for asset in enriched.assets:
            bundle = self._normalized_bundle(workspace, asset, state.get(asset.id))
            if state.get(asset.id) != bundle:
                state[asset.id] = bundle
                changed = True
            asset.preview = bundle
        if changed:
            self.save_state(workspace, state)
        return enriched

    def request_previews(
        self,
        snapshot: JobSnapshot,
        project: EditorialProject,
        asset_ids: list[str],
    ) -> EditorialProject:
        workspace = JobWorkspace(self.settings.jobs_root, snapshot.id)
        workspace.bootstrap()
        if snapshot.status == JobStatus.running:
            return self.enrich_project(workspace, project)

        assets_by_id = {asset.id: asset for asset in project.assets}
        selected_assets = [
            assets_by_id[asset_id]
            for asset_id in dict.fromkeys(asset_ids)
            if asset_id in assets_by_id
        ]
        if not selected_assets:
            return self.enrich_project(workspace, project)

        state = self.load_state(workspace)
        changed = False
        launch_assets: list[ProjectAsset] = []
        for asset in selected_assets:
            bundle = self._normalized_bundle(workspace, asset, state.get(asset.id))
            if self._bundle_needs_generation(asset, bundle):
                with self._lock:
                    active_key = (snapshot.id, asset.id)
                    is_active = active_key in self._active_assets
                    if not is_active:
                        self._active_assets.add(active_key)
                if not is_active:
                    bundle = self._mark_generating(asset, bundle)
                    launch_assets.append(asset.model_copy(deep=True))
                    changed = True
            state[asset.id] = bundle

        if changed:
            self.save_state(workspace, state)

        for asset in launch_assets:
            self._launch_generation(snapshot.id, asset)
        return self.enrich_project(workspace, project)

    def load_state(self, workspace: JobWorkspace) -> dict[str, AssetPreviewBundle]:
        path = workspace.asset_preview_state_path
        if not path.exists():
            return {}
        payload = json.loads(path.read_text(encoding="utf-8"))
        return {
            asset_id: AssetPreviewBundle.model_validate(value)
            for asset_id, value in payload.items()
        }

    def save_state(self, workspace: JobWorkspace, state: dict[str, AssetPreviewBundle]) -> None:
        workspace.project_dir.mkdir(parents=True, exist_ok=True)
        workspace.asset_preview_state_path.write_text(
            json.dumps(
                {
                    asset_id: bundle.model_dump(mode="json", exclude_none=True)
                    for asset_id, bundle in state.items()
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    def _launch_generation(self, job_id: str, asset: ProjectAsset) -> None:
        thread = threading.Thread(
            target=self._generate_asset_previews,
            args=(job_id, asset),
            daemon=True,
            name=f"preview-{job_id[:8]}-{asset.id}",
        )
        thread.start()

    def _generate_asset_previews(self, job_id: str, asset: ProjectAsset) -> None:
        workspace = JobWorkspace(self.settings.jobs_root, job_id)
        workspace.bootstrap()
        active_key = (job_id, asset.id)
        try:
            source = workspace.resolve_relative(asset.path)
            state = self.load_state(workspace)
            bundle = self._normalized_bundle(workspace, asset, state.get(asset.id))
            if asset.kind == "video" and self._entry_needs_generation(bundle.filmstrip):
                try:
                    bundle.filmstrip = self._generate_filmstrip_preview(workspace, source, asset)
                except Exception as exc:
                    logger.exception(
                        "asset_preview.filmstrip.failed job_id=%s asset_id=%s error=%s",
                        job_id,
                        asset.id,
                        exc,
                    )
                    bundle.filmstrip = self._failed_entry(FILMSTRIP_VERSION, exc)
            if (asset.kind == "audio" or asset.has_audio) and self._entry_needs_generation(bundle.waveform):
                try:
                    bundle.waveform = self._generate_waveform_preview(workspace, source, asset)
                except Exception as exc:
                    logger.exception(
                        "asset_preview.waveform.failed job_id=%s asset_id=%s error=%s",
                        job_id,
                        asset.id,
                        exc,
                    )
                    bundle.waveform = self._failed_entry(WAVEFORM_VERSION, exc)
            state[asset.id] = bundle
            self.save_state(workspace, state)
        except Exception as exc:
            logger.exception(
                "asset_preview.generate.failed job_id=%s asset_id=%s error=%s",
                job_id,
                asset.id,
                exc,
            )
            state = self.load_state(workspace)
            bundle = self._normalized_bundle(workspace, asset, state.get(asset.id))
            if asset.kind == "video" and self._entry_needs_generation(bundle.filmstrip):
                bundle.filmstrip = self._failed_entry(FILMSTRIP_VERSION, exc)
            if (asset.kind == "audio" or asset.has_audio) and self._entry_needs_generation(bundle.waveform):
                bundle.waveform = self._failed_entry(WAVEFORM_VERSION, exc)
            state[asset.id] = bundle
            self.save_state(workspace, state)
        finally:
            with self._lock:
                self._active_assets.discard(active_key)

    def _generate_filmstrip_preview(
        self,
        workspace: JobWorkspace,
        source: Path,
        asset: ProjectAsset,
    ) -> AssetPreviewEntry:
        cell_width = self._filmstrip_cell_width(asset)
        target = workspace.preview_artifact_path(f"{asset.id}.filmstrip.png")
        meta = self.ffmpeg.generate_filmstrip(
            source,
            target,
            duration_seconds=asset.duration,
            interval_seconds=FILMSTRIP_INTERVAL_SECONDS,
            max_frames=FILMSTRIP_MAX_FRAMES,
            cell_width=cell_width,
            cell_height=FILMSTRIP_CELL_HEIGHT,
        )
        return AssetPreviewEntry(
            status=AssetPreviewStatus.ready,
            resource_path=workspace.relative(target),
            version=FILMSTRIP_VERSION,
            error=None,
            meta=meta,
        )

    def _generate_waveform_preview(
        self,
        workspace: JobWorkspace,
        source: Path,
        asset: ProjectAsset,
    ) -> AssetPreviewEntry:
        bucket_count = max(
            WAVEFORM_MIN_BUCKETS,
            min(
                WAVEFORM_MAX_BUCKETS,
                math.ceil(max(asset.duration, 0.01) * WAVEFORM_BUCKETS_PER_SECOND),
            ),
        )
        values = self.ffmpeg.build_waveform_peaks(
            source,
            duration_seconds=asset.duration,
            bucket_count=bucket_count,
            sample_rate=WAVEFORM_SAMPLE_RATE,
        )
        target = workspace.preview_artifact_path(f"{asset.id}.waveform.json")
        target.write_text(
            json.dumps(
                {
                    "version": WAVEFORM_VERSION,
                    "metric": "peak",
                    "channels": 1,
                    "duration": asset.duration,
                    "bucket_count": bucket_count,
                    "values": values,
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        return AssetPreviewEntry(
            status=AssetPreviewStatus.ready,
            resource_path=workspace.relative(target),
            version=WAVEFORM_VERSION,
            error=None,
            meta={
                "metric": "peak",
                "channels": 1,
                "bucket_count": bucket_count,
            },
        )

    def _filmstrip_cell_width(self, asset: ProjectAsset) -> int:
        width = max(asset.width, 0)
        height = max(asset.height, 0)
        if width <= 0 or height <= 0:
            return FILMSTRIP_FALLBACK_CELL_WIDTH
        aspect = width / height
        return max(
            FILMSTRIP_MIN_CELL_WIDTH,
            min(
                FILMSTRIP_MAX_CELL_WIDTH,
                round(FILMSTRIP_CELL_HEIGHT * aspect),
            ),
        )

    def _bundle_needs_generation(
        self,
        asset: ProjectAsset,
        bundle: AssetPreviewBundle,
    ) -> bool:
        if asset.kind == "video" and bundle.filmstrip and bundle.filmstrip.status != AssetPreviewStatus.ready:
            return True
        if (asset.kind == "audio" or asset.has_audio) and bundle.waveform and bundle.waveform.status != AssetPreviewStatus.ready:
            return True
        return False

    def _mark_generating(self, asset: ProjectAsset, bundle: AssetPreviewBundle) -> AssetPreviewBundle:
        updated = bundle.model_copy(deep=True)
        if asset.kind == "video" and self._entry_needs_generation(updated.filmstrip):
            updated.filmstrip = self._generating_entry(FILMSTRIP_VERSION)
        if (asset.kind == "audio" or asset.has_audio) and self._entry_needs_generation(updated.waveform):
            updated.waveform = self._generating_entry(WAVEFORM_VERSION)
        return updated

    def _normalized_bundle(
        self,
        workspace: JobWorkspace,
        asset: ProjectAsset,
        bundle: AssetPreviewBundle | None,
    ) -> AssetPreviewBundle:
        current = bundle.model_copy(deep=True) if bundle else AssetPreviewBundle()
        if asset.kind == "video":
            current.filmstrip = self._normalized_entry(
                workspace,
                current.filmstrip,
                version=FILMSTRIP_VERSION,
            )
        else:
            current.filmstrip = None
        if asset.kind == "audio" or asset.has_audio:
            current.waveform = self._normalized_entry(
                workspace,
                current.waveform,
                version=WAVEFORM_VERSION,
            )
        else:
            current.waveform = None
        return current

    def _normalized_entry(
        self,
        workspace: JobWorkspace,
        entry: AssetPreviewEntry | None,
        *,
        version: int,
    ) -> AssetPreviewEntry:
        if entry is None:
            return AssetPreviewEntry(status=AssetPreviewStatus.missing, version=version)
        current = entry.model_copy(deep=True)
        current.version = version
        if current.status == AssetPreviewStatus.ready:
            if not current.resource_path:
                return AssetPreviewEntry(status=AssetPreviewStatus.missing, version=version)
            try:
                target = workspace.resolve_relative(current.resource_path)
            except ValueError:
                return AssetPreviewEntry(status=AssetPreviewStatus.missing, version=version)
            if not target.exists():
                return AssetPreviewEntry(status=AssetPreviewStatus.missing, version=version)
        return current

    def _entry_needs_generation(self, entry: AssetPreviewEntry | None) -> bool:
        return entry is None or entry.status != AssetPreviewStatus.ready

    def _generating_entry(self, version: int) -> AssetPreviewEntry:
        return AssetPreviewEntry(
            status=AssetPreviewStatus.generating,
            resource_path=None,
            version=version,
            error=None,
            meta={},
        )

    def _failed_entry(self, version: int, exc: Exception) -> AssetPreviewEntry:
        return AssetPreviewEntry(
            status=AssetPreviewStatus.failed,
            resource_path=None,
            version=version,
            error=str(exc),
            meta={},
        )

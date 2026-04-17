from fellini.domain.models import (
    AssetBackgroundRemoval,
    AssetPreviewBundle,
    AssetPreviewEntry,
    AssetPreviewStatus,
    AssetPreviewVariants,
    AssetPreviewVariantKind,
    ProjectAsset,
    ProjectAssetKind,
)
from fellini.services.asset_previews import AssetPreviewService, WAVEFORM_VERSION
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings


def test_normalized_previews_invalidate_old_waveform_versions(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    service = AssetPreviewService(settings)
    workspace = JobWorkspace(settings.projects_root, "job_waveform_preview_version")
    workspace.bootstrap()
    preview_path = workspace.preview_artifact_path("asset_audio", "original", "waveform.json")
    preview_path.write_text("{}", encoding="utf-8")
    asset = ProjectAsset(
        id="asset_audio",
        kind=ProjectAssetKind.audio,
        label="voice.wav",
        path="uploads/voice.wav",
        duration=45.0,
    )

    previews = service._normalized_previews(
        workspace,
        asset,
        AssetPreviewVariants(
            original=AssetPreviewBundle(
                waveform=AssetPreviewEntry(
                    status=AssetPreviewStatus.ready,
                    resource_path=workspace.relative(preview_path),
                    version=WAVEFORM_VERSION - 1,
                )
            )
        ),
    )

    assert previews.original is not None
    assert previews.original.waveform is not None
    assert previews.original.waveform.status == AssetPreviewStatus.missing
    assert previews.original.waveform.version == WAVEFORM_VERSION


def test_generate_waveform_preview_uses_higher_bucket_density(tmp_path, monkeypatch):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    service = AssetPreviewService(settings)
    workspace = JobWorkspace(settings.projects_root, "job_waveform_density")
    workspace.bootstrap()
    source = workspace.temp_path("voice.wav")
    source.write_bytes(b"audio")
    asset = ProjectAsset(
        id="asset_audio",
        kind=ProjectAssetKind.audio,
        label="voice.wav",
        path="uploads/voice.wav",
        duration=45.0,
    )
    call: dict[str, int | float | str] = {}

    def fake_build_waveform_peaks(source_path, *, duration_seconds, bucket_count, sample_rate):
        call["source"] = str(source_path)
        call["duration_seconds"] = duration_seconds
        call["bucket_count"] = bucket_count
        call["sample_rate"] = sample_rate
        return [128] * bucket_count

    monkeypatch.setattr(service.ffmpeg, "build_waveform_peaks", fake_build_waveform_peaks)

    entry = service._generate_waveform_preview(
        workspace,
        source,
        asset,
        AssetPreviewVariantKind.original,
    )

    assert entry.status == AssetPreviewStatus.ready
    assert call == {
        "source": str(source),
        "duration_seconds": 45.0,
        "bucket_count": 23040,
        "sample_rate": 8000,
    }


def test_normalized_previews_maps_legacy_cutout_to_mask_without_waveform(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    service = AssetPreviewService(settings)
    workspace = JobWorkspace(settings.projects_root, "job_mask_preview")
    workspace.bootstrap()
    filmstrip_path = workspace.preview_artifact_path("asset_video", "mask", "filmstrip.png")
    waveform_path = workspace.preview_artifact_path("asset_video", "mask", "waveform.json")
    filmstrip_path.write_bytes(b"filmstrip")
    waveform_path.write_text("{}", encoding="utf-8")
    asset = ProjectAsset(
        id="asset_video",
        kind=ProjectAssetKind.video,
        label="clip.mp4",
        path="uploads/clip.mp4",
        duration=12.0,
        width=1920,
        height=1080,
        background_removal=AssetBackgroundRemoval(
            original_path="uploads/clip.mp4",
            mask_video_path="jobs/background-removal/asset_video/mask.mp4",
        ),
    )

    previews = service._normalized_previews(
        workspace,
        asset,
        {
            "cutout": {
                "filmstrip": {
                    "status": "ready",
                    "resource_path": workspace.relative(filmstrip_path),
                    "version": 3,
                },
                "waveform": {
                    "status": "ready",
                    "resource_path": workspace.relative(waveform_path),
                    "version": WAVEFORM_VERSION,
                },
            }
        },
    )

    assert previews.mask is not None
    assert previews.mask.filmstrip is not None
    assert previews.mask.filmstrip.status == AssetPreviewStatus.ready
    assert previews.mask.waveform is None

from fellini.domain.models import (
    AssetPreviewBundle,
    AssetPreviewEntry,
    AssetPreviewStatus,
    AssetPreviewVariants,
    AssetVariantKind,
    ProjectAsset,
    ProjectAssetKind,
)
from fellini.services.asset_previews import AssetPreviewService, WAVEFORM_VERSION
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings


def test_normalized_previews_invalidate_old_waveform_versions(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    service = AssetPreviewService(settings)
    workspace = JobWorkspace(settings.jobs_root, "job_waveform_preview_version")
    workspace.bootstrap()
    preview_path = workspace.preview_artifact_path("asset_audio.original.waveform.json")
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
    workspace = JobWorkspace(settings.jobs_root, "job_waveform_density")
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
        AssetVariantKind.original,
    )

    assert entry.status == AssetPreviewStatus.ready
    assert call == {
        "source": str(source),
        "duration_seconds": 45.0,
        "bucket_count": 23040,
        "sample_rate": 8000,
    }

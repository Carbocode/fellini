from pathlib import Path

from fellini.services.asset_previews import AssetPreviewService
from fellini.services.background_removal import BackgroundRemovalService
from fellini.services.editorial_project import EditorialProjectStore
from fellini.services.job_store import JobStore
from fellini.settings import AppSettings


def test_background_removal_uses_auto_device_for_sam2():
    assert BackgroundRemovalService.DEFAULT_SAM2_DEVICE == "auto"


def test_background_removal_runner_command_skips_compare_generation(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    service = BackgroundRemovalService(
        settings,
        store=JobStore(settings),
        editorial_projects=EditorialProjectStore(settings),
        asset_previews=AssetPreviewService(settings),
    )

    command = service._runner_command(Path("/tmp/source.mp4"), Path("/tmp/output"))

    assert "--preserve-audio" in command
    assert "--make-compare" not in command

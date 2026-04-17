from fellini.domain.models import JobRequest, StepName, StepStatus
from fellini.services.job_store import JobStore
from fellini.settings import AppSettings


def test_update_step_progress_persists_progress_and_message(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = JobStore(settings)
    snapshot, _workspace = store.create_job(JobRequest())

    store.begin_step(snapshot.id, StepName.ingest, "starting")
    updated = store.update_step_progress(
        snapshot.id,
        StepName.ingest,
        42,
        "Probing media",
    )

    step = updated.step(StepName.ingest)
    assert step.status == StepStatus.running
    assert step.progress == 42
    assert step.message == "Probing media"


def test_update_step_progress_clamps_percentage(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = JobStore(settings)
    snapshot, _workspace = store.create_job(JobRequest())

    store.begin_step(snapshot.id, StepName.ingest, "starting")
    updated = store.update_step_progress(
        snapshot.id,
        StepName.ingest,
        140,
        "Done soon",
    )

    assert updated.step(StepName.ingest).progress == 100


def test_invalidate_workspace_from_transcription_clears_temp_and_transcription_bounces(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = JobStore(settings)
    snapshot, workspace = store.create_job(JobRequest())

    workspace.temp_path("scratch.tmp").write_text("tmp", encoding="utf-8")
    bounce = workspace.transcription_path("asset_example", "clip_example_bounce.wav")
    bounce.write_bytes(b"audio")

    store.invalidate_workspace_from_step(snapshot.id, StepName.transcription)

    assert list(workspace.temp_dir.iterdir()) == []
    assert bounce.exists() is False

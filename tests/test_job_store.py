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

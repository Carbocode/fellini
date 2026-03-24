import json

from fastapi.testclient import TestClient

from fellini.app import create_app
from fellini.domain.models import StepName
from fellini.settings import AppSettings


def test_api_config_and_jobs(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    config = client.get("/api/config")
    assert config.status_code == 200
    assert "profiles" in config.json()
    assert "balanced" in config.json()["profiles"]

    jobs = client.get("/api/jobs")
    assert jobs.status_code == 200
    assert jobs.json() == []


def test_custom_job_update_and_step_run_api(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    payload = {
        "title": "Debug job",
        "profile": "custom",
        "execution_mode": "step_by_step",
        "language": "it",
        "editorial_notes": "debug me",
        "toggles": {
            "use_whisperx": True,
            "use_local_llm": False,
            "render_clean": True,
            "render_captioned": True,
        },
        "transcription": {
            "model": "large-v3",
            "beam_size": 4,
            "vad_filter": True,
            "condition_on_prev_text": False,
            "word_timestamps": True,
            "compute_type": "int8",
            "device": "auto",
        },
        "subtitle": {
            "chunk_words": 4,
            "font_name": "Avenir Next",
            "font_size": 70,
            "text_color": "FFFFFF",
            "active_color": "73E3FF",
            "outline_color": "101214",
            "bottom_margin": 220,
            "pop_in_ms": 140,
        },
        "render": {
            "width": 1080,
            "height": 1920,
            "video_codec": "libx264",
            "audio_codec": "aac",
            "crf": 18,
            "preset": "slow",
            "audio_bitrate": "192k",
        },
        "decision": {
            "filler_words": ["eh", "allora"],
            "repetition_window_seconds": 0.6,
            "soft_pause_threshold_seconds": 0.25,
            "hard_pause_threshold_seconds": 0.7,
            "leading_context_seconds": 0.18,
            "trailing_context_seconds": 0.18,
            "retained_pause_seconds": 0.24,
        },
    }

    create = client.post(
        "/api/jobs",
        data={"job_payload": json.dumps(payload)},
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    )
    assert create.status_code == 200
    created_job = create.json()
    assert created_job["request"]["profile"] == "custom"
    assert created_job["request"]["execution_mode"] == "step_by_step"
    assert created_job["status"] == "pending"

    update = client.put(
        f"/api/jobs/{created_job['id']}/request",
        json={
            **payload,
            "title": "Debug job tuned",
            "subtitle": {**payload["subtitle"], "chunk_words": 5},
        },
    )
    assert update.status_code == 200
    updated_job = update.json()
    assert updated_job["title"] == "Debug job tuned"
    assert updated_job["request"]["subtitle"]["chunk_words"] == 5

    calls = []
    app.state.manager.start_step = lambda job_id, step_name: calls.append((job_id, step_name))
    run_step = client.post(f"/api/jobs/{created_job['id']}/steps/{StepName.ingest.value}/run")
    assert run_step.status_code == 200
    assert calls == [(created_job["id"], StepName.ingest)]

import json
from pathlib import Path

from fastapi.testclient import TestClient

from fellini.app import INTERRUPTED_RUN_MESSAGE, create_app
from fellini.domain.models import (
    JobStatus,
    ProbeInfo,
    StepName,
    StepStatus,
    TranscriptArtifact,
    TranscriptSegment,
    WordTiming,
)
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings


def _attach_audio_clip_to_first_audio_lane(client: TestClient, job_id: str) -> tuple[dict, dict, dict]:
    project = client.get(f"/api/jobs/{job_id}/editorial-project").json()
    asset = project["assets"][0]
    audio_lane = next(track for track in project["tracks"] if track["kind"] == "audio")
    project["clips"] = [
        {
            "id": "clip_audio_1",
            "asset_id": asset["id"],
            "track_id": audio_lane["id"],
            "linked_group_id": None,
            "start": 0.0,
            "source_in": 0.0,
            "source_out": 2.0,
            "z_index": 0,
            "enabled": True,
            "origin": "manual",
            "transform": {
                "x": 0.0,
                "y": 0.0,
                "scale": 1.0,
                "rotation": 0.0,
                "opacity": 1.0,
                "crop": {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0},
            },
            "audio": {
                "gain": 1.0,
                "muted": False,
                "fade_in_ms": 0,
                "fade_out_ms": 0,
            },
            "captions_enabled": True,
        }
    ]
    updated = client.put(f"/api/jobs/{job_id}/editorial-project", json=project)
    assert updated.status_code == 200
    next_project = updated.json()
    clip = next(item for item in next_project["clips"] if item["id"] == "clip_audio_1")
    return next_project, clip, audio_lane


def test_api_jobs_list_empty(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

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
    def fake_start_step(job_id, step_name):
        calls.append((job_id, step_name))
        app.state.store.mark_running(job_id)
        return app.state.store.begin_step(job_id, step_name, "running")

    app.state.manager.start_step = fake_start_step
    run_step = client.post(f"/api/jobs/{created_job['id']}/steps/{StepName.ingest.value}/run")
    assert run_step.status_code == 200
    assert calls == [(created_job["id"], StepName.ingest)]
    assert run_step.json()["status"] == "running"
    assert run_step.json()["current_step"] == StepName.ingest.value


def test_request_update_resets_only_affected_downstream_steps(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    payload = {
        "title": "Debug job",
        "profile": "custom",
        "execution_mode": "step_by_step",
        "language": "it",
        "editorial_notes": "",
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

    created_job = client.post(
        "/api/jobs",
        data={"job_payload": json.dumps(payload)},
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    def mark_all_steps_completed(snapshot) -> None:
        snapshot.status = JobStatus.completed
        snapshot.outputs = ["output/master_vertical_clean.mp4"]
        for step in snapshot.steps:
            step.status = StepStatus.completed
            step.message = "done"
            step.artifacts = [f"artifacts/{step.name}.json"]

    app.state.store.update(created_job["id"], mark_all_steps_completed)

    chunk_update = client.put(
        f"/api/jobs/{created_job['id']}/request",
        json={**payload, "subtitle": {**payload["subtitle"], "chunk_words": 5}},
    )
    assert chunk_update.status_code == 200
    chunk_job = chunk_update.json()
    assert [step["status"] for step in chunk_job["steps"]] == [
        "completed",
        "completed",
        "completed",
        "completed",
    ]
    assert chunk_job["outputs"] == ["output/master_vertical_clean.mp4"]

    app.state.store.update(created_job["id"], mark_all_steps_completed)

    style_update = client.put(
        f"/api/jobs/{created_job['id']}/request",
        json={
            **payload,
            "subtitle": {**payload["subtitle"], "chunk_words": 5, "font_size": 96},
        },
    )
    assert style_update.status_code == 200
    style_job = style_update.json()
    assert [step["status"] for step in style_job["steps"]] == [
        "completed",
        "completed",
        "completed",
        "completed",
    ]
    assert style_job["outputs"] == ["output/master_vertical_clean.mp4"]


def test_partial_request_update_preserves_existing_state_for_render_tuning(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Balanced job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                    "toggles": {
                        "use_whisperx": True,
                        "use_local_llm": False,
                        "render_clean": True,
                        "render_captioned": True,
                    },
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    def mark_all_steps_completed(snapshot) -> None:
        snapshot.status = JobStatus.completed
        snapshot.outputs = ["output/master_vertical_clean.mp4"]
        for step in snapshot.steps:
            step.status = StepStatus.completed
            step.message = "done"
            step.artifacts = [f"artifacts/{step.name}.json"]

    app.state.store.update(created_job["id"], mark_all_steps_completed)

    update = client.put(
        f"/api/jobs/{created_job['id']}/request",
        json={
            "subtitle": {
                "active_color": "FF0700",
                "outline_color": "000000",
                "bottom_margin": 203,
                "pop_in_ms": 430,
            }
        },
    )
    assert update.status_code == 200
    updated = update.json()
    assert updated["request"]["toggles"]["use_whisperx"] is True
    assert updated["request"]["toggles"]["render_clean"] is True
    assert updated["request"]["toggles"]["render_captioned"] is True
    assert updated["request"]["subtitle"]["active_color"] == "FF0700"
    assert [step["status"] for step in updated["steps"]] == [
        "completed",
        "completed",
        "completed",
        "completed",
    ]
    assert updated["outputs"] == ["output/master_vertical_clean.mp4"]


def test_transcript_updates_target_correct_artifact_and_downstream_step(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Transcript target job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    def mark_all_steps_completed(snapshot) -> None:
        snapshot.status = JobStatus.completed
        for step in snapshot.steps:
            step.status = StepStatus.completed
            step.message = "done"
            step.artifacts = [f"artifacts/{step.name}.json"]

    app.state.store.update(created_job["id"], mark_all_steps_completed)
    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.artifact_path("04_transcript_aligned.json").write_text(
        json.dumps({"language": "it", "source": "stale", "notes": [], "segments": []}),
        encoding="utf-8",
    )
    workspace.artifact_path("06_edit_decision_list.json").write_text(
        json.dumps({"source_video": "input.mp4", "keep_ranges": [], "soft_cuts": []}),
        encoding="utf-8",
    )

    raw_payload = {
        "language": "it",
        "source": "manual",
        "notes": [],
        "segments": [
            {
                "id": "seg-1",
                "start": 0.0,
                "end": 0.6,
                "text": "ciao",
                "words": [
                    {"text": "ciao", "start": 0.0, "end": 0.6, "confidence": 1.0},
                ],
            }
        ],
    }
    raw_update = client.put(
        f"/api/jobs/{created_job['id']}/transcript?target=transcription",
        json=raw_payload,
    )
    assert raw_update.status_code == 200
    assert workspace.artifact_path("03_transcript_raw.json").exists()
    assert json.loads(workspace.artifact_path("03_transcript_raw.json").read_text())["segments"][0]["text"] == "ciao"
    assert workspace.artifact_path("04_transcript_aligned.json").exists()
    assert json.loads(workspace.artifact_path("04_transcript_aligned.json").read_text())["segments"][0]["text"] == "ciao"
    assert workspace.artifact_path("06_edit_decision_list.json").exists()
    assert [step["status"] for step in raw_update.json()["steps"]] == [
        "completed",
        "completed",
        "completed",
        "completed",
    ]

    app.state.store.update(created_job["id"], mark_all_steps_completed)

    aligned_payload = {
        "language": "it",
        "source": "alignment",
        "notes": [],
        "segments": [
            {
                "id": "seg-1",
                "start": 0.1,
                "end": 0.7,
                "text": "ciao",
                "words": [
                    {"text": "ciao", "start": 0.1, "end": 0.7, "confidence": 1.0},
                ],
            }
        ],
    }
    aligned_update = client.put(
        f"/api/jobs/{created_job['id']}/transcript?target=alignment",
        json=aligned_payload,
    )
    assert aligned_update.status_code == 200
    assert workspace.artifact_path("04_transcript_aligned.json").exists()
    assert json.loads(workspace.artifact_path("04_transcript_aligned.json").read_text())["segments"][0]["start"] == 0.1
    assert [step["status"] for step in aligned_update.json()["steps"]] == [
        "completed",
        "completed",
        "completed",
        "completed",
    ]


def test_existing_workspace_transcript_marks_transcription_as_completed(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Recovered transcript job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.temp_path("source_mezzanine.mp4").write_bytes(b"video")
    workspace.temp_path("audio_16k_mono.wav").write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "path": "input.mp4",
                        "duration_seconds": 3.2,
                        "width": 720,
                        "height": 1280,
                        "fps": 25.0,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    workspace.artifact_path("04_transcript_aligned.json").write_text(
        json.dumps(
            {
                "language": "it",
                "source": "manual",
                "notes": [],
                "segments": [
                    {
                        "id": "seg-1",
                        "start": 0.0,
                        "end": 0.6,
                        "text": "ciao",
                        "words": [
                            {
                                "text": "ciao",
                                "start": 0.0,
                                "end": 0.6,
                                "confidence": 1.0,
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    recovered = client.get(f"/api/jobs/{created_job['id']}")
    assert recovered.status_code == 200
    recovered_job = recovered.json()
    assert [step["status"] for step in recovered_job["steps"]] == [
        "completed",
        "completed",
        "pending",
        "pending",
    ]
    assert recovered_job["steps"][2]["can_run"] is True


def test_editorial_project_bootstraps_from_ingest_workspace(tmp_path, monkeypatch):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Project bootstrap job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.temp_path("source_mezzanine.mp4").write_bytes(b"video")
    workspace.temp_path("audio_16k_mono.wav").write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "path": "input.mp4",
                        "duration_seconds": 6.5,
                        "width": 1080,
                        "height": 1920,
                        "fps": 30.0,
                        "sample_rate": 48000,
                        "has_audio": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        app.state.editorial_projects.ffmpeg,
        "probe_media",
        lambda _path: ProbeInfo(
            path="temp/source_mezzanine.mp4",
            duration_seconds=6.5,
            width=1080,
            height=1920,
            fps=30.0,
            sample_rate=48000,
            has_audio=True,
        ),
    )

    response = client.get(f"/api/jobs/{created_job['id']}/editorial-project")
    assert response.status_code == 200
    project = response.json()
    assert [track["kind"] for track in project["tracks"]] == [
        "video",
        "video",
        "audio",
        "audio",
    ]
    assert [track["name"] for track in project["tracks"]] == [
        "Video 2",
        "Video 1",
        "Audio 1",
        "Audio 2",
    ]
    assert len(project["assets"]) == 1
    assert len(project["clips"]) == 0


def test_asset_preview_request_marks_asset_as_generating(tmp_path, monkeypatch):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Preview request job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.temp_path("source_mezzanine.mp4").write_bytes(b"video")
    workspace.temp_path("audio_16k_mono.wav").write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "path": "input.mp4",
                        "duration_seconds": 6.5,
                        "width": 1080,
                        "height": 1920,
                        "fps": 30.0,
                        "sample_rate": 48000,
                        "has_audio": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        app.state.editorial_projects.ffmpeg,
        "probe_media",
        lambda _path: ProbeInfo(
            path="temp/source_mezzanine.mp4",
            duration_seconds=6.5,
            width=1080,
            height=1920,
            fps=30.0,
            sample_rate=48000,
            has_audio=True,
        ),
    )
    monkeypatch.setattr(app.state.asset_previews, "_launch_generation", lambda job_id, asset: None)

    project = client.get(f"/api/jobs/{created_job['id']}/editorial-project").json()
    asset_id = project["assets"][0]["id"]

    response = client.post(
        f"/api/jobs/{created_job['id']}/asset-previews",
        json={"asset_ids": [asset_id]},
    )

    assert response.status_code == 200
    payload = response.json()
    preview = payload["assets"][0]["preview"]
    assert preview["original"]["filmstrip"]["status"] == "generating"
    assert preview["original"]["waveform"]["status"] == "generating"


def test_editorial_project_rejects_overlapping_clips_on_same_lane(tmp_path, monkeypatch):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "No overlap job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.temp_path("source_mezzanine.mp4").write_bytes(b"video")
    workspace.temp_path("audio_16k_mono.wav").write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "path": "input.mp4",
                        "duration_seconds": 6.5,
                        "width": 1080,
                        "height": 1920,
                        "fps": 30.0,
                        "sample_rate": 48000,
                        "has_audio": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        app.state.editorial_projects.ffmpeg,
        "probe_media",
        lambda _path: ProbeInfo(
            path="temp/source_mezzanine.mp4",
            duration_seconds=6.5,
            width=1080,
            height=1920,
            fps=30.0,
            sample_rate=48000,
            has_audio=True,
        ),
    )

    project = client.get(f"/api/jobs/{created_job['id']}/editorial-project").json()
    asset = project["assets"][0]
    video_track = next(track for track in project["tracks"] if track["kind"] == "video")
    project["clips"] = [
        {
            "id": "clip_a",
            "asset_id": asset["id"],
            "track_id": video_track["id"],
            "linked_group_id": None,
            "start": 0.0,
            "source_in": 0.0,
            "source_out": 2.0,
            "z_index": 0,
            "enabled": True,
            "origin": "manual",
            "transform": {
                "x": 0.0,
                "y": 0.0,
                "scale": 1.0,
                "rotation": 0.0,
                "opacity": 1.0,
                "crop": {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0},
            },
            "audio": {
                "gain": 1.0,
                "muted": False,
                "fade_in_ms": 0,
                "fade_out_ms": 0,
            },
            "captions_enabled": True,
        },
        {
            "id": "clip_b",
            "asset_id": asset["id"],
            "track_id": video_track["id"],
            "linked_group_id": None,
            "start": 1.5,
            "source_in": 0.0,
            "source_out": 2.0,
            "z_index": 0,
            "enabled": True,
            "origin": "manual",
            "transform": {
                "x": 0.0,
                "y": 0.0,
                "scale": 1.0,
                "rotation": 0.0,
                "opacity": 1.0,
                "crop": {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0},
            },
            "audio": {
                "gain": 1.0,
                "muted": False,
                "fade_in_ms": 0,
                "fade_out_ms": 0,
            },
            "captions_enabled": True,
        },
    ]

    response = client.put(f"/api/jobs/{created_job['id']}/editorial-project", json=project)
    assert response.status_code == 400
    assert "overlapping clips" in response.json()["detail"]


def test_audio_lane_transcription_updates_project_and_job(tmp_path, monkeypatch):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Lane transcription job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.temp_path("source_mezzanine.mp4").write_bytes(b"video")
    workspace.temp_path("audio_16k_mono.wav").write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "path": "input.mp4",
                        "duration_seconds": 6.5,
                        "width": 1080,
                        "height": 1920,
                        "fps": 30.0,
                        "sample_rate": 48000,
                        "has_audio": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        app.state.editorial_projects.ffmpeg,
        "probe_media",
        lambda _path: ProbeInfo(
            path="temp/source_mezzanine.mp4",
            duration_seconds=6.5,
            width=1080,
            height=1920,
            fps=30.0,
            sample_rate=48000,
            has_audio=True,
        ),
    )
    project = client.get(f"/api/jobs/{created_job['id']}/editorial-project").json()
    audio_lane = next(track for track in project["tracks"] if track["kind"] == "audio")

    monkeypatch.setattr(
        "fellini.adapters.ffmpeg.FFmpegAdapter.mix_audio_lane",
        lambda self, **kwargs: Path(kwargs["target"]).write_bytes(b"wav"),
    )
    monkeypatch.setattr(
        "fellini.adapters.asr.FasterWhisperTranscriber.transcribe",
        lambda self, audio_path, config, language: (
            [],
            TranscriptArtifact(
                language=language,
                source="test-lane",
                segments=[
                    TranscriptSegment(
                        id="seg_1",
                        start=0.0,
                        end=0.8,
                        text="ciao lane",
                        words=[
                            WordTiming(text="ciao", start=0.0, end=0.4, confidence=1.0),
                            WordTiming(text="lane", start=0.42, end=0.8, confidence=1.0),
                        ],
                    )
                ],
            ),
        ),
    )
    monkeypatch.setattr(
        "fellini.adapters.alignment.TranscriptAligner.align",
        lambda self, audio_path, transcript, config, language, use_whisperx: transcript,
    )

    response = client.post(f"/api/jobs/{created_job['id']}/audio-lanes/{audio_lane['id']}/transcribe")
    assert response.status_code == 200
    payload = response.json()
    assert payload["job"]["steps"][1]["status"] == "completed"
    assert payload["project"]["lane_transcriptions"][0]["lane_id"] == audio_lane["id"]
    assert [caption["text"] for caption in payload["project"]["captions"]] == ["ciao", "lane"]


def test_audio_clip_transcription_updates_project_and_job(tmp_path, monkeypatch):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Clip transcription job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.temp_path("source_mezzanine.mp4").write_bytes(b"video")
    workspace.temp_path("audio_16k_mono.wav").write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "path": "input.mp4",
                        "duration_seconds": 6.5,
                        "width": 1080,
                        "height": 1920,
                        "fps": 30.0,
                        "sample_rate": 48000,
                        "has_audio": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        app.state.editorial_projects.ffmpeg,
        "probe_media",
        lambda _path: ProbeInfo(
            path="temp/source_mezzanine.mp4",
            duration_seconds=6.5,
            width=1080,
            height=1920,
            fps=30.0,
            sample_rate=48000,
            has_audio=True,
        ),
    )
    _project, clip, _audio_lane = _attach_audio_clip_to_first_audio_lane(client, created_job["id"])

    monkeypatch.setattr(
        "fellini.adapters.ffmpeg.FFmpegAdapter.mix_audio_clip",
        lambda self, **kwargs: Path(kwargs["target"]).write_bytes(b"wav"),
    )
    transcribe_calls = []
    align_calls = []

    def fake_transcribe(self, audio_path, config, language):
        transcribe_calls.append(
            {
                "model": config.model,
                "beam_size": config.beam_size,
                "vad_filter": config.vad_filter,
                "language": language,
            }
        )
        return (
            [],
            TranscriptArtifact(
                language=language,
                source="test-clip",
                segments=[
                    TranscriptSegment(
                        id="seg_1",
                        start=0.0,
                        end=0.82,
                        text="hello clip",
                        words=[
                            WordTiming(text="hello", start=0.0, end=0.36, confidence=1.0),
                            WordTiming(text="clip", start=0.4, end=0.82, confidence=1.0),
                        ],
                    )
                ],
            ),
        )

    def fake_align(self, audio_path, transcript, config, language, use_whisperx):
        align_calls.append({"language": language, "use_whisperx": use_whisperx})
        return transcript

    monkeypatch.setattr(
        "fellini.adapters.asr.FasterWhisperTranscriber.transcribe",
        fake_transcribe,
    )
    monkeypatch.setattr(
        "fellini.adapters.alignment.TranscriptAligner.align",
        fake_align,
    )

    response = client.post(
        f"/api/jobs/{created_job['id']}/clips/{clip['id']}/transcribe",
        json={
            "language": "en",
            "model": "small",
            "beam_size": 2,
            "vad_filter": False,
            "use_whisperx": False,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    clip_payload = next(item for item in payload["project"]["clips"] if item["id"] == clip["id"])
    assert transcribe_calls == [{
        "model": "small",
        "beam_size": 2,
        "vad_filter": False,
        "language": "en",
    }]
    assert align_calls == [{"language": "en", "use_whisperx": False}]
    assert payload["job"]["steps"][1]["status"] == "completed"
    assert clip_payload["transcription_status"] == "completed"
    assert clip_payload["transcription_options"] == {
        "language": "en",
        "model": "small",
        "beam_size": 2,
        "vad_filter": False,
        "use_whisperx": False,
    }
    assert clip_payload["transcription_source_audio_path"] == "temp/clip_clip_audio_1_bounce.wav"
    assert [caption["text"] for caption in payload["project"]["captions"]] == ["hello", "clip"]
    assert all(caption["source_clip_id"] == clip["id"] for caption in payload["project"]["captions"])


def test_interrupted_lane_transcription_is_recovered_after_restart(tmp_path, monkeypatch):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Interrupted lane transcription job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.temp_path("source_mezzanine.mp4").write_bytes(b"video")
    workspace.temp_path("audio_16k_mono.wav").write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "path": "input.mp4",
                        "duration_seconds": 6.5,
                        "width": 1080,
                        "height": 1920,
                        "fps": 30.0,
                        "sample_rate": 48000,
                        "has_audio": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        app.state.editorial_projects.ffmpeg,
        "probe_media",
        lambda _path: ProbeInfo(
            path="temp/source_mezzanine.mp4",
            duration_seconds=6.5,
            width=1080,
            height=1920,
            fps=30.0,
            sample_rate=48000,
            has_audio=True,
        ),
    )
    project = client.get(f"/api/jobs/{created_job['id']}/editorial-project").json()
    audio_lane = next(track for track in project["tracks"] if track["kind"] == "audio")

    app.state.store.mark_running(created_job["id"])
    app.state.store.begin_step(
        created_job["id"],
        StepName.transcription,
        "Trascrizione della lane",
    )

    recovered_app = create_app(settings)
    recovered_client = TestClient(recovered_app)
    recovered_snapshot = recovered_client.get(f"/api/jobs/{created_job['id']}").json()
    transcription_step = next(
        step for step in recovered_snapshot["steps"] if step["name"] == StepName.transcription.value
    )
    assert recovered_snapshot["status"] == JobStatus.failed.value
    assert recovered_snapshot["current_step"] is None
    assert recovered_snapshot["error"] == INTERRUPTED_RUN_MESSAGE
    assert transcription_step["status"] == StepStatus.failed.value
    assert transcription_step["message"] == INTERRUPTED_RUN_MESSAGE
    assert transcription_step["can_run"] is True

    monkeypatch.setattr(
        "fellini.adapters.ffmpeg.FFmpegAdapter.mix_audio_lane",
        lambda self, **kwargs: Path(kwargs["target"]).write_bytes(b"wav"),
    )
    monkeypatch.setattr(
        "fellini.adapters.asr.FasterWhisperTranscriber.transcribe",
        lambda self, audio_path, config, language: (
            [],
            TranscriptArtifact(
                language=language,
                source="test-lane",
                segments=[
                    TranscriptSegment(
                        id="seg_1",
                        start=0.0,
                        end=0.8,
                        text="ciao retry",
                        words=[
                            WordTiming(text="ciao", start=0.0, end=0.4, confidence=1.0),
                            WordTiming(text="retry", start=0.42, end=0.8, confidence=1.0),
                        ],
                    )
                ],
            ),
        ),
    )
    monkeypatch.setattr(
        "fellini.adapters.alignment.TranscriptAligner.align",
        lambda self, audio_path, transcript, config, language, use_whisperx: transcript,
    )

    response = recovered_client.post(
        f"/api/jobs/{created_job['id']}/audio-lanes/{audio_lane['id']}/transcribe"
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["job"]["status"] == JobStatus.pending.value
    assert payload["job"]["steps"][1]["status"] == StepStatus.completed.value
    assert payload["project"]["lane_transcriptions"][0]["lane_id"] == audio_lane["id"]


def test_interrupted_clip_transcription_is_recovered_after_restart(tmp_path, monkeypatch):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    app = create_app(settings)
    client = TestClient(app)

    created_job = client.post(
        "/api/jobs",
        data={
            "job_payload": json.dumps(
                {
                    "title": "Interrupted clip transcription job",
                    "profile": "balanced",
                    "execution_mode": "step_by_step",
                    "language": "it",
                }
            )
        },
        files={"files": ("clip.mp4", b"fake-video", "video/mp4")},
    ).json()

    workspace = JobWorkspace(settings.jobs_root, created_job["id"])
    workspace.temp_path("source_mezzanine.mp4").write_bytes(b"video")
    workspace.temp_path("audio_16k_mono.wav").write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "path": "input.mp4",
                        "duration_seconds": 6.5,
                        "width": 1080,
                        "height": 1920,
                        "fps": 30.0,
                        "sample_rate": 48000,
                        "has_audio": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        app.state.editorial_projects.ffmpeg,
        "probe_media",
        lambda _path: ProbeInfo(
            path="temp/source_mezzanine.mp4",
            duration_seconds=6.5,
            width=1080,
            height=1920,
            fps=30.0,
            sample_rate=48000,
            has_audio=True,
        ),
    )
    _project, clip, _audio_lane = _attach_audio_clip_to_first_audio_lane(client, created_job["id"])

    saved_project = app.state.editorial_projects.load(workspace)
    app.state.editorial_projects.set_clip_transcription_running(
        workspace,
        project=saved_project,
        clip_id=clip["id"],
    )
    app.state.store.mark_running(created_job["id"])
    app.state.store.begin_step(
        created_job["id"],
        StepName.transcription,
        "Trascrizione della clip",
    )

    recovered_app = create_app(settings)
    recovered_client = TestClient(recovered_app)
    recovered_project = recovered_client.get(f"/api/jobs/{created_job['id']}/editorial-project").json()
    recovered_clip = next(item for item in recovered_project["clips"] if item["id"] == clip["id"])
    assert recovered_clip["transcription_status"] == StepStatus.failed.value
    assert recovered_clip["transcription_error"] == INTERRUPTED_RUN_MESSAGE

import json
from pathlib import Path

from fastapi.testclient import TestClient

from fellini.app import create_app
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

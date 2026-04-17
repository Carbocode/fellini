import json

from fellini.settings import AppSettings, load_settings, project_root


def test_app_settings_default_workspace_root_points_to_repo_workspace():
    settings = AppSettings()

    assert settings.workspace_root == project_root() / "workspace"


def test_load_settings_resolves_relative_paths_from_config_location(tmp_path):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    config_path = config_dir / "fellini.yaml"
    config_path.write_text(
        "workspace_root: ../workspace\nfonts_dir: ../fonts\n",
        encoding="utf-8",
    )

    settings = load_settings(config_path)

    assert settings.workspace_root == (tmp_path / "workspace").resolve()
    assert settings.fonts_dir == (tmp_path / "fonts").resolve()
    assert settings.projects_root == (tmp_path / "workspace" / "projects").resolve()


def test_load_settings_migrates_legacy_workspace_layout(tmp_path):
    workspace_root = tmp_path / "workspace"
    legacy_project = workspace_root / "jobs" / "legacy123"
    preview_file = legacy_project / "artifacts" / "previews" / "asset_audio.original.waveform.json"
    state_file = legacy_project / "temp" / "pipeline_state.json"
    mezzanine_file = legacy_project / "temp" / "source_mezzanine.mp4"
    clip_bounce_file = legacy_project / "temp" / "clip_clip_audio_1_bounce.wav"
    lane_bounce_file = legacy_project / "temp" / "lane_track_audio_1_bounce.wav"
    preview_state_file = legacy_project / "project" / "asset_previews.json"
    editorial_project_file = legacy_project / "project" / "editorial_project.json"
    snapshot_file = legacy_project / "job.json"

    preview_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    preview_state_file.parent.mkdir(parents=True, exist_ok=True)

    preview_file.write_text("{}", encoding="utf-8")
    mezzanine_file.write_bytes(b"video")
    clip_bounce_file.write_bytes(b"clip-audio")
    lane_bounce_file.write_bytes(b"lane-audio")
    state_file.write_text(
        json.dumps(
            {
                "mezzanine_path": str(mezzanine_file),
            }
        ),
        encoding="utf-8",
    )
    preview_state_file.write_text(
        json.dumps(
            {
                "asset_audio": {
                    "original": {
                        "waveform": {
                            "status": "ready",
                            "resource_path": "artifacts/previews/asset_audio.original.waveform.json",
                            "version": 3,
                        }
                    }
                }
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    editorial_project_file.write_text(
        json.dumps(
            {
                "assets": [{"id": "asset_audio", "has_audio": True}],
                "clips": [
                    {
                        "id": "clip_audio_1",
                        "asset_id": "asset_audio",
                        "track_id": "track_audio_1",
                        "enabled": True,
                        "transcription_source_audio_path": "jobs/transcriptions/clip_clip_audio_1_bounce.wav",
                    }
                ],
                "lane_transcriptions": [
                    {
                        "lane_id": "track_audio_1",
                        "source_audio_path": "jobs/transcriptions/lane_track_audio_1_bounce.wav",
                    }
                ],
                "asset_transcriptions": [
                    {
                        "asset_id": "asset_audio",
                        "source_audio_path": "jobs/transcriptions/clip_clip_audio_1_bounce.wav",
                    }
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    snapshot_file.write_text(
        json.dumps(
            {
                "workspace": str(legacy_project),
            }
        ),
        encoding="utf-8",
    )

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    config_path = config_dir / "fellini.yaml"
    config_path.write_text("workspace_root: ../workspace\n", encoding="utf-8")

    settings = load_settings(config_path)
    project_root = settings.projects_root / "legacy123"

    assert (project_root / "project.json").exists()
    assert (project_root / "jobs" / "runtime" / "source_mezzanine.mp4").exists()
    assert (project_root / "jobs" / "previews" / "asset_audio" / "original" / "waveform.json").exists()
    assert (
        project_root / "jobs" / "transcriptions" / "asset_audio" / "clip_clip_audio_1_bounce.wav"
    ).exists()
    assert (
        project_root / "jobs" / "transcriptions" / "asset_audio" / "lane_track_audio_1_bounce.wav"
    ).exists()
    assert list((project_root / "temp").iterdir()) == []
    assert "jobs/runtime/source_mezzanine.mp4" in (
        project_root / "jobs" / "runtime" / "pipeline_state.json"
    ).read_text(encoding="utf-8")
    assert "jobs/previews/asset_audio/original/waveform.json" in (
        project_root / "project" / "asset_previews.json"
    ).read_text(encoding="utf-8")
    editorial_project_text = (
        project_root / "project" / "editorial_project.json"
    ).read_text(encoding="utf-8")
    assert "jobs/transcriptions/asset_audio/clip_clip_audio_1_bounce.wav" in editorial_project_text
    assert "jobs/transcriptions/asset_audio/lane_track_audio_1_bounce.wav" in editorial_project_text

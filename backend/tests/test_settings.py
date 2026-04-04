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
    assert settings.jobs_root == (tmp_path / "workspace" / "jobs").resolve()

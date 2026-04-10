import importlib.util
from pathlib import Path


def _load_runner_module():
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "run_matanyone_benchmark.py"
    spec = importlib.util.spec_from_file_location("run_matanyone_benchmark", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_ensure_matanyone_root_clones_when_missing(tmp_path):
    module = _load_runner_module()
    target = tmp_path / "third_party" / "MatAnyone2"
    progress = tmp_path / "progress.json"

    module._matanyone_root_candidates = lambda _cli_value: [target.resolve()]
    module.require_executable = lambda _name: None

    def fake_run_command(command, *, cwd=None, env=None):
        clone_target = Path(command[-1])
        clone_target.mkdir(parents=True, exist_ok=True)
        (clone_target / "inference_matanyone2.py").write_text(
            "#!/usr/bin/env python3\n",
            encoding="utf-8",
        )

    module.run_command = fake_run_command
    result = module.ensure_matanyone_root(
        str(target),
        progress_path=progress,
        repo_url="https://example.invalid/MatAnyone2.git",
        repo_ref="main",
    )

    assert result == target.resolve()
    assert (target / "inference_matanyone2.py").exists()
    assert progress.exists()


def test_ensure_matanyone_root_repairs_invalid_checkout(tmp_path):
    module = _load_runner_module()
    target = tmp_path / "third_party" / "MatAnyone2"
    target.mkdir(parents=True, exist_ok=True)
    (target / "README.md").write_text("broken checkout\n", encoding="utf-8")

    module._matanyone_root_candidates = lambda _cli_value: [target.resolve()]
    module.require_executable = lambda _name: None

    def fake_run_command(command, *, cwd=None, env=None):
        clone_target = Path(command[-1])
        clone_target.mkdir(parents=True, exist_ok=True)
        (clone_target / "inference_matanyone2.py").write_text(
            "#!/usr/bin/env python3\n",
            encoding="utf-8",
        )

    module.run_command = fake_run_command
    result = module.ensure_matanyone_root(
        str(target),
        repo_url="https://example.invalid/MatAnyone2.git",
        repo_ref="main",
    )

    assert result == target.resolve()
    assert (target / "inference_matanyone2.py").exists()


def test_inference_supports_progress_path_detection(tmp_path):
    module = _load_runner_module()
    supported = tmp_path / "supported.py"
    supported.write_text(
        'parser.add_argument("--progress_path")\n',
        encoding="utf-8",
    )
    unsupported = tmp_path / "unsupported.py"
    unsupported.write_text(
        'parser.add_argument("--max_size")\n',
        encoding="utf-8",
    )

    assert module.inference_supports_progress_path(supported) is True
    assert module.inference_supports_progress_path(unsupported) is False


def test_resolve_video_encoder_falls_back_when_libx264_is_missing():
    module = _load_runner_module()
    module.available_video_encoders = lambda: {"libopenh264", "mpeg4"}

    assert module.resolve_video_encoder("libx264") == "libopenh264"


def test_video_encode_args_match_supported_fallback_codecs():
    module = _load_runner_module()

    assert module.video_encode_args("libx264", fallback_rate="4M") == [
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "18",
    ]
    assert module.video_encode_args("libopenh264", fallback_rate="4M") == [
        "-c:v",
        "libopenh264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-b:v",
        "4M",
    ]

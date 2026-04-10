import sys
from types import SimpleNamespace

import pytest

from fellini.adapters.asr import FasterWhisperTranscriber


def test_auto_device_falls_back_to_cpu_when_cudnn_runtime_is_missing(monkeypatch):
    monkeypatch.setattr(
        "fellini.adapters.asr.importlib.util.find_spec",
        lambda name: object() if name == "torch" else None,
    )
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True)),
    )
    monkeypatch.setattr("fellini.adapters.asr.sys.platform", "linux")
    monkeypatch.setattr(
        "fellini.adapters.asr.ctypes.CDLL",
        lambda _name: (_ for _ in ()).throw(OSError("missing runtime")),
    )

    assert FasterWhisperTranscriber._resolve_device("auto") == "cpu"


def test_explicit_cuda_raises_clear_error_when_cudnn_runtime_is_missing(monkeypatch):
    monkeypatch.setattr(
        "fellini.adapters.asr.importlib.util.find_spec",
        lambda name: object() if name == "torch" else None,
    )
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True)),
    )
    monkeypatch.setattr("fellini.adapters.asr.sys.platform", "linux")
    monkeypatch.setattr(
        "fellini.adapters.asr.ctypes.CDLL",
        lambda _name: (_ for _ in ()).throw(OSError("missing runtime")),
    )

    with pytest.raises(RuntimeError, match="required runtime libraries are missing"):
        FasterWhisperTranscriber._resolve_device("cuda")

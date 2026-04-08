#!/usr/bin/env python3
from __future__ import annotations

import platform
import subprocess
import sys
import traceback
from pathlib import Path


def print_section(title: str) -> None:
    print(f"\n== {title} ==")


def run_capture(*args: str) -> str:
    try:
        proc = subprocess.run(
            list(args),
            check=False,
            capture_output=True,
            text=True,
        )
    except Exception as exc:
        return f"<error: {exc}>"
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        stdout = proc.stdout.strip()
        detail = stderr or stdout or f"exit code {proc.returncode}"
        return f"<error: {detail}>"
    return proc.stdout.strip()


def macho_sdk_info(path: Path) -> str:
    if not path.exists():
        return "<missing>"
    output = run_capture("otool", "-l", str(path))
    if output.startswith("<error:"):
        return output

    cmd = None
    minos = None
    sdk = None
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("cmd "):
            cmd = stripped.split(None, 1)[1]
        elif cmd == "LC_BUILD_VERSION" and stripped.startswith("minos "):
            minos = stripped.split(None, 1)[1]
        elif cmd == "LC_BUILD_VERSION" and stripped.startswith("sdk "):
            sdk = stripped.split(None, 1)[1]
            break

    if minos or sdk:
        return f"minos={minos or '?'} sdk={sdk or '?'}"
    return "<LC_BUILD_VERSION not found>"


def main() -> int:
    print_section("System")
    print(f"python_executable: {sys.executable}")
    print(f"python_version: {sys.version.splitlines()[0]}")
    print(f"platform: {platform.platform()}")
    print(f"machine: {platform.machine()}")
    print(f"platform.mac_ver: {platform.mac_ver()}")
    print(f"sw_vers:\n{run_capture('sw_vers')}")
    print(f"python_binary_sdk: {macho_sdk_info(Path(sys.executable).resolve())}")

    print_section("Torch Import")
    try:
        import torch
    except Exception:
        print("torch_import: FAILED")
        traceback.print_exc()
        return 2

    torch_file = Path(torch.__file__).resolve()
    torch_c_ext = torch_file.parent / f"_C.cpython-{sys.version_info.major}{sys.version_info.minor}-darwin.so"
    torch_lib_cpu = torch_file.parent / "lib" / "libtorch_cpu.dylib"

    print(f"torch_version: {torch.__version__}")
    print(f"torch_file: {torch_file}")
    print(f"torch__C_sdk: {macho_sdk_info(torch_c_ext)}")
    print(f"libtorch_cpu_sdk: {macho_sdk_info(torch_lib_cpu)}")

    print_section("MPS Probe")
    try:
        mps_built = bool(torch.backends.mps.is_built())
    except Exception as exc:
        mps_built = False
        print(f"mps_built_probe_error: {exc!r}")

    try:
        mps_available = bool(torch.backends.mps.is_available())
    except Exception as exc:
        mps_available = False
        print(f"mps_available_probe_error: {exc!r}")

    print(f"mps_built: {mps_built}")
    print(f"mps_available: {mps_available}")

    if hasattr(torch.backends.mps, "is_macos_or_newer"):
        for major, minor in ((14, 0), (15, 0), (26, 0)):
            try:
                value = torch.backends.mps.is_macos_or_newer(major, minor)
            except Exception as exc:
                value = f"<error: {exc}>"
            print(f"is_macos_or_newer({major}, {minor}): {value}")

    print_section("Smoke Tests")

    try:
        x_cpu = torch.ones((3, 3), device="cpu")
        print(f"cpu_tensor_ok: shape={tuple(x_cpu.shape)} dtype={x_cpu.dtype}")
    except Exception:
        print("cpu_tensor_ok: FAILED")
        traceback.print_exc()
        return 3

    device_error = None
    try:
        x_mps = torch.ones((3, 3), device="mps")
        print(f"mps_tensor_ok: shape={tuple(x_mps.shape)} dtype={x_mps.dtype} device={x_mps.device}")
    except Exception as exc:
        device_error = exc
        print(f"mps_tensor_ok: FAILED -> {exc!r}")

    if device_error is not None:
        print_section("Verdict")
        print("MPS is not usable in this runtime.")
        print("If python_binary_sdk is 26.x but torch SDKs are older, the wheel is a likely cause.")
        return 1

    try:
        linear = torch.nn.Linear(3, 2).to("mps")
        y = linear(x_mps)
        print(f"mps_forward_ok: shape={tuple(y.shape)} dtype={y.dtype} device={y.device}")
    except Exception as exc:
        print(f"mps_forward_ok: FAILED -> {exc!r}")
        print_section("Verdict")
        print("MPS tensor allocation worked, but a basic forward failed.")
        return 1

    print_section("Verdict")
    print("MPS is usable in this runtime.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

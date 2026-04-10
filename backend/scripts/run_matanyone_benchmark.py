#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime
from fractions import Fraction
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

import numpy as np
from PIL import Image, ImageDraw

BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent
DEFAULT_CHECKPOINT_URL = "https://github.com/pq-yang/MatAnyone2/releases/download/v1.0.0/matanyone2.pth"
DEFAULT_MATANYONE_REPO_URL = "https://github.com/pq-yang/MatAnyone2.git"
DEFAULT_MATANYONE_REF = "main"
DEFAULT_VIDEO_ENCODERS = ("libx264", "libopenh264", "mpeg4")


def require_executable(name: str) -> None:
    if shutil.which(name):
        return
    raise SystemExit(f"Missing required executable: {name}")


def run_command(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    printable = " ".join(shlex.quote(part) for part in command)
    print(f"$ {printable}")
    subprocess.run(command, cwd=cwd, env=env, check=True)


def capture_command(command: list[str]) -> str:
    proc = subprocess.run(command, capture_output=True, text=True, check=True)
    return proc.stdout.strip()


def find_missing_modules(*, require_sam2: bool) -> list[str]:
    required = [
        "torch",
        "torchvision",
        "numpy",
        "PIL",
        "cv2",
        "imageio",
        "imageio_ffmpeg",
        "omegaconf",
        "hydra",
        "scipy",
        "einops",
    ]
    if require_sam2:
        required.append("transformers")
    missing: list[str] = []
    for module_name in required:
        if importlib.util.find_spec(module_name) is None:
            missing.append(module_name)
    return missing


def _matanyone_root_candidates(cli_value: str | None) -> list[Path]:
    candidates: list[Path] = []
    if cli_value:
        candidates.append(Path(cli_value).expanduser())
    env_value = os.environ.get("MATANYONE_ROOT")
    if env_value:
        candidates.append(Path(env_value).expanduser())
    candidates.extend(
        [
            BACKEND_ROOT / "third_party" / "MatAnyone2",
            BACKEND_ROOT / "third_party" / "MatAnyone",
            REPO_ROOT / "third_party" / "MatAnyone2",
            REPO_ROOT / "third_party" / "MatAnyone",
        ]
    )
    deduped: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        deduped.append(resolved)
        seen.add(resolved)
    return deduped


def resolve_matanyone_root(cli_value: str | None) -> Path:
    candidates = _matanyone_root_candidates(cli_value)
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    searched = "\n".join(f"- {path}" for path in candidates)
    raise SystemExit(
        "MatAnyone repository not found.\n"
        "Clone it locally and pass --matanyone-root or set MATANYONE_ROOT.\n"
        f"Searched:\n{searched}"
    )


def ensure_matanyone_root(
    cli_value: str | None,
    *,
    progress_path: Path | None = None,
    repo_url: str = DEFAULT_MATANYONE_REPO_URL,
    repo_ref: str = DEFAULT_MATANYONE_REF,
) -> Path:
    candidates = _matanyone_root_candidates(cli_value)
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            resolve_inference_script(candidate)
            return candidate
        except SystemExit:
            if cli_value and candidate != Path(cli_value).expanduser().resolve():
                continue
            print(f"matanyone_invalid_checkout: {candidate}")

    require_executable("git")
    target = (
        Path(cli_value).expanduser().resolve()
        if cli_value
        else (BACKEND_ROOT / "third_party" / "MatAnyone2").resolve()
    )
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_target = target.with_name(f"{target.name}.clone-{os.getpid()}")
    if temp_target.exists():
        shutil.rmtree(temp_target)

    print(f"matanyone_missing: {target}")
    print(f"matanyone_repo_url: {repo_url}")
    print(f"matanyone_ref: {repo_ref}")
    if progress_path is not None:
        write_progress(
            progress_path,
            phase="cloning_matanyone",
            message="Cloning MatAnyone2 repository for the first run.",
        )

    try:
        run_command(
            [
                "git",
                "clone",
                "--depth",
                "1",
                "--branch",
                repo_ref,
                repo_url,
                str(temp_target),
            ]
        )
        temp_target.replace(target)
    except Exception:
        if temp_target.exists():
            shutil.rmtree(temp_target, ignore_errors=True)
        raise

    print(f"matanyone_ready: {target}")
    if progress_path is not None:
        write_progress(
            progress_path,
            phase="cloning_matanyone",
            message="MatAnyone2 repository ready.",
        )
    return target


def resolve_inference_script(matanyone_root: Path) -> Path:
    candidates = [
        matanyone_root / "inference_matanyone2.py",
        matanyone_root / "inference_matanyone.py",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise SystemExit(
        "Could not find an official inference entrypoint in the MatAnyone checkout.\n"
        f"Checked:\n- {candidates[0]}\n- {candidates[1]}"
    )


def inference_supports_progress_path(inference_script: Path) -> bool:
    try:
        contents = inference_script.read_text(encoding="utf-8")
    except OSError:
        return False
    return "--progress_path" in contents


def available_video_encoders() -> set[str]:
    command = ["ffmpeg", "-hide_banner", "-encoders"]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        msg = completed.stderr.strip() or completed.stdout.strip() or "ffmpeg -encoders failed."
        raise SystemExit(msg)

    encoders: set[str] = set()
    pattern = re.compile(r"^\s*[A-Z\.]{6}\s+([^\s]+)")
    for line in completed.stdout.splitlines():
        match = pattern.match(line)
        if match:
            encoders.add(match.group(1))
    return encoders


def resolve_video_encoder(preferred: str) -> str:
    available = available_video_encoders()
    candidates = [preferred]
    candidates.extend(codec for codec in DEFAULT_VIDEO_ENCODERS if codec != preferred)
    for codec in candidates:
        if codec in available:
            return codec
    raise SystemExit(f"No supported FFmpeg video encoder is available. Tried: {', '.join(candidates)}")


def fallback_bitrate(width: int, height: int) -> str:
    pixels = width * height
    if pixels >= 1080 * 1920:
        return "8M"
    if pixels >= 1280 * 720:
        return "4M"
    return "2M"


def video_encode_args(codec: str, *, fallback_rate: str) -> list[str]:
    args = ["-c:v", codec, "-pix_fmt", "yuv420p"]
    if codec == "libx264":
        args.extend(["-preset", "veryfast", "-crf", "18"])
        return args
    if codec == "libopenh264":
        args.extend(["-profile:v", "high", "-b:v", fallback_rate])
        return args
    if codec == "mpeg4":
        args.extend(["-q:v", "2"])
        return args
    return args


def ffprobe_stream_info(video_path: Path) -> dict[str, object]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate,avg_frame_rate,duration:stream_tags=rotate:stream_side_data=rotation",
        "-of",
        "json",
        str(video_path),
    ]
    raw = capture_command(command)
    payload = json.loads(raw)
    streams = payload.get("streams", [])
    if not streams:
        raise SystemExit(f"No video stream found in {video_path}")
    stream = streams[0]
    rotation = 0.0
    tags = stream.get("tags") or {}
    rotate_tag = tags.get("rotate")
    if rotate_tag is not None:
        try:
            rotation = float(rotate_tag)
        except Exception:
            rotation = 0.0
    for side_data in stream.get("side_data_list") or []:
        if "rotation" in side_data:
            try:
                rotation = float(side_data["rotation"])
            except Exception:
                pass
            break
    stream["rotation"] = rotation
    return stream


def parse_frame_rate(value: str | None) -> float | None:
    if not value or value == "0/0":
        return None
    try:
        return float(Fraction(value))
    except Exception:
        return None


def normalize_rotation_degrees(value: float | int | None) -> int:
    if value is None:
        return 0
    normalized = int(round(float(value))) % 360
    if normalized > 180:
        normalized -= 360
    return normalized


def build_workdir(output_root: Path, video_path: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    workdir = output_root / f"{video_path.stem}-{timestamp}"
    workdir.mkdir(parents=True, exist_ok=True)
    return workdir


def write_progress(progress_path: Path, *, phase: str, message: str, status: str = "running", extra: dict | None = None) -> None:
    payload = {
        "phase": phase,
        "message": message,
        "status": status,
        "timestamp": time.time(),
    }
    if extra:
        payload.update(extra)
    progress_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def resolve_checkpoint_path(raw_path: str) -> Path:
    checkpoint_path = Path(raw_path)
    if not checkpoint_path.is_absolute():
        checkpoint_path = (REPO_ROOT / checkpoint_path).resolve()
    return checkpoint_path


def _format_download_size(num_bytes: int) -> str:
    size_mib = num_bytes / (1024 * 1024)
    if size_mib >= 1024:
        return f"{(size_mib / 1024):.2f} GiB"
    return f"{size_mib:.1f} MiB"


def ensure_checkpoint(
    checkpoint_path: Path,
    *,
    progress_path: Path | None = None,
    checkpoint_url: str = DEFAULT_CHECKPOINT_URL,
) -> Path:
    if checkpoint_path.exists():
        return checkpoint_path

    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = checkpoint_path.with_name(f"{checkpoint_path.name}.download-{os.getpid()}")
    print(f"checkpoint_missing: {checkpoint_path}")
    print(f"checkpoint_download_url: {checkpoint_url}")

    if progress_path is not None:
        write_progress(
            progress_path,
            phase="loading_checkpoint",
            message="Downloading MatAnyone2 checkpoint for the first run.",
        )

    try:
        request = urllib_request.Request(checkpoint_url, headers={"User-Agent": "Fellini/0.1"})
        with urllib_request.urlopen(request, timeout=60) as response, temp_path.open("wb") as handle:
            content_length = response.headers.get("Content-Length")
            total_bytes = int(content_length) if content_length and content_length.isdigit() else None
            downloaded_bytes = 0
            last_progress_update = 0.0

            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                downloaded_bytes += len(chunk)

                if progress_path is None:
                    continue

                now = time.monotonic()
                if now - last_progress_update < 0.5 and total_bytes and downloaded_bytes < total_bytes:
                    continue

                if total_bytes:
                    message = (
                        "Downloading MatAnyone2 checkpoint "
                        f"({_format_download_size(downloaded_bytes)} / {_format_download_size(total_bytes)})."
                    )
                else:
                    message = (
                        "Downloading MatAnyone2 checkpoint "
                        f"({_format_download_size(downloaded_bytes)} downloaded)."
                    )
                write_progress(progress_path, phase="loading_checkpoint", message=message)
                last_progress_update = now

        temp_path.replace(checkpoint_path)
    except urllib_error.URLError as exc:
        temp_path.unlink(missing_ok=True)
        raise SystemExit(
            f"Unable to download MatAnyone2 checkpoint from {checkpoint_url}: {exc}"
        ) from exc
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    print(f"checkpoint_ready: {checkpoint_path}")
    if progress_path is not None:
        write_progress(
            progress_path,
            phase="loading_checkpoint",
            message="MatAnyone2 checkpoint ready.",
        )
    return checkpoint_path


def should_use_original_input(*, start: float, duration: float | None) -> bool:
    return start <= 0 and duration is None


def extract_clip(input_video: Path, output_video: Path, *, start: float, duration: float | None) -> None:
    command = ["ffmpeg", "-y", "-ss", str(start), "-i", str(input_video)]
    if duration is not None:
        command.extend(["-t", str(duration)])
    command.extend(["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(output_video)])
    run_command(command)


def normalize_oriented_video(input_video: Path, output_video: Path, *, rotation_degrees: int) -> None:
    filter_name: str | None
    if rotation_degrees in (-90, 270):
        filter_name = "transpose=clock"
    elif rotation_degrees in (90, -270):
        filter_name = "transpose=cclock"
    elif abs(rotation_degrees) == 180:
        filter_name = "hflip,vflip"
    else:
        filter_name = None

    command = ["ffmpeg", "-y", "-noautorotate", "-i", str(input_video)]
    if filter_name is not None:
        command.extend(["-vf", filter_name])
    command.extend(
        [
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-metadata:s:v:0",
            "rotate=0",
            str(output_video),
        ]
    )
    run_command(command)


def extract_first_frame(input_video: Path, output_frame: Path) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_video),
        "-vf",
        "select=eq(n\\,0)",
        "-vframes",
        "1",
        "-update",
        "1",
        str(output_frame),
    ]
    run_command(command)


def create_default_mask(
    first_frame_path: Path,
    mask_path: Path,
    *,
    center_x: float,
    center_y: float,
    width_ratio: float,
    height_ratio: float,
) -> None:
    image = Image.open(first_frame_path).convert("RGBA")
    width, height = image.size

    cx = width * center_x
    cy = height * center_y
    half_width = width * width_ratio / 2.0
    half_height = height * height_ratio / 2.0

    mask_image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask_image)
    draw.ellipse(
        [
            cx - half_width,
            cy - half_height,
            cx + half_width,
            cy + half_height,
        ],
        fill=255,
    )
    mask_array = np.array(mask_image, dtype=np.uint8)
    save_mask(mask_array, mask_path)


def save_mask(mask_array: np.ndarray, mask_path: Path) -> None:
    mask_image = Image.fromarray(mask_array.astype(np.uint8), mode="L")
    mask_image.save(mask_path)


def resolve_torch_device(torch_module, requested_device: str) -> str:
    requested = requested_device.strip().lower()
    if requested != "auto":
        return requested
    if getattr(torch_module.backends, "mps", None) and torch_module.backends.mps.is_available():
        return "mps"
    if torch_module.cuda.is_available():
        return "cuda"
    return "cpu"


def clamp_box(x0: float, y0: float, x1: float, y1: float, *, width: int, height: int) -> list[int]:
    x0 = max(0, min(int(round(x0)), width - 1))
    y0 = max(0, min(int(round(y0)), height - 1))
    x1 = max(x0 + 1, min(int(round(x1)), width))
    y1 = max(y0 + 1, min(int(round(y1)), height))
    return [x0, y0, x1, y1]


def clamp_point(x: float, y: float, *, width: int, height: int) -> list[float]:
    x = max(0.0, min(float(x), float(width - 1)))
    y = max(0.0, min(float(y), float(height - 1)))
    return [x, y]


def mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask > 0)
    if xs.size == 0 or ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def choose_best_person_mask(
    masks: np.ndarray,
    scores: np.ndarray | None,
    *,
    width: int,
    height: int,
    positive_points: list[list[float]],
) -> tuple[np.ndarray, int, float]:
    image_area = float(width * height)
    best_index = 0
    best_value = float("-inf")

    for index, mask in enumerate(masks):
        binary = mask > 0
        area_ratio = float(binary.sum()) / image_area
        bbox = mask_bbox(binary.astype(np.uint8))
        if bbox is None:
            continue
        x0, y0, x1, y1 = bbox
        bbox_height_ratio = float(y1 - y0 + 1) / float(height)
        bbox_width_ratio = float(x1 - x0 + 1) / float(width)
        point_hits = 0
        for px, py in positive_points:
            if binary[min(int(round(py)), height - 1), min(int(round(px)), width - 1)]:
                point_hits += 1
        score_value = float(scores[index]) if scores is not None else 0.0

        # Favor masks that include head + torso points and occupy a tall portion of the frame.
        heuristic = (
            point_hits * 10.0
            + area_ratio * 12.0
            + bbox_height_ratio * 6.0
            + bbox_width_ratio * 2.0
            + score_value * 1.5
        )

        # Penalize tiny masks that usually correspond to the face only.
        if area_ratio < 0.04:
            heuristic -= 8.0
        if bbox_height_ratio < 0.22:
            heuristic -= 6.0

        if heuristic > best_value:
            best_index = index
            best_value = heuristic

    return masks[best_index], best_index, best_value


def expand_box(box: list[float], *, width: int, height: int, pad_x_ratio: float, pad_top_ratio: float, pad_bottom_ratio: float) -> list[int]:
    x0, y0, x1, y1 = box
    box_width = max(1.0, float(x1 - x0))
    box_height = max(1.0, float(y1 - y0))
    return clamp_box(
        x0 - box_width * pad_x_ratio,
        y0 - box_height * pad_top_ratio,
        x1 + box_width * pad_x_ratio,
        y1 + box_height * pad_bottom_ratio,
        width=width,
        height=height,
    )


def choose_best_person_detection(
    boxes: np.ndarray,
    scores: np.ndarray,
    *,
    width: int,
    height: int,
) -> tuple[list[int], float] | None:
    image_area = float(width * height)
    image_cx = width / 2.0
    best_box: list[int] | None = None
    best_value = float("-inf")

    for box, score in zip(boxes, scores):
        x0, y0, x1, y1 = [float(v) for v in box]
        area_ratio = max(0.0, (x1 - x0) * (y1 - y0)) / image_area
        cx = (x0 + x1) / 2.0
        center_penalty = abs(cx - image_cx) / max(1.0, image_cx)
        heuristic = score * 4.0 + area_ratio * 6.0 - center_penalty * 1.5
        if heuristic > best_value:
            best_value = heuristic
            best_box = clamp_box(x0, y0, x1, y1, width=width, height=height)

    if best_box is None:
        return None
    return best_box, best_value


def detect_person_box(
    first_frame_path: Path,
    *,
    requested_device: str,
    score_threshold: float,
) -> dict[str, object] | None:
    import torch
    from torchvision.models.detection import (
        FasterRCNN_MobileNet_V3_Large_320_FPN_Weights,
        fasterrcnn_mobilenet_v3_large_320_fpn,
    )

    image = Image.open(first_frame_path).convert("RGB")
    width, height = image.size
    weights = FasterRCNN_MobileNet_V3_Large_320_FPN_Weights.DEFAULT
    categories = weights.meta["categories"]
    person_label = categories.index("person")
    detector_device = resolve_torch_device(torch, requested_device)
    preprocess = weights.transforms()

    model = fasterrcnn_mobilenet_v3_large_320_fpn(weights=weights).to(detector_device)
    model.eval()

    image_tensor = preprocess(image).to(detector_device)
    with torch.inference_mode():
        prediction = model([image_tensor])[0]

    labels = prediction["labels"].detach().cpu().numpy()
    boxes = prediction["boxes"].detach().cpu().numpy()
    scores = prediction["scores"].detach().cpu().numpy()

    keep = (labels == person_label) & (scores >= score_threshold)
    if not np.any(keep):
        return None

    chosen = choose_best_person_detection(boxes[keep], scores[keep], width=width, height=height)
    if chosen is None:
        return None

    best_box, heuristic = chosen
    expanded_box = expand_box(
        best_box,
        width=width,
        height=height,
        pad_x_ratio=0.18,
        pad_top_ratio=0.22,
        pad_bottom_ratio=0.28,
    )
    return {
        "device": detector_device,
        "raw_box": best_box,
        "expanded_box": expanded_box,
        "heuristic": heuristic,
        "score_threshold": score_threshold,
    }


def create_sam2_mask(
    first_frame_path: Path,
    mask_path: Path,
    *,
    center_x: float,
    center_y: float,
    width_ratio: float,
    height_ratio: float,
    model_id: str,
    requested_device: str,
    detector_device: str,
    detector_score_threshold: float,
) -> dict[str, object]:
    import torch
    from transformers import Sam2Model, Sam2Processor

    image = Image.open(first_frame_path).convert("RGB")
    width, height = image.size

    detection = detect_person_box(
        first_frame_path,
        requested_device=detector_device,
        score_threshold=detector_score_threshold,
    )
    if detection is not None:
        prompt_box = detection["expanded_box"]
        x0, y0, x1, y1 = prompt_box
        cx = (x0 + x1) / 2.0
        cy = (y0 + y1) / 2.0
        half_width = (x1 - x0) / 2.0
        half_height = (y1 - y0) / 2.0
    else:
        cx = width * center_x
        cy = height * center_y
        half_width = width * width_ratio / 2.0
        half_height = height * height_ratio / 2.0
        prompt_box = clamp_box(
            cx - half_width,
            cy - half_height,
            cx + half_width,
            cy + half_height,
            width=width,
            height=height,
        )
    positive_points = [
        clamp_point(cx, cy - half_height * 0.45, width=width, height=height),  # head
        clamp_point(cx, cy, width=width, height=height),  # upper torso
        clamp_point(cx, cy + half_height * 0.35, width=width, height=height),  # lower torso
    ]
    input_labels = [[[1, 1, 1]]]

    device = resolve_torch_device(torch, requested_device)
    processor = Sam2Processor.from_pretrained(model_id)
    model = Sam2Model.from_pretrained(model_id).to(device)
    model.eval()

    inputs = processor(
        images=image,
        input_boxes=[[prompt_box]],
        input_points=[[positive_points]],
        input_labels=input_labels,
        return_tensors="pt",
    )
    original_sizes = inputs["original_sizes"].cpu()
    reshaped_input_sizes = inputs["reshaped_input_sizes"].cpu()
    inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in inputs.items()}

    with torch.inference_mode():
        outputs = model(**inputs)

    masks = processor.post_process_masks(
        outputs.pred_masks.cpu(),
        original_sizes=original_sizes,
        reshaped_input_sizes=reshaped_input_sizes,
    )
    mask_tensor = masks[0]
    if hasattr(outputs, "iou_scores") and outputs.iou_scores is not None:
        score_tensor = outputs.iou_scores.cpu()[0]
        flat_scores = score_tensor.reshape(-1)
    else:
        flat_scores = None

    flat_masks = mask_tensor.reshape(-1, mask_tensor.shape[-2], mask_tensor.shape[-1])
    flat_masks_np = flat_masks.numpy()
    flat_scores_np = flat_scores.numpy() if flat_scores is not None and flat_scores.numel() == flat_masks.shape[0] else None
    best_mask, best_index, best_heuristic = choose_best_person_mask(
        flat_masks_np,
        flat_scores_np,
        width=width,
        height=height,
        positive_points=positive_points,
    )
    best_score = float(flat_scores_np[best_index]) if flat_scores_np is not None else None
    binary_mask = np.where(best_mask > 0, 255, 0).astype(np.uint8)
    save_mask(binary_mask, mask_path)

    return {
        "device": device,
        "model_id": model_id,
        "prompt_box": prompt_box,
        "positive_points": positive_points,
        "best_score": best_score,
        "best_index": best_index,
        "best_heuristic": best_heuristic,
        "person_detection": detection,
    }
def has_audio_stream(video_path: Path) -> bool:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=index",
        "-of",
        "json",
        str(video_path),
    ]
    raw = capture_command(command)
    payload = json.loads(raw)
    return bool(payload.get("streams"))


def mux_original_audio(foreground_video: Path, audio_source_video: Path, output_video: Path) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(foreground_video),
        "-i",
        str(audio_source_video),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-shortest",
        str(output_video),
    ]
    run_command(command)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run MatAnyone/MatAnyone2 inside the backend env.")
    parser.add_argument("--video", required=True, help="Path to the source video, relative to the repo root or absolute.")
    parser.add_argument(
        "--matanyone-root",
        help="Path to a local MatAnyone checkout. Defaults to MATANYONE_ROOT or third_party/MatAnyone2.",
    )
    parser.add_argument(
        "--matanyone-repo-url",
        default=DEFAULT_MATANYONE_REPO_URL,
        help="Git repository used to auto-clone MatAnyone2 when missing.",
    )
    parser.add_argument(
        "--matanyone-ref",
        default=DEFAULT_MATANYONE_REF,
        help="Git ref used when auto-cloning MatAnyone2.",
    )
    parser.add_argument(
        "--output-root",
        default="test-videos/matanyone-runs",
        help="Directory where output artifacts will be written.",
    )
    parser.add_argument(
        "--output-dir",
        help="Exact directory where output artifacts will be written. Overrides --output-root timestamped layout.",
    )
    parser.add_argument(
        "--checkpoint",
        default="pretrained_models/matanyone2.pth",
        help="Checkpoint cache path relative to repo root.",
    )
    parser.add_argument(
        "--checkpoint-url",
        default=DEFAULT_CHECKPOINT_URL,
        help="URL used to auto-download the MatAnyone2 checkpoint when missing.",
    )
    parser.add_argument("--start", type=float, default=0.0, help="Clip start time in seconds.")
    parser.add_argument(
        "--duration",
        type=float,
        default=0.0,
        help="Clip duration in seconds. Use 0 or a negative value to process the full original video.",
    )
    parser.add_argument("--max-size", type=int, default=256, help="MatAnyone max_size argument.")
    parser.add_argument("--warmup", type=int, default=1, help="MatAnyone warmup iterations.")
    parser.add_argument("--mask", help="Optional first-frame mask to use instead of an auto-generated ellipse.")
    parser.add_argument("--center-x", type=float, default=0.50, help="Auto-mask center X ratio.")
    parser.add_argument("--center-y", type=float, default=0.52, help="Auto-mask center Y ratio.")
    parser.add_argument("--mask-width-ratio", type=float, default=0.42, help="Auto-mask width ratio.")
    parser.add_argument("--mask-height-ratio", type=float, default=0.82, help="Auto-mask height ratio.")
    parser.add_argument(
        "--mask-generator",
        choices=("sam2", "ellipse"),
        default="sam2",
        help="How to generate the first-frame mask when --mask is not provided.",
    )
    parser.add_argument(
        "--sam2-model",
        default="facebook/sam2.1-hiera-small",
        help="Hugging Face model id used when --mask-generator sam2.",
    )
    parser.add_argument(
        "--sam2-device",
        default="auto",
        help="Device for the SAM2 first-frame segmentation step: auto|mps|cuda|cpu.",
    )
    parser.add_argument(
        "--person-detector-device",
        default="cpu",
        help="Device for the first-frame person detector: auto|mps|cuda|cpu.",
    )
    parser.add_argument(
        "--person-detector-threshold",
        type=float,
        default=0.35,
        help="Minimum confidence for the first-frame person detector.",
    )
    parser.add_argument(
        "--enable-mps-fallback",
        action="store_true",
        help="Set PYTORCH_ENABLE_MPS_FALLBACK=1 for the inference subprocess.",
    )
    parser.add_argument(
        "--preserve-audio",
        action="store_true",
        help="Mux the original audio back into the foreground output when the source video has audio.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    require_executable("ffmpeg")
    require_executable("ffprobe")

    try:
        import torch
    except ModuleNotFoundError as exc:
        raise SystemExit(f"torch is not installed in this environment: {exc}") from exc

    missing_modules = find_missing_modules(require_sam2=(not args.mask and args.mask_generator == "sam2"))
    if missing_modules:
        joined = ", ".join(missing_modules)
        raise SystemExit(
            "Missing Python dependencies in backend env: "
            f"{joined}\n"
            "Install them in backend/.venv before running this command.\n"
            "Example: cd backend && poetry install --with dev,asr,llm,vision"
        )

    video_path = Path(args.video)
    if not video_path.is_absolute():
        video_path = (REPO_ROOT / video_path).resolve()
    if not video_path.exists():
        raise SystemExit(f"Video not found: {video_path}")

    checkpoint_path = resolve_checkpoint_path(args.checkpoint)

    if args.output_dir:
        workdir = Path(args.output_dir)
        if not workdir.is_absolute():
            workdir = (REPO_ROOT / workdir).resolve()
        workdir.mkdir(parents=True, exist_ok=True)
    else:
        output_root = Path(args.output_root)
        if not output_root.is_absolute():
            output_root = (REPO_ROOT / output_root).resolve()
        workdir = build_workdir(output_root, video_path)

    progress_path = workdir / "progress.json"
    write_progress(progress_path, phase="setup", message="Resolving environment and preparing background removal run.")

    matanyone_root = ensure_matanyone_root(
        args.matanyone_root,
        progress_path=progress_path,
        repo_url=args.matanyone_repo_url,
        repo_ref=args.matanyone_ref,
    )
    inference_script = resolve_inference_script(matanyone_root)
    checkpoint_path = ensure_checkpoint(
        checkpoint_path,
        progress_path=progress_path,
        checkpoint_url=args.checkpoint_url,
    )

    duration_value = args.duration if args.duration and args.duration > 0 else None
    use_original_input = should_use_original_input(start=args.start, duration=duration_value)
    clip_path = workdir / "input_clip.mp4"
    normalized_input_path = workdir / "normalized_input.mp4"
    first_frame_path = workdir / "first_frame.png"
    generated_mask_path = workdir / "generated_mask.png"
    benchmark_path = workdir / "benchmark.json"

    print(f"python_executable: {sys.executable}")
    print(f"torch_version: {torch.__version__}")
    print(f"mps_available: {torch.backends.mps.is_available()}")
    print(f"matanyone_root: {matanyone_root}")
    print(f"inference_script: {inference_script}")
    print(f"checkpoint_path: {checkpoint_path}")
    print(f"video_path: {video_path}")
    print(f"output_dir: {workdir}")
    print(f"progress_json: {progress_path}")

    write_progress(progress_path, phase="setup", message="Validated environment and resolved paths.")

    if use_original_input:
        input_video_for_inference = video_path
    else:
        write_progress(progress_path, phase="preparing_input", message="Creating trimmed input clip.")
        extract_clip(video_path, clip_path, start=args.start, duration=duration_value)
        input_video_for_inference = clip_path

    input_stream_info = ffprobe_stream_info(input_video_for_inference)
    source_rotation = normalize_rotation_degrees(input_stream_info.get("rotation"))
    if source_rotation != 0:
        write_progress(
            progress_path,
            phase="normalizing_orientation",
            message="Normalizing rotated video so mask and frames share the same geometry.",
            extra={"source_rotation_degrees": source_rotation},
        )
        normalize_oriented_video(input_video_for_inference, normalized_input_path, rotation_degrees=source_rotation)
        input_video_for_inference = normalized_input_path
        input_stream_info = ffprobe_stream_info(input_video_for_inference)

    write_progress(progress_path, phase="extracting_first_frame", message="Extracting first frame for mask setup.")
    extract_first_frame(input_video_for_inference, first_frame_path)

    if args.mask:
        mask_path = Path(args.mask)
        if not mask_path.is_absolute():
            mask_path = (REPO_ROOT / mask_path).resolve()
        if not mask_path.exists():
            raise SystemExit(f"Mask not found: {mask_path}")
        print(f"using_mask: {mask_path}")
    else:
        if args.mask_generator == "sam2":
            write_progress(
                progress_path,
                phase="generating_mask",
                message="Generating first-frame mask with SAM2.",
                extra={"sam2_model": args.sam2_model, "sam2_device": args.sam2_device},
            )
            sam2_info = create_sam2_mask(
                first_frame_path,
                generated_mask_path,
                center_x=args.center_x,
                center_y=args.center_y,
                width_ratio=args.mask_width_ratio,
                height_ratio=args.mask_height_ratio,
                model_id=args.sam2_model,
                requested_device=args.sam2_device,
                detector_device=args.person_detector_device,
                detector_score_threshold=args.person_detector_threshold,
            )
            print(f"sam2_model: {sam2_info['model_id']}")
            print(f"sam2_device: {sam2_info['device']}")
            print(f"sam2_prompt_box: {sam2_info['prompt_box']}")
            print(f"sam2_positive_points: {sam2_info['positive_points']}")
            print(f"sam2_best_index: {sam2_info['best_index']}")
            print(f"sam2_best_heuristic: {sam2_info['best_heuristic']:.4f}")
            if sam2_info["best_score"] is not None:
                print(f"sam2_best_score: {sam2_info['best_score']:.4f}")
            if sam2_info["person_detection"] is not None:
                print(f"person_detector_device: {sam2_info['person_detection']['device']}")
                print(f"person_detector_raw_box: {sam2_info['person_detection']['raw_box']}")
                print(f"person_detector_expanded_box: {sam2_info['person_detection']['expanded_box']}")
                print(f"person_detector_heuristic: {sam2_info['person_detection']['heuristic']:.4f}")
            else:
                print("person_detector: no person found, fell back to centered box")
        else:
            write_progress(progress_path, phase="generating_mask", message="Generating default talking-head ellipse mask.")
            create_default_mask(
                first_frame_path,
                generated_mask_path,
                center_x=args.center_x,
                center_y=args.center_y,
                width_ratio=args.mask_width_ratio,
                height_ratio=args.mask_height_ratio,
            )
        mask_path = generated_mask_path
        print(f"generated_mask: {mask_path}")

    stream_info = input_stream_info
    clip_seconds = float(stream_info.get("duration") or 0.0)
    fps = parse_frame_rate(stream_info.get("avg_frame_rate")) or parse_frame_rate(stream_info.get("r_frame_rate"))

    command = [
        sys.executable,
        str(inference_script),
        "-i",
        str(input_video_for_inference),
        "-m",
        str(mask_path),
        "-c",
        str(checkpoint_path),
        "-o",
        str(workdir),
        "--max_size",
        str(args.max_size),
        "-w",
        str(args.warmup),
    ]
    if inference_supports_progress_path(inference_script):
        command.extend(["--progress_path", str(progress_path)])

    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    env["PYTHONPATH"] = (
        f"{matanyone_root}{os.pathsep}{existing_pythonpath}" if existing_pythonpath else str(matanyone_root)
    )
    if args.enable_mps_fallback:
        env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

    write_progress(progress_path, phase="inferencing", message="Running MatAnyone2 inference.")
    start_time = time.perf_counter()
    run_command(command, cwd=REPO_ROOT, env=env)
    wall_seconds = time.perf_counter() - start_time

    foreground_candidates = sorted(workdir.glob("*_fgr.mp4"))
    foreground_path = foreground_candidates[0] if foreground_candidates else None
    foreground_with_audio_path = workdir / "foreground-with-audio.mp4"

    if foreground_path is not None and args.preserve_audio and has_audio_stream(video_path):
        write_progress(progress_path, phase="muxing_audio", message="Muxing original audio into foreground video.")
        mux_original_audio(foreground_path, video_path, foreground_with_audio_path)

    benchmark = {
        "created_at": datetime.now().isoformat(),
        "video_path": str(video_path),
        "input_video_for_inference": str(input_video_for_inference),
        "clip_path": (str(clip_path) if clip_path.exists() else None),
        "normalized_input_path": (str(normalized_input_path) if normalized_input_path.exists() else None),
        "source_rotation_degrees": source_rotation,
        "clip_duration_seconds": clip_seconds,
        "clip_fps": fps,
        "wall_seconds": wall_seconds,
        "video_seconds_per_wall_second": (clip_seconds / wall_seconds) if wall_seconds and clip_seconds else None,
        "estimated_input_frames": (clip_seconds * fps) if clip_seconds and fps else None,
        "estimated_frames_per_wall_second": ((clip_seconds * fps) / wall_seconds) if wall_seconds and clip_seconds and fps else None,
        "torch_version": torch.__version__,
        "mps_available_in_launcher": bool(torch.backends.mps.is_available()),
        "matanyone_root": str(matanyone_root),
        "inference_script": str(inference_script),
        "mask_path": str(mask_path),
        "mask_generator": args.mask_generator if not args.mask else "user-supplied",
        "sam2_model": (args.sam2_model if not args.mask and args.mask_generator == "sam2" else None),
        "sam2_device": (args.sam2_device if not args.mask and args.mask_generator == "sam2" else None),
        "foreground_path": str(foreground_path) if foreground_path else None,
        "foreground_with_audio_path": (str(foreground_with_audio_path) if foreground_with_audio_path.exists() else None),
        "command": command,
    }
    benchmark_path.write_text(json.dumps(benchmark, indent=2), encoding="utf-8")
    write_progress(
        progress_path,
        phase="completed",
        message="Runner completed and benchmark metadata saved.",
        status="completed",
        extra={"benchmark_json": str(benchmark_path)},
    )

    print("\nRun complete.")
    print(f"benchmark_json: {benchmark_path}")
    if foreground_path:
        print(f"foreground_video: {foreground_path}")
    if foreground_with_audio_path.exists():
        print(f"foreground_with_audio_video: {foreground_with_audio_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

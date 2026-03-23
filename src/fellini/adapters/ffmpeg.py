from __future__ import annotations

import json
import re
import shlex
import shutil
import subprocess
from pathlib import Path

from fellini.domain.models import EditDecisionList, ProbeInfo, RenderConfig
from fellini.settings import AppSettings


class FFmpegError(RuntimeError):
    pass


class FFmpegAdapter:
    DEFAULT_VIDEO_ENCODERS = ("libx264", "libopenh264", "mpeg4")

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self._available_encoders_cache: set[str] | None = None

    def _run(self, args: list[str]) -> None:
        completed = subprocess.run(args, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            stderr = completed.stderr.strip()
            stdout = completed.stdout.strip()
            msg = (
                f"Command failed: {' '.join(shlex.quote(arg) for arg in args)}\n{stderr or stdout}"
            )
            raise FFmpegError(msg)

    def probe_media(self, source: Path) -> ProbeInfo:
        args = [
            self.settings.ffprobe_bin,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(source),
        ]
        completed = subprocess.run(args, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            msg = (
                completed.stderr.strip()
                or completed.stdout.strip()
                or f"ffprobe failed for {source}"
            )
            raise FFmpegError(msg)

        payload = json.loads(completed.stdout)
        streams = payload.get("streams", [])
        fmt = payload.get("format", {})
        video_stream = next(
            (stream for stream in streams if stream.get("codec_type") == "video"), {}
        )
        audio_stream = next(
            (stream for stream in streams if stream.get("codec_type") == "audio"), None
        )
        fps = self._parse_rate(
            video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate") or "0/1"
        )

        return ProbeInfo(
            path=str(source),
            duration_seconds=float(fmt.get("duration", 0.0) or 0.0),
            width=int(video_stream.get("width", 0) or 0),
            height=int(video_stream.get("height", 0) or 0),
            fps=fps,
            sample_rate=int(audio_stream["sample_rate"])
            if audio_stream and audio_stream.get("sample_rate")
            else None,
            has_audio=audio_stream is not None,
            format_name=fmt.get("format_name"),
        )

    def create_mezzanine(self, sources: list[Path], target: Path, temp_dir: Path) -> None:
        normalized_paths: list[Path] = []
        for index, source in enumerate(sources):
            normalized = temp_dir / f"normalized_{index:02d}.mp4"
            self._normalize_clip(source, normalized)
            normalized_paths.append(normalized)

        if len(normalized_paths) == 1:
            shutil.copyfile(normalized_paths[0], target)
            return

        concat_list = temp_dir / "concat.txt"
        self._write_concat_list(concat_list, normalized_paths)
        args = [
            self.settings.ffmpeg_bin,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(target),
        ]
        self._run(args)

    def extract_audio(self, source: Path, target: Path) -> None:
        args = [
            self.settings.ffmpeg_bin,
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(target),
        ]
        self._run(args)

    def render_from_edl(self, source: Path, edl: EditDecisionList, output_dir: Path) -> Path:
        segment_dir = output_dir / "segments"
        segment_dir.mkdir(parents=True, exist_ok=True)
        video_codec = self._resolve_video_encoder("libx264")

        segment_paths: list[Path] = []
        for index, keep_range in enumerate(edl.keep_ranges):
            duration = max(0.05, keep_range.end - keep_range.start)
            segment_path = segment_dir / f"segment_{index:03d}.mp4"
            args = [
                self.settings.ffmpeg_bin,
                "-y",
                "-i",
                str(source),
                "-ss",
                f"{keep_range.start:.3f}",
                "-t",
                f"{duration:.3f}",
            ]
            args.extend(
                self._video_encode_args(
                    video_codec,
                    preset="veryfast",
                    crf=18,
                    fallback_bitrate="4M",
                )
            )
            args.extend(
                [
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                ]
            )
            if duration > 0.12:
                fade = min(0.02, duration / 4)
                args.extend(
                    [
                        "-af",
                        (
                            f"afade=t=in:st=0:d={fade:.3f},"
                            f"afade=t=out:st={duration - fade:.3f}:d={fade:.3f}"
                        ),
                    ]
                )
            args.append(str(segment_path))
            self._run(args)
            segment_paths.append(segment_path)

        if not segment_paths:
            msg = "No keep ranges available for render."
            raise FFmpegError(msg)

        concat_list = output_dir / "segments.txt"
        self._write_concat_list(concat_list, segment_paths)
        edited_master = output_dir / "edited_master.mp4"
        args = [
            self.settings.ffmpeg_bin,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(edited_master),
        ]
        self._run(args)
        return edited_master

    def render_vertical(
        self,
        source: Path,
        target: Path,
        render_config: RenderConfig,
        subtitles_path: Path | None = None,
    ) -> None:
        filters = [
            f"scale={render_config.width}:{render_config.height}:force_original_aspect_ratio=increase",
            f"crop={render_config.width}:{render_config.height}",
        ]
        if subtitles_path:
            filters.append(self._subtitle_filter(subtitles_path, render_config))

        video_codec = self._resolve_video_encoder(render_config.video_codec)
        args = [
            self.settings.ffmpeg_bin,
            "-y",
            "-i",
            str(source),
            "-vf",
            ",".join(filters),
        ]
        args.extend(
            self._video_encode_args(
                video_codec,
                preset=render_config.preset,
                crf=render_config.crf,
                fallback_bitrate=self._fallback_bitrate(render_config.width, render_config.height),
            )
        )
        args.extend(
            [
                "-c:a",
                render_config.audio_codec,
                "-b:a",
                render_config.audio_bitrate,
                str(target),
            ]
        )
        self._run(args)

    def _normalize_clip(self, source: Path, target: Path) -> None:
        video_codec = self._resolve_video_encoder("libx264")
        args = [
            self.settings.ffmpeg_bin,
            "-y",
            "-i",
            str(source),
        ]
        args.extend(
            self._video_encode_args(
                video_codec,
                preset="veryfast",
                crf=18,
                fallback_bitrate="4M",
            )
        )
        args.extend(
            [
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-movflags",
                "+faststart",
                str(target),
            ]
        )
        self._run(args)

    @staticmethod
    def _parse_rate(rate: str) -> float:
        numerator, denominator = rate.split("/", maxsplit=1)
        if denominator == "0":
            return 0.0
        return float(numerator) / float(denominator)

    def _subtitle_filter(self, subtitles_path: Path, render_config: RenderConfig) -> str:
        escaped_path = self._escape_filter_path(subtitles_path)
        options = [
            f"filename='{escaped_path}'",
            f"original_size={render_config.width}x{render_config.height}",
        ]
        if self.settings.fonts_dir:
            options.append(f"fontsdir='{self._escape_filter_path(self.settings.fonts_dir)}'")
        return f"subtitles={':'.join(options)}"

    @staticmethod
    def _escape_filter_path(path: Path) -> str:
        return str(path).replace("\\", r"\\").replace(":", r"\:").replace("'", r"\'")

    @staticmethod
    def _write_concat_list(list_path: Path, paths: list[Path]) -> None:
        list_path.write_text(
            "".join(f"file '{path.resolve().as_posix()}'\n" for path in paths),
            encoding="utf-8",
        )

    def _resolve_video_encoder(self, preferred: str) -> str:
        available = self._available_encoders()
        candidates = [preferred]
        candidates.extend(codec for codec in self.DEFAULT_VIDEO_ENCODERS if codec != preferred)

        for codec in candidates:
            if codec in available:
                return codec

        msg = f"No supported FFmpeg video encoder is available. Tried: {', '.join(candidates)}"
        raise FFmpegError(msg)

    def _available_encoders(self) -> set[str]:
        if self._available_encoders_cache is not None:
            return self._available_encoders_cache

        args = [self.settings.ffmpeg_bin, "-hide_banner", "-encoders"]
        completed = subprocess.run(args, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            msg = completed.stderr.strip() or completed.stdout.strip() or "ffmpeg -encoders failed."
            raise FFmpegError(msg)

        encoders: set[str] = set()
        pattern = re.compile(r"^\s*[A-Z\.]{6}\s+([^\s]+)")
        for line in completed.stdout.splitlines():
            match = pattern.match(line)
            if match:
                encoders.add(match.group(1))

        self._available_encoders_cache = encoders
        return encoders

    def _video_encode_args(
        self,
        codec: str,
        *,
        preset: str,
        crf: int,
        fallback_bitrate: str,
    ) -> list[str]:
        args = ["-c:v", codec, "-pix_fmt", "yuv420p"]

        if codec == "libx264":
            args.extend(["-preset", preset, "-crf", str(crf)])
            return args

        if codec == "libopenh264":
            args.extend(["-profile:v", "high", "-b:v", fallback_bitrate])
            return args

        if codec == "mpeg4":
            args.extend(["-q:v", "2"])
            return args

        args.extend(["-preset", preset, "-crf", str(crf)])
        return args

    @staticmethod
    def _fallback_bitrate(width: int, height: int) -> str:
        pixels = width * height
        if pixels >= 1080 * 1920:
            return "8M"
        if pixels >= 1280 * 720:
            return "4M"
        return "2M"

from __future__ import annotations

import math
import json
import re
import shlex
import shutil
import subprocess
import sys
from array import array
from pathlib import Path

from fellini.domain.models import (
    EditDecisionList,
    EditorialProject,
    ProbeInfo,
    RenderConfig,
    TimelineClip,
    TimelineTrack,
    TimelineTrackKind,
)
from fellini.log import get_logger
from fellini.settings import AppSettings

logger = get_logger(__name__)


class FFmpegError(RuntimeError):
    pass


class FFmpegAdapter:
    DEFAULT_VIDEO_ENCODERS = ("libx264", "libopenh264", "mpeg4")

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self._available_encoders_cache: set[str] | None = None

    def _run(self, args: list[str]) -> None:
        logger.debug("ffmpeg.run command=%s", " ".join(shlex.quote(arg) for arg in args))
        completed = subprocess.run(args, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            stderr = completed.stderr.strip()
            stdout = completed.stdout.strip()
            logger.error(
                "ffmpeg.run.failed code=%s stderr=%s stdout=%s",
                completed.returncode,
                stderr,
                stdout,
            )
            msg = (
                f"Command failed: {' '.join(shlex.quote(arg) for arg in args)}\n{stderr or stdout}"
            )
            raise FFmpegError(msg)
        logger.debug("ffmpeg.run.done code=%s", completed.returncode)

    def probe_media(self, source: Path) -> ProbeInfo:
        logger.info("ffmpeg.probe source=%s", source)
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

        probe = ProbeInfo(
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
        logger.info(
            "ffmpeg.probe.done source=%s duration=%.3f size=%sx%s fps=%.3f has_audio=%s",
            source,
            probe.duration_seconds,
            probe.width,
            probe.height,
            probe.fps,
            probe.has_audio,
        )
        return probe

    def create_mezzanine(self, sources: list[Path], target: Path, temp_dir: Path) -> None:
        logger.info("ffmpeg.create_mezzanine sources=%s target=%s", [str(source) for source in sources], target)
        normalized_paths: list[Path] = []
        for index, source in enumerate(sources):
            normalized = temp_dir / f"normalized_{index:02d}.mp4"
            self._normalize_clip(source, normalized)
            normalized_paths.append(normalized)

        if len(normalized_paths) == 1:
            shutil.copyfile(normalized_paths[0], target)
            logger.info("ffmpeg.create_mezzanine.done target=%s mode=copy_single", target)
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
        logger.info("ffmpeg.create_mezzanine.done target=%s mode=concat", target)

    def extract_audio(self, source: Path, target: Path) -> None:
        logger.info("ffmpeg.extract_audio source=%s target=%s", source, target)
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
        logger.info("ffmpeg.extract_audio.done target=%s", target)

    def generate_filmstrip(
        self,
        source: Path,
        target: Path,
        *,
        duration_seconds: float,
        interval_seconds: float = 2.0,
        max_frames: int = 120,
        cell_width: int = 48,
        cell_height: int = 36,
    ) -> dict[str, int | float]:
        frame_count = max(1, min(max_frames, math.ceil(max(duration_seconds, 0.01) / interval_seconds)))
        fps = max(frame_count / max(duration_seconds, interval_seconds), 0.01)
        logger.info(
            "ffmpeg.generate_filmstrip source=%s target=%s frames=%s fps=%.4f",
            source,
            target,
            frame_count,
            fps,
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        args = [
            self.settings.ffmpeg_bin,
            "-y",
            "-i",
            str(source),
            "-vf",
            (
                f"fps={fps:.6f},"
                f"scale={cell_width}:{cell_height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,"
                f"pad={cell_width}:{cell_height}:(ow-iw)/2:(oh-ih)/2:black,"
                f"tile={frame_count}x1"
            ),
            "-frames:v",
            "1",
            str(target),
        ]
        self._run(args)
        return {
            "frame_count": frame_count,
            "cell_width": cell_width,
            "cell_height": cell_height,
            "interval_seconds": interval_seconds,
        }

    def build_waveform_peaks(
        self,
        source: Path,
        *,
        duration_seconds: float,
        bucket_count: int,
        sample_rate: int = 8000,
    ) -> list[int]:
        logger.info(
            "ffmpeg.build_waveform_peaks source=%s buckets=%s sample_rate=%s",
            source,
            bucket_count,
            sample_rate,
        )
        args = [
            self.settings.ffmpeg_bin,
            "-v",
            "error",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-f",
            "s16le",
            "-",
        ]
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if process.stdout is None or process.stderr is None:
            process.kill()
            msg = "ffmpeg waveform pipe could not be opened."
            raise FFmpegError(msg)

        total_samples = max(1, math.ceil(max(duration_seconds, 0.01) * sample_rate))
        peaks = [0] * max(1, bucket_count)
        sample_index = 0
        try:
            while True:
                chunk = process.stdout.read(32768)
                if not chunk:
                    break
                samples = array("h")
                samples.frombytes(chunk[: len(chunk) - (len(chunk) % 2)])
                if sys.byteorder != "little":
                    samples.byteswap()
                for sample in samples:
                    bucket_index = min(
                        len(peaks) - 1,
                        (sample_index * len(peaks)) // total_samples,
                    )
                    amplitude = min(255, round((abs(sample) / 32767) * 255))
                    if amplitude > peaks[bucket_index]:
                        peaks[bucket_index] = amplitude
                    sample_index += 1
        finally:
            if process.stdout:
                process.stdout.close()

        stderr = process.stderr.read().decode("utf-8", errors="replace").strip()
        if process.stderr:
            process.stderr.close()
        return_code = process.wait()
        if return_code != 0:
            msg = stderr or f"ffmpeg waveform decode failed for {source}"
            raise FFmpegError(msg)
        return peaks

    def render_from_edl(self, source: Path, edl: EditDecisionList, output_dir: Path) -> Path:
        logger.info(
            "ffmpeg.render_from_edl source=%s keep_ranges=%s output_dir=%s",
            source,
            len(edl.keep_ranges),
            output_dir,
        )
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
        logger.info("ffmpeg.render_from_edl.done edited_master=%s", edited_master)
        return edited_master

    def render_vertical(
        self,
        source: Path,
        target: Path,
        render_config: RenderConfig,
        subtitles_path: Path | None = None,
    ) -> None:
        logger.info(
            "ffmpeg.render_vertical source=%s target=%s resolution=%sx%s subtitles=%s",
            source,
            target,
            render_config.width,
            render_config.height,
            subtitles_path,
        )
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
        logger.info("ffmpeg.render_vertical.done target=%s", target)

    def mix_audio_lane(
        self,
        *,
        workspace_root: Path,
        project: EditorialProject,
        track_id: str,
        target: Path,
        sample_rate: int = 16000,
    ) -> None:
        track = next((item for item in project.tracks if item.id == track_id), None)
        if not track or track.kind != TimelineTrackKind.audio:
            msg = f"Track {track_id} is not an audio lane."
            raise FFmpegError(msg)

        clips = self._sorted_track_clips(project, track)
        if not clips:
            msg = f"Audio lane {track_id} is empty."
            raise FFmpegError(msg)

        inputs, input_indexes = self._project_inputs(workspace_root, project, start_index=0)
        filters: list[str] = []
        audio_labels: list[str] = []
        for clip_index, clip in enumerate(clips):
            label = f"a{clip_index}"
            asset_index = input_indexes[clip.asset_id]
            delay_ms = max(0, round(clip.start * 1000))
            duration = max(0.02, clip.source_out - clip.source_in)
            chain = [
                f"[{asset_index}:a]atrim=start={clip.source_in:.3f}:end={clip.source_out:.3f}",
                "asetpts=PTS-STARTPTS",
            ]
            if clip.audio.gain != 1.0:
                chain.append(f"volume={clip.audio.gain:.4f}")
            if clip.audio.fade_in_ms > 0:
                chain.append(f"afade=t=in:st=0:d={clip.audio.fade_in_ms / 1000:.3f}")
            if clip.audio.fade_out_ms > 0:
                fade_out_start = max(0.0, duration - (clip.audio.fade_out_ms / 1000))
                chain.append(
                    f"afade=t=out:st={fade_out_start:.3f}:d={clip.audio.fade_out_ms / 1000:.3f}"
                )
            chain.append(f"adelay={delay_ms}|{delay_ms}")
            filters.append(",".join(chain) + f"[{label}]")
            audio_labels.append(f"[{label}]")

        if len(audio_labels) == 1:
            filters.append(f"{audio_labels[0]}anull[mixout]")
        else:
            filters.append(
                "".join(audio_labels) + f"amix=inputs={len(audio_labels)}:dropout_transition=0:normalize=0[mixout]"
            )

        args = [self.settings.ffmpeg_bin, "-y"]
        for path in inputs:
            args.extend(["-i", str(path)])
        args.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[mixout]",
                "-ac",
                "1",
                "-ar",
                str(sample_rate),
                "-c:a",
                "pcm_s16le",
                str(target),
            ]
        )
        self._run(args)
        logger.info("ffmpeg.mix_audio_lane.done track=%s target=%s", track_id, target)

    def render_project_master(
        self,
        *,
        workspace_root: Path,
        project: EditorialProject,
        render_config: RenderConfig,
        target: Path,
    ) -> None:
        inputs, input_indexes = self._project_inputs(workspace_root, project, start_index=1)
        video_tracks = sorted(
            [track for track in project.tracks if track.kind == TimelineTrackKind.video and track.visible],
            key=lambda item: item.order,
        )
        audio_tracks = sorted(
            [track for track in project.tracks if track.kind == TimelineTrackKind.audio and not track.muted],
            key=lambda item: item.order,
        )
        duration = self._project_duration(project)
        if duration <= 0:
            msg = "Editorial project has no timeline duration."
            raise FFmpegError(msg)

        filters: list[str] = []
        overlay_inputs: list[str] = []
        audio_labels: list[str] = []

        for track in video_tracks:
            for clip in self._sorted_track_clips(project, track):
                asset_index = input_indexes[clip.asset_id]
                label = f"v{len(overlay_inputs)}"
                filters.append(
                    ",".join(
                        [
                            f"[{asset_index}:v]trim=start={clip.source_in:.3f}:end={clip.source_out:.3f}",
                            f"setpts=PTS-STARTPTS+{clip.start:.3f}/TB",
                            f"scale={render_config.width}:{render_config.height}:force_original_aspect_ratio=decrease",
                            "setsar=1",
                        ]
                    )
                    + f"[{label}]"
                )
                overlay_inputs.append(f"[{label}]")

        for track in audio_tracks:
            for clip in self._sorted_track_clips(project, track):
                asset_index = input_indexes[clip.asset_id]
                label = f"a{len(audio_labels)}"
                delay_ms = max(0, round(clip.start * 1000))
                duration_clip = max(0.02, clip.source_out - clip.source_in)
                chain = [
                    f"[{asset_index}:a]atrim=start={clip.source_in:.3f}:end={clip.source_out:.3f}",
                    "asetpts=PTS-STARTPTS",
                ]
                if clip.audio.gain != 1.0:
                    chain.append(f"volume={clip.audio.gain:.4f}")
                if clip.audio.fade_in_ms > 0:
                    chain.append(f"afade=t=in:st=0:d={clip.audio.fade_in_ms / 1000:.3f}")
                if clip.audio.fade_out_ms > 0:
                    fade_out_start = max(0.0, duration_clip - (clip.audio.fade_out_ms / 1000))
                    chain.append(
                        f"afade=t=out:st={fade_out_start:.3f}:d={clip.audio.fade_out_ms / 1000:.3f}"
                    )
                chain.append(f"adelay={delay_ms}|{delay_ms}")
                filters.append(",".join(chain) + f"[{label}]")
                audio_labels.append(f"[{label}]")

        args = [
            self.settings.ffmpeg_bin,
            "-y",
            "-f",
            "lavfi",
            "-i",
            (
                f"color=c=black:s={render_config.width}x{render_config.height}:"
                f"r={max(1, round(project.sequence.fps or 30.0))}:d={duration:.3f}"
            ),
        ]
        for path in inputs:
            args.extend(["-i", str(path)])
        args.extend(
            [
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=channel_layout=stereo:sample_rate={project.sequence.sample_rate}:d={duration:.3f}",
            ]
        )

        base_label = "[0:v]"
        for overlay_index, overlay_label in enumerate(overlay_inputs):
            next_label = f"[vcomp{overlay_index}]"
            filters.append(
                (
                    f"{base_label}{overlay_label}"
                    f"overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:eof_action=pass"
                    f"{next_label}"
                )
            )
            base_label = next_label

        final_video = base_label
        anull_index = len(inputs) + 1
        if audio_labels:
            audio_inputs = "".join(audio_labels) + f"[{anull_index}:a]"
            filters.append(
                f"{audio_inputs}amix=inputs={len(audio_labels) + 1}:dropout_transition=0:normalize=0[aout]"
            )
        else:
            filters.append(f"[{anull_index}:a]anull[aout]")

        video_codec = self._resolve_video_encoder(render_config.video_codec)
        args.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                final_video,
                "-map",
                "[aout]",
            ]
        )
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
                "-t",
                f"{duration:.3f}",
                str(target),
            ]
        )
        self._run(args)
        logger.info("ffmpeg.render_project_master.done target=%s", target)

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

    @staticmethod
    def _project_duration(project: EditorialProject) -> float:
        max_end = 0.0
        for clip in project.clips:
            if clip.enabled:
                max_end = max(max_end, clip.end)
        return max_end

    @staticmethod
    def _sorted_track_clips(
        project: EditorialProject, track: TimelineTrack
    ) -> list[TimelineClip]:
        return sorted(
            [
                clip
                for clip in project.clips
                if clip.track_id == track.id
                and clip.enabled
                and (track.kind != TimelineTrackKind.audio or not clip.audio.muted)
            ],
            key=lambda item: (item.start, item.z_index, item.id),
        )

    @staticmethod
    def _project_inputs(
        workspace_root: Path, project: EditorialProject, *, start_index: int
    ) -> tuple[list[Path], dict[str, int]]:
        inputs: list[Path] = []
        input_indexes: dict[str, int] = {}
        for asset in project.assets:
            target = workspace_root / asset.path
            input_indexes[asset.id] = len(inputs) + start_index
            inputs.append(target)
        return inputs, input_indexes

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

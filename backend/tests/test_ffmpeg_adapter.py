from subprocess import CompletedProcess

from fellini.adapters.ffmpeg import FFmpegAdapter
from fellini.settings import AppSettings


def test_ffmpeg_adapter_falls_back_when_libx264_is_missing(tmp_path, monkeypatch):
    adapter = FFmpegAdapter(AppSettings(workspace_root=tmp_path / "workspace"))

    def fake_run(args, capture_output, text, check):
        if "-encoders" in args:
            output = (
                "Encoders:\n"
                " V....D libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10\n"
                " V.S... mpeg4               MPEG-4 part 2\n"
            )
            return CompletedProcess(args, 0, stdout=output, stderr="")
        raise AssertionError(f"Unexpected command: {args}")

    monkeypatch.setattr("fellini.adapters.ffmpeg.subprocess.run", fake_run)

    assert adapter._resolve_video_encoder("libx264") == "libopenh264"
    assert adapter._video_encode_args(
        "libopenh264",
        preset="veryfast",
        crf=18,
        fallback_bitrate="4M",
    ) == ["-c:v", "libopenh264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-b:v", "4M"]


def test_ffmpeg_adapter_uses_requested_encoder_when_available(tmp_path, monkeypatch):
    adapter = FFmpegAdapter(AppSettings(workspace_root=tmp_path / "workspace"))

    def fake_run(args, capture_output, text, check):
        if "-encoders" in args:
            output = (
                "Encoders:\n"
                " V....D libx264             libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10\n"
                " V....D libopenh264         OpenH264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10\n"
            )
            return CompletedProcess(args, 0, stdout=output, stderr="")
        raise AssertionError(f"Unexpected command: {args}")

    monkeypatch.setattr("fellini.adapters.ffmpeg.subprocess.run", fake_run)

    assert adapter._resolve_video_encoder("libx264") == "libx264"
    assert adapter._fallback_bitrate(1080, 1920) == "8M"


def test_ffmpeg_concat_list_uses_absolute_paths(tmp_path):
    list_path = tmp_path / "segments.txt"
    media_path = tmp_path / "nested" / "segment_000.mp4"
    media_path.parent.mkdir(parents=True, exist_ok=True)
    media_path.write_bytes(b"fake")

    FFmpegAdapter._write_concat_list(list_path, [media_path])

    content = list_path.read_text(encoding="utf-8")
    assert content == f"file '{media_path.resolve().as_posix()}'\n"

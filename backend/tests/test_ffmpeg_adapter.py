from subprocess import CompletedProcess

from fellini.adapters.ffmpeg import FFmpegAdapter
from fellini.domain.models import (
    ClipCrop,
    ClipTransform,
    EditorialProject,
    ProjectAsset,
    ProjectAssetKind,
    ProjectSequence,
    RenderConfig,
    TimelineClip,
    TimelineTrack,
    TimelineTrackKind,
)
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


def test_ffmpeg_render_project_master_uses_sequence_state_and_timeline_geometry(tmp_path, monkeypatch):
    adapter = FFmpegAdapter(AppSettings(workspace_root=tmp_path / "workspace"))
    commands: list[list[str]] = []
    monkeypatch.setattr(adapter, "_resolve_video_encoder", lambda preferred: "libx264")
    monkeypatch.setattr(adapter, "_run", lambda args: commands.append(args))

    project = EditorialProject(
        sequence=ProjectSequence(
            width=720,
            height=1280,
            fps=25.0,
            sample_rate=44100,
            background="#112233",
        ),
        assets=[
            ProjectAsset(
                id="asset_back",
                kind=ProjectAssetKind.video,
                label="Back",
                path="uploads/back.mp4",
                duration=8.0,
                width=1280,
                height=720,
                has_audio=False,
            ),
            ProjectAsset(
                id="asset_front",
                kind=ProjectAssetKind.video,
                label="Front",
                path="uploads/front.mp4",
                duration=8.0,
                width=1920,
                height=1080,
                has_audio=True,
            ),
            ProjectAsset(
                id="asset_audio",
                kind=ProjectAssetKind.audio,
                label="Voice",
                path="uploads/voice.wav",
                duration=8.0,
                sample_rate=44100,
                has_audio=True,
            ),
        ],
        tracks=[
            TimelineTrack(id="track_video_top", kind=TimelineTrackKind.video, name="Video 1", order=0),
            TimelineTrack(
                id="track_video_back",
                kind=TimelineTrackKind.video,
                name="Video 2",
                order=1,
            ),
            TimelineTrack(id="track_audio_1", kind=TimelineTrackKind.audio, name="Audio 1", order=2),
        ],
        clips=[
            TimelineClip(
                id="clip_front",
                asset_id="asset_front",
                track_id="track_video_top",
                start=1.0,
                source_in=0.0,
                source_out=2.0,
                transform=ClipTransform(
                    x=32.0,
                    y=18.0,
                    scale=1.15,
                    rotation=15.0,
                    opacity=0.7,
                    crop=ClipCrop(left=120.0, top=60.0, right=120.0, bottom=60.0),
                ),
            ),
            TimelineClip(
                id="clip_back",
                asset_id="asset_back",
                track_id="track_video_back",
                start=0.0,
                source_in=0.0,
                source_out=3.0,
            ),
            TimelineClip(
                id="clip_audio",
                asset_id="asset_audio",
                track_id="track_audio_1",
                start=0.0,
                source_in=0.0,
                source_out=2.5,
            ),
        ],
    )

    adapter.render_project_master(
        workspace_root=tmp_path,
        project=project,
        render_config=RenderConfig(),
        target=tmp_path / "output.mp4",
    )

    assert len(commands) == 1
    command = commands[0]
    serialized = " ".join(command)
    filter_complex = command[command.index("-filter_complex") + 1]

    assert adapter._project_duration(project) == 3.0
    assert [clip.id for clip in adapter._video_render_clips(project)] == [
        "clip_back",
        "clip_front",
    ]
    assert "color=c=0x112233:s=720x1280:r=25:d=3.000" in serialized
    assert "sample_rate=44100:d=3.000" in serialized
    assert "crop=1680:960:120:60" in filter_complex
    assert "rotate=0.261799:ow=rotw(iw):oh=roth(ih):c=none" in filter_complex
    assert "colorchannelmixer=aa=0.700000" in filter_complex
    assert "overlay=x='(main_w-overlay_w)/2+32.000000':y='(main_h-overlay_h)/2-18.000000'" in filter_complex
    assert filter_complex.index("[1:v]") < filter_complex.index("[2:v]")

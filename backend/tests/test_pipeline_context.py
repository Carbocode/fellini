import json

from fellini.domain.models import (
    CaptionArtifact,
    CaptionChunk,
    JobRequest,
    PipelineState,
    ProbeInfo,
    TranscriptArtifact,
    TranscriptSegment,
    WordTiming,
)
from fellini.pipeline.context import PipelineContext
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings


def test_load_state_prefers_updated_artifacts_over_cached_pipeline_snapshot(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = JobStore(settings)
    workspace = JobWorkspace(settings.projects_root, "job123")
    workspace.bootstrap()

    workspace.mezzanine_path.write_bytes(b"video")
    workspace.audio_path.write_bytes(b"audio")
    workspace.artifact_path("01_media_probe.json").write_text(
        json.dumps(
            {
                "sources": [
                    ProbeInfo(
                        path="input.mp4",
                        duration_seconds=12.0,
                        width=720,
                        height=1280,
                        fps=30.0,
                    ).model_dump(mode="json")
                ]
            }
        ),
        encoding="utf-8",
    )

    stale_aligned = TranscriptArtifact(
        language="it",
        source="stale-snapshot",
        segments=[
            TranscriptSegment(
                id="seg_0000",
                start=0.0,
                end=0.5,
                text="vecchio testo",
                words=[WordTiming(text="vecchio", start=0.0, end=0.5)],
            )
        ],
    )
    fresh_aligned = TranscriptArtifact(
        language="it",
        source="fresh-artifact",
        segments=[
            TranscriptSegment(
                id="seg_0000",
                start=0.0,
                end=0.5,
                text="nuovo testo",
                words=[WordTiming(text="nuovo", start=0.0, end=0.5)],
            )
        ],
    )
    stale_captions = CaptionArtifact(
        chunks=[
            CaptionChunk(
                start=0.0,
                end=0.5,
                words=[WordTiming(text="vecchio", start=0.0, end=0.5)],
                display_words=["vecchio"],
            )
        ]
    )
    fresh_captions = CaptionArtifact(
        chunks=[
            CaptionChunk(
                start=0.0,
                end=0.5,
                words=[WordTiming(text="nuovo", start=0.0, end=0.5)],
                display_words=["nuovo"],
            )
        ]
    )

    workspace.state_path.write_text(
        PipelineState(
            aligned_transcript=stale_aligned,
            captions=stale_captions,
        ).model_dump_json(indent=2),
        encoding="utf-8",
    )
    workspace.artifact_path("04_transcript_aligned.json").write_text(
        fresh_aligned.model_dump_json(indent=2),
        encoding="utf-8",
    )
    workspace.artifact_path("07_caption_display.json").write_text(
        fresh_captions.model_dump_json(indent=2),
        encoding="utf-8",
    )

    context = PipelineContext(
        settings=settings,
        request=JobRequest(),
        workspace=workspace,
        store=store,
    )
    context.load_state()

    assert context.state.aligned_transcript is not None
    assert context.state.aligned_transcript.source == "fresh-artifact"
    assert context.state.aligned_transcript.segments[0].text == "nuovo testo"
    assert context.state.captions is not None
    assert context.state.captions.chunks[0].display_words == ["nuovo"]

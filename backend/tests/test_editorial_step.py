from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from fellini.adapters.decision import RuleBasedDecisionEngine
from fellini.domain.models import (
    AudioTrackRole,
    ClipOrigin,
    EditorialProject,
    JobRequest,
    ProjectSelection,
    ProjectSequence,
    TimelineClip,
    TimelineTrack,
    TimelineTrackKind,
    TranscriptArtifact,
    TranscriptSegment,
    WordTiming,
)
from fellini.pipeline.steps.editorial import EditorialStep
from fellini.services.editorial_project import EditorialProjectStore
from fellini.settings import AppSettings


def test_editorial_step_updates_editorial_lane_without_generating_timeline_clips(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    project = EditorialProject(
        sequence=ProjectSequence(),
        selection=ProjectSelection(),
        tracks=[
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1", order=0),
            TimelineTrack(id="track_subtitle_1", kind=TimelineTrackKind.subtitle, name="Editorial", order=1),
            TimelineTrack(
                id="track_audio_1",
                kind=TimelineTrackKind.audio,
                name="Audio 1",
                order=2,
                role=AudioTrackRole.story,
            ),
        ],
        clips=[
            TimelineClip(
                id="clip_manual_video",
                asset_id="asset_source",
                track_id="track_video_1",
                start=0.0,
                source_in=0.0,
                source_out=2.0,
                origin=ClipOrigin.manual,
            ),
            TimelineClip(
                id="clip_generated_video",
                asset_id="asset_source",
                track_id="track_video_1",
                start=0.0,
                source_in=0.0,
                source_out=1.0,
                origin=ClipOrigin.generated,
            ),
        ],
    )
    transcript = TranscriptArtifact(
        language="it",
        source="story-lane-clips:track_audio_1",
        segments=[
            TranscriptSegment(
                id="seg_0001",
                start=0.0,
                end=0.8,
                text="eh ciao",
                words=[
                    WordTiming(text="eh", start=0.0, end=0.15, confidence=0.95),
                    WordTiming(text="ciao", start=0.3, end=0.55, confidence=0.98),
                ],
            )
        ],
    )

    class FakeEditorialProjects:
        def __init__(self) -> None:
            self.saved_project: EditorialProject | None = None

        def ensure(self, _context) -> EditorialProject:
            return project

        def story_lane(self, current: EditorialProject) -> TimelineTrack | None:
            return store.story_lane(current)

        def story_lane_editorial_transcript(self, _current: EditorialProject) -> TranscriptArtifact | None:
            return transcript

        def clear_generated_clips(self, current: EditorialProject) -> EditorialProject:
            return store.clear_generated_clips(current)

        def replace_editorial_result_captions(
            self,
            current: EditorialProject,
            *,
            story_lane_id: str,
            spans,
        ) -> EditorialProject:
            return store.replace_editorial_result_captions(
                current,
                story_lane_id=story_lane_id,
                spans=spans,
            )

        def save(self, _workspace, current: EditorialProject) -> EditorialProject:
            self.saved_project = current
            return current

    fake_projects = FakeEditorialProjects()
    workspace = SimpleNamespace(
        editorial_project_path=Path("editorial_project.json"),
        relative=lambda path: str(path),
    )
    context = SimpleNamespace(
        editorial_projects=fake_projects,
        state=SimpleNamespace(
            duration_seconds=2.0,
            aligned_transcript=transcript,
            raw_transcript=None,
            labeled_spans=[],
            edl=None,
            captions=None,
            render_plan=None,
        ),
        request=JobRequest(),
        decision_engine=RuleBasedDecisionEngine(),
        llm_refiner=SimpleNamespace(refine=lambda spans, **_: spans),
        transcriber=SimpleNamespace(_empty_transcript=lambda *args, **kwargs: transcript),
        workspace=workspace,
        save_json_artifact=lambda filename, payload: filename,
        report_progress=lambda *args, **kwargs: None,
    )

    EditorialStep().run(context)

    assert fake_projects.saved_project is not None
    assert [clip.id for clip in fake_projects.saved_project.clips] == ["clip_manual_video"]
    assert [caption.text for caption in fake_projects.saved_project.captions] == [
        "CUT: eh",
        "KEEP: ciao",
    ]

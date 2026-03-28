from fellini.domain.models import (
    ClipOrigin,
    EditorialProject,
    ProjectSequence,
    TimelineClip,
    TimelineTrack,
    TimelineTrackKind,
)
from fellini.services.editorial_project import EditorialProjectStore
from fellini.settings import AppSettings


def test_normalize_linked_clip_groups_pairs_matching_video_and_audio(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
        tracks=[
            TimelineTrack(id="video_1", kind=TimelineTrackKind.video, name="Video 1"),
            TimelineTrack(id="audio_1", kind=TimelineTrackKind.audio, name="Audio 1"),
        ],
        clips=[
            TimelineClip(
                id="clip_video",
                asset_id="asset_source",
                track_id="video_1",
                start=12.0,
                source_in=3.0,
                source_out=8.0,
                origin=ClipOrigin.generated,
            ),
            TimelineClip(
                id="clip_audio",
                asset_id="asset_source",
                track_id="audio_1",
                start=12.0,
                source_in=3.0,
                source_out=8.0,
                origin=ClipOrigin.generated,
            ),
        ],
    )

    normalized, changed = store._normalize_linked_clip_groups(project)

    assert changed is True
    assert normalized.clips[0].linked_group_id is not None
    assert normalized.clips[0].linked_group_id == normalized.clips[1].linked_group_id


def test_normalize_linked_clip_groups_preserves_existing_group_id(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
        tracks=[
            TimelineTrack(id="video_1", kind=TimelineTrackKind.video, name="Video 1"),
            TimelineTrack(id="audio_1", kind=TimelineTrackKind.audio, name="Audio 1"),
        ],
        clips=[
            TimelineClip(
                id="clip_video",
                asset_id="asset_source",
                track_id="video_1",
                linked_group_id="link_existing",
                start=0.0,
                source_in=0.0,
                source_out=5.0,
                origin=ClipOrigin.manual,
            ),
            TimelineClip(
                id="clip_audio",
                asset_id="asset_source",
                track_id="audio_1",
                start=0.0,
                source_in=0.0,
                source_out=5.0,
                origin=ClipOrigin.manual,
            ),
        ],
    )

    normalized, changed = store._normalize_linked_clip_groups(project)

    assert changed is True
    assert normalized.clips[0].linked_group_id == "link_existing"
    assert normalized.clips[1].linked_group_id == "link_existing"

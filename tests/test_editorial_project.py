from fellini.domain.models import (
    AudioTrackRole,
    ClipOrigin,
    EditorialProject,
    LaneTranscription,
    ProjectSelection,
    ProjectSequence,
    SourceWordRef,
    SubtitleBlock,
    TranscriptArtifact,
    TimelineClip,
    TimelineTrack,
    TimelineTrackKind,
    TranscriptSegment,
    WordTiming,
)
from fellini.services.editorial_project import EditorialProjectStore
from fellini.services.workspace import JobWorkspace
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


def test_normalize_track_layout_bootstraps_two_mirrored_pairs(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
        tracks=[
            TimelineTrack(
                id="track_video_1",
                kind=TimelineTrackKind.video,
                name="Video 1",
                order=0,
            ),
            TimelineTrack(
                id="track_audio_1",
                kind=TimelineTrackKind.audio,
                name="Audio 1",
                order=1,
                role=AudioTrackRole.story,
            ),
            TimelineTrack(
                id="track_subtitle_1",
                kind=TimelineTrackKind.subtitle,
                name="Subtitles",
                order=2,
            ),
        ],
    )

    normalized, changed = store._normalize_track_layout(project)

    assert changed is True
    assert [track.name for track in normalized.tracks] == [
        "Video 2",
        "Video 1",
        "Audio 1",
        "Audio 2",
    ]
    assert [track.order for track in normalized.tracks] == [0, 1, 2, 3]


def test_normalize_track_layout_adds_new_pair_when_all_pairs_are_occupied(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
        tracks=[
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1", order=0),
            TimelineTrack(
                id="track_audio_1",
                kind=TimelineTrackKind.audio,
                name="Audio 1",
                order=1,
                role=AudioTrackRole.story,
            ),
            TimelineTrack(id="track_video_2", kind=TimelineTrackKind.video, name="Video 2", order=2),
            TimelineTrack(
                id="track_audio_2",
                kind=TimelineTrackKind.audio,
                name="Audio 2",
                order=3,
                role=AudioTrackRole.support,
            ),
            TimelineTrack(
                id="track_subtitle_1",
                kind=TimelineTrackKind.subtitle,
                name="Subtitles",
                order=4,
            ),
        ],
        clips=[
            TimelineClip(
                id="clip_v1",
                asset_id="asset_source",
                track_id="track_video_1",
                start=0.0,
                source_in=0.0,
                source_out=2.0,
                origin=ClipOrigin.manual,
            ),
            TimelineClip(
                id="clip_v2",
                asset_id="asset_source",
                track_id="track_video_2",
                start=0.0,
                source_in=0.0,
                source_out=2.0,
                origin=ClipOrigin.manual,
            ),
        ],
    )

    normalized, changed = store._normalize_track_layout(project)

    assert changed is True
    assert [track.name for track in normalized.tracks] == [
        "Video 3",
        "Video 2",
        "Video 1",
        "Audio 1",
        "Audio 2",
        "Audio 3",
    ]


def test_set_lane_transcription_uses_free_video_lane_for_generated_subtitles(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    workspace = JobWorkspace(settings.jobs_root, "job_subtitles_host")
    workspace.bootstrap()
    project = EditorialProject(
        sequence=ProjectSequence(),
        selection=ProjectSelection(),
        tracks=[
            TimelineTrack(id="track_video_2", kind=TimelineTrackKind.video, name="Video 2", order=0),
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1", order=1),
            TimelineTrack(
                id="track_audio_1",
                kind=TimelineTrackKind.audio,
                name="Audio 1",
                order=2,
                role=AudioTrackRole.story,
            ),
            TimelineTrack(
                id="track_audio_2",
                kind=TimelineTrackKind.audio,
                name="Audio 2",
                order=3,
                role=AudioTrackRole.support,
            ),
        ],
        clips=[
            TimelineClip(
                id="clip_video_1",
                asset_id="asset_source",
                track_id="track_video_1",
                start=0.0,
                source_in=0.0,
                source_out=2.0,
                origin=ClipOrigin.manual,
            ),
            TimelineClip(
                id="clip_audio_1",
                asset_id="asset_source",
                track_id="track_audio_1",
                start=0.0,
                source_in=0.0,
                source_out=2.0,
                origin=ClipOrigin.manual,
            ),
        ],
    )

    updated = store.set_lane_transcription(
        workspace,
        project=project,
        lane_id="track_audio_1",
        transcript=TranscriptArtifact(
            language="it",
            source="test-lane",
            segments=[
                TranscriptSegment(
                    id="seg_1",
                    start=0.0,
                    end=0.8,
                    text="ciao lane",
                    words=[
                        WordTiming(text="ciao", start=0.0, end=0.4, confidence=1.0),
                        WordTiming(text="lane", start=0.42, end=0.8, confidence=1.0),
                    ],
                )
            ],
        ),
        source_audio_path="temp/lane_track_audio_1_bounce.wav",
    )

    assert updated.lane_transcriptions[0].lane_id == "track_audio_1"
    assert [caption.track_id for caption in updated.captions] == ["track_video_2", "track_video_2"]
    assert [caption.text for caption in updated.captions] == ["ciao", "lane"]


def test_normalize_generated_subtitles_upgrades_segment_blocks_to_word_level(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
        tracks=[
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1", order=0),
            TimelineTrack(id="track_audio_1", kind=TimelineTrackKind.audio, name="Audio 1", order=1),
            TimelineTrack(
                id="track_subtitle_1",
                kind=TimelineTrackKind.subtitle,
                name="Subtitles",
                order=2,
            ),
        ],
        captions=[
            SubtitleBlock(
                id="subtitle_lane_0000",
                track_id="track_subtitle_1",
                source_lane_id="track_audio_1",
                start=0.0,
                end=0.8,
                text="ciao lane",
                origin=ClipOrigin.generated,
                source_word_refs=[
                    SourceWordRef(segment_id="seg_1", word_index=0),
                    SourceWordRef(segment_id="seg_1", word_index=1),
                ],
            )
        ],
        lane_transcriptions=[
            LaneTranscription(
                lane_id="track_audio_1",
                language="it",
                segments=[
                    TranscriptSegment(
                        id="seg_1",
                        start=0.0,
                        end=0.8,
                        text="ciao lane",
                        words=[
                            WordTiming(text="ciao", start=0.0, end=0.4, confidence=1.0),
                            WordTiming(text="lane", start=0.42, end=0.8, confidence=1.0),
                        ],
                    )
                ],
            )
        ],
    )

    normalized, changed = store._normalize_generated_subtitles(project)

    assert changed is True
    assert [caption.text for caption in normalized.captions] == ["ciao", "lane"]
    assert [len(caption.source_word_refs) for caption in normalized.captions] == [1, 1]

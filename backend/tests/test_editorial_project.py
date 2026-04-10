import json

from fellini.domain.models import (
    AssetBackgroundRemoval,
    AssetTranscription,
    AssetTranscriptionWord,
    AssetPreviewBundle,
    AssetPreviewEntry,
    AssetPreviewStatus,
    AssetPreviewVariants,
    AssetVariantKind,
    AudioTrackRole,
    ClipOrigin,
    EditorialProject,
    LaneTranscription,
    LaneTranscriptionStatus,
    ProjectAsset,
    ProjectAssetKind,
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


def test_save_strips_runtime_asset_preview_fields(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    workspace = JobWorkspace(settings.jobs_root, "job_preview_strip")
    workspace.bootstrap()
    project = EditorialProject(
        sequence=ProjectSequence(),
        assets=[
            ProjectAsset(
                id="asset_source",
                kind=ProjectAssetKind.video,
                label="clip.mp4",
                path="uploads/clip.mp4",
                duration=5.0,
                preview=AssetPreviewVariants(
                    original=AssetPreviewBundle(
                        filmstrip=AssetPreviewEntry(
                            status=AssetPreviewStatus.ready,
                            resource_path="artifacts/previews/asset_source.original.filmstrip.png",
                        )
                    )
                ),
            )
        ],
    )

    store.save(workspace, project)

    payload = json.loads(workspace.editorial_project_path.read_text(encoding="utf-8"))
    assert payload["assets"][0]["preview"] is None


def test_load_migrates_legacy_asset_variant_from_asset_level_state(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    workspace = JobWorkspace(settings.jobs_root, "job_variant_migration")
    workspace.bootstrap()
    workspace.editorial_project_path.write_text(
        json.dumps(
            {
                "sequence": ProjectSequence().model_dump(mode="json"),
                "revision": 1,
                "updated_at": "2026-04-08T12:00:00Z",
                "tracks": [
                    TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1").model_dump(mode="json"),
                    TimelineTrack(id="track_audio_1", kind=TimelineTrackKind.audio, name="Audio 1").model_dump(mode="json"),
                ],
                "assets": [
                    ProjectAsset(
                        id="asset_source",
                        kind=ProjectAssetKind.video,
                        label="clip.mp4",
                        path="artifacts/background-removal/asset_source/cutout.mp4",
                        duration=5.0,
                        background_removal=AssetBackgroundRemoval(
                            active_variant=AssetVariantKind.cutout,
                            original_path="uploads/clip.mp4",
                            cutout_path="artifacts/background-removal/asset_source/cutout.mp4",
                        ),
                    ).model_dump(mode="json"),
                ],
                "clips": [
                    TimelineClip(
                        id="clip_video",
                        asset_id="asset_source",
                        track_id="track_video_1",
                        start=0.0,
                        source_in=0.0,
                        source_out=5.0,
                    ).model_dump(mode="json", exclude={"asset_variant"}),
                    TimelineClip(
                        id="clip_audio",
                        asset_id="asset_source",
                        track_id="track_audio_1",
                        start=0.0,
                        source_in=0.0,
                        source_out=5.0,
                    ).model_dump(mode="json", exclude={"asset_variant"}),
                ],
                "captions": [],
                "asset_transcriptions": [],
                "lane_transcriptions": [],
                "selection": ProjectSelection().model_dump(mode="json"),
            }
        ),
        encoding="utf-8",
    )

    project = store.load(workspace)

    assert project.assets[0].path == "uploads/clip.mp4"
    assert project.clips[0].asset_variant == AssetVariantKind.cutout
    assert project.clips[1].asset_variant == AssetVariantKind.original


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


def test_set_clip_transcription_replaces_only_the_selected_clip_range(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    workspace = JobWorkspace(settings.jobs_root, "job_clip_transcription")
    workspace.bootstrap()
    project = EditorialProject(
        sequence=ProjectSequence(),
        selection=ProjectSelection(),
        assets=[
            ProjectAsset(
                id="asset_source",
                kind=ProjectAssetKind.audio,
                label="Audio source",
                path="uploads/source.wav",
                duration=4.0,
                has_audio=True,
            )
        ],
        tracks=[
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1", order=0),
            TimelineTrack(
                id="track_audio_1",
                kind=TimelineTrackKind.audio,
                name="Audio 1",
                order=1,
                role=AudioTrackRole.story,
            ),
        ],
        clips=[
            TimelineClip(
                id="clip_audio_1",
                asset_id="asset_source",
                track_id="track_audio_1",
                start=5.0,
                source_in=1.0,
                source_out=2.0,
                origin=ClipOrigin.manual,
            ),
        ],
        asset_transcriptions=[
            AssetTranscription(
                asset_id="asset_source",
                language="it",
                words=[
                    AssetTranscriptionWord(
                        id="word_before",
                        start=0.5,
                        end=0.7,
                        text="prima",
                    ),
                    AssetTranscriptionWord(
                        id="word_old",
                        start=1.15,
                        end=1.35,
                        text="vecchia",
                    ),
                    AssetTranscriptionWord(
                        id="word_after",
                        start=2.2,
                        end=2.4,
                        text="dopo",
                    ),
                ],
                source_lane_id="track_audio_1",
                source_audio_path="temp/original.wav",
            )
        ],
    )

    updated = store.set_clip_transcription(
        workspace,
        project=project,
        clip_id="clip_audio_1",
        transcript=TranscriptArtifact(
            language="it",
            source="test-clip",
            segments=[
                TranscriptSegment(
                    id="seg_1",
                    start=0.0,
                    end=0.52,
                    text="ciao clip",
                    words=[
                        WordTiming(text="ciao", start=0.0, end=0.24, confidence=1.0),
                        WordTiming(text="clip", start=0.28, end=0.52, confidence=1.0),
                    ],
                )
            ],
        ),
        source_audio_path="temp/clip_audio_1_bounce.wav",
    )

    clip = next(item for item in updated.clips if item.id == "clip_audio_1")
    words = updated.asset_transcriptions[0].words

    assert clip.transcription_status == LaneTranscriptionStatus.completed
    assert clip.transcription_source_audio_path == "temp/clip_audio_1_bounce.wav"
    assert [word.text for word in words] == ["prima", "ciao", "clip", "dopo"]
    assert [(round(word.start, 2), round(word.end, 2)) for word in words[1:3]] == [
        (1.0, 1.24),
        (1.28, 1.52),
    ]
    assert [caption.text for caption in updated.captions] == ["ciao", "clip"]
    assert [round(caption.start, 2) for caption in updated.captions] == [5.0, 5.28]


def test_recover_interrupted_runtime_state_marks_lane_and_clip_failed(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    workspace = JobWorkspace(settings.jobs_root, "job_runtime_recovery")
    workspace.bootstrap()
    project = EditorialProject(
        sequence=ProjectSequence(),
        selection=ProjectSelection(),
        tracks=[
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1", order=0),
            TimelineTrack(
                id="track_audio_1",
                kind=TimelineTrackKind.audio,
                name="Audio 1",
                order=1,
                role=AudioTrackRole.story,
            ),
        ],
        clips=[
            TimelineClip(
                id="clip_audio_1",
                asset_id="asset_source",
                track_id="track_audio_1",
                start=0.0,
                source_in=0.0,
                source_out=1.0,
                origin=ClipOrigin.manual,
                transcription_status=LaneTranscriptionStatus.running,
            ),
        ],
        lane_transcriptions=[
            LaneTranscription(
                lane_id="track_audio_1",
                status=LaneTranscriptionStatus.running,
            )
        ],
    )
    store.save(workspace, project)

    changed = store.recover_interrupted_runtime_state(workspace, "retry me")
    recovered = store.load(workspace)

    assert changed is True
    assert recovered.lane_transcriptions[0].status == LaneTranscriptionStatus.failed
    assert recovered.lane_transcriptions[0].error == "retry me"
    assert recovered.clips[0].transcription_status == LaneTranscriptionStatus.failed
    assert recovered.clips[0].transcription_error == "retry me"


def test_normalize_generated_subtitles_upgrades_segment_blocks_to_word_level(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
        assets=[
            ProjectAsset(
                id="asset_source",
                kind=ProjectAssetKind.audio,
                label="Audio source",
                path="uploads/source.wav",
                duration=1.0,
                has_audio=True,
            )
        ],
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
        clips=[
            TimelineClip(
                id="clip_audio_1",
                asset_id="asset_source",
                track_id="track_audio_1",
                start=0.0,
                source_in=0.0,
                source_out=0.8,
                origin=ClipOrigin.manual,
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
    assert [caption.source_asset_id for caption in normalized.captions] == ["asset_source", "asset_source"]
    assert [caption.source_clip_id for caption in normalized.captions] == ["clip_audio_1", "clip_audio_1"]


def test_normalize_generated_subtitles_materializes_same_asset_for_multiple_clips(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
        assets=[
            ProjectAsset(
                id="asset_source",
                kind=ProjectAssetKind.audio,
                label="Audio source",
                path="uploads/source.wav",
                duration=4.0,
                has_audio=True,
                transcript_ref="asset_source",
            )
        ],
        tracks=[
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1", order=0),
            TimelineTrack(id="track_audio_1", kind=TimelineTrackKind.audio, name="Audio 1", order=1),
            TimelineTrack(id="track_audio_2", kind=TimelineTrackKind.audio, name="Audio 2", order=2),
            TimelineTrack(
                id="track_subtitle_1",
                kind=TimelineTrackKind.subtitle,
                name="Subtitles",
                order=3,
            ),
        ],
        clips=[
            TimelineClip(
                id="clip_audio_1",
                asset_id="asset_source",
                track_id="track_audio_1",
                start=0.0,
                source_in=0.0,
                source_out=1.0,
                origin=ClipOrigin.manual,
            ),
            TimelineClip(
                id="clip_audio_2",
                asset_id="asset_source",
                track_id="track_audio_2",
                start=5.0,
                source_in=0.0,
                source_out=1.0,
                origin=ClipOrigin.manual,
            ),
        ],
        asset_transcriptions=[
            AssetTranscription(
                asset_id="asset_source",
                language="it",
                words=[
                    AssetTranscriptionWord(
                        id="asset_word_asset_source_00000000_00000400_ciao",
                        start=0.0,
                        end=0.4,
                        text="ciao",
                        source_word_refs=[SourceWordRef(segment_id="seg_1", word_index=0)],
                    ),
                    AssetTranscriptionWord(
                        id="asset_word_asset_source_00000420_00000800_lane",
                        start=0.42,
                        end=0.8,
                        text="lane",
                        source_word_refs=[SourceWordRef(segment_id="seg_1", word_index=1)],
                    ),
                ],
                source_lane_id="track_audio_1",
                source_audio_path="temp/lane_track_audio_1_bounce.wav",
            )
        ],
    )

    normalized, changed = store._normalize_generated_subtitles(project)

    assert changed is True
    assert [caption.text for caption in normalized.captions] == ["ciao", "lane", "ciao", "lane"]
    assert [caption.source_clip_id for caption in normalized.captions] == [
        "clip_audio_1",
        "clip_audio_1",
        "clip_audio_2",
        "clip_audio_2",
    ]

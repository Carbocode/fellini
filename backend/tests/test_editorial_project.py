import json

from fellini.domain.models import (
    AssetBackgroundRemoval,
    AssetTranscription,
    AssetTranscriptionWord,
    AssetPreviewBundle,
    AssetPreviewEntry,
    AssetPreviewStatus,
    AssetPreviewVariants,
    AudioTrackRole,
    ClipOrigin,
    EditorialProject,
    LaneTranscription,
    LaneTranscriptionStatus,
    LabeledSpan,
    ProjectAsset,
    ProjectAssetKind,
    ProjectSelection,
    ProjectSequence,
    SpanLabel,
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
    workspace = JobWorkspace(settings.projects_root, "job_preview_strip")
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
                            resource_path="jobs/previews/asset_source/original/filmstrip.png",
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
    workspace = JobWorkspace(settings.projects_root, "job_variant_migration")
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
                        path="jobs/background-removal/asset_source/cutout.mp4",
                        duration=5.0,
                        background_removal=AssetBackgroundRemoval(
                            original_path="uploads/clip.mp4",
                            mask_video_path=None,
                        ),
                    ).model_dump(mode="json")
                    | {
                        "background_removal": {
                            "status": "idle",
                            "progress": 0.0,
                            "message": "",
                            "original_path": "uploads/clip.mp4",
                            "active_variant": "cutout",
                            "cutout_path": "jobs/background-removal/asset_source/cutout.mp4",
                        }
                    },
                ],
                "clips": [
                    TimelineClip(
                        id="clip_video",
                        asset_id="asset_source",
                        track_id="track_video_1",
                        start=0.0,
                        source_in=0.0,
                        source_out=5.0,
                    ).model_dump(mode="json", exclude={"mask_enabled"}),
                    TimelineClip(
                        id="clip_audio",
                        asset_id="asset_source",
                        track_id="track_audio_1",
                        start=0.0,
                        source_in=0.0,
                        source_out=5.0,
                    ).model_dump(mode="json", exclude={"mask_enabled"}),
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
    assert project.assets[0].background_removal is not None
    assert project.assets[0].background_removal.mask_video_path == (
        "jobs/background-removal/asset_source/cutout.mp4"
    )
    assert project.clips[0].mask_enabled is True
    assert project.clips[1].mask_enabled is False


def test_remove_asset_cleans_related_project_state_and_files(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    workspace = JobWorkspace(settings.projects_root, "job_asset_delete")
    workspace.bootstrap()

    library_media = workspace.upload_path("lib_clip.mp4")
    library_media.write_bytes(b"video")
    keep_media = workspace.upload_path("keep.wav")
    keep_media.write_bytes(b"audio")
    mask_dir = workspace.artifacts_dir / "background-removal" / "asset_library"
    mask_dir.mkdir(parents=True, exist_ok=True)
    mask_video = mask_dir / "mask.mp4"
    benchmark = mask_dir / "benchmark.json"
    progress = mask_dir / "progress.json"
    mask_video.write_bytes(b"mask")
    benchmark.write_text("{}", encoding="utf-8")
    progress.write_text("{}", encoding="utf-8")
    clip_bounce = workspace.transcription_path("asset_library", "clip_clip_audio_remove_bounce.wav")
    lane_bounce = workspace.transcription_path("asset_library", "lane_track_audio_1_bounce.wav")
    clip_bounce.write_bytes(b"clip-audio")
    lane_bounce.write_bytes(b"lane-audio")

    project = EditorialProject(
        sequence=ProjectSequence(),
        tracks=[
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1"),
            TimelineTrack(id="track_audio_1", kind=TimelineTrackKind.audio, name="Audio 1", role=AudioTrackRole.story),
            TimelineTrack(id="track_subtitle_1", kind=TimelineTrackKind.subtitle, name="Editorial"),
        ],
        assets=[
            ProjectAsset(
                id="asset_library",
                origin="library",
                kind=ProjectAssetKind.video,
                label="library.mp4",
                path=workspace.relative(library_media),
                duration=5.0,
                width=1920,
                height=1080,
                has_audio=True,
                background_removal=AssetBackgroundRemoval(
                    original_path=workspace.relative(library_media),
                    mask_video_path=workspace.relative(mask_video),
                    benchmark_path=workspace.relative(benchmark),
                    progress_path=workspace.relative(progress),
                ),
            ),
            ProjectAsset(
                id="asset_keep",
                origin="library",
                kind=ProjectAssetKind.audio,
                label="keep.wav",
                path=workspace.relative(keep_media),
                duration=3.0,
                has_audio=True,
            ),
        ],
        clips=[
            TimelineClip(
                id="clip_video_remove",
                asset_id="asset_library",
                track_id="track_video_1",
                start=0.0,
                source_in=0.0,
                source_out=5.0,
            ),
            TimelineClip(
                id="clip_audio_remove",
                asset_id="asset_library",
                track_id="track_audio_1",
                start=0.0,
                source_in=0.0,
                source_out=5.0,
                transcription_source_audio_path=workspace.relative(clip_bounce),
                transcription_status=LaneTranscriptionStatus.completed,
            ),
        ],
        captions=[
            SubtitleBlock(
                id="caption_remove",
                track_id="track_subtitle_1",
                source_lane_id="track_audio_1",
                source_clip_id="clip_audio_remove",
                source_asset_id="asset_library",
                source_asset_start=0.0,
                source_asset_end=0.5,
                start=0.0,
                end=0.5,
                text="ciao",
                origin=ClipOrigin.generated,
            ),
            SubtitleBlock(
                id="caption_manual",
                track_id="track_subtitle_1",
                source_lane_id="track_subtitle_1",
                start=1.0,
                end=1.5,
                text="manuale",
                origin=ClipOrigin.manual,
            ),
        ],
        asset_transcriptions=[
            AssetTranscription(
                asset_id="asset_library",
                language="it",
                words=[
                    AssetTranscriptionWord(
                        id="word_remove",
                        start=0.0,
                        end=0.5,
                        text="ciao",
                        source_word_refs=[SourceWordRef(segment_id="seg_remove", word_index=0)],
                    )
                ],
                source_lane_id="track_audio_1",
                source_audio_path=workspace.relative(lane_bounce),
            ),
            AssetTranscription(
                asset_id="asset_keep",
                language="it",
                words=[
                    AssetTranscriptionWord(
                        id="word_keep",
                        start=0.0,
                        end=0.5,
                        text="resta",
                        source_word_refs=[SourceWordRef(segment_id="seg_keep", word_index=0)],
                    )
                ],
            ),
        ],
        lane_transcriptions=[
            LaneTranscription(
                lane_id="track_audio_1",
                status=LaneTranscriptionStatus.completed,
                language="it",
                segments=[
                    TranscriptSegment(
                        id="seg_remove",
                        start=0.0,
                        end=0.5,
                        text="ciao",
                        words=[WordTiming(text="ciao", start=0.0, end=0.5, confidence=1.0)],
                    )
                ],
                source_audio_path=workspace.relative(lane_bounce),
            )
        ],
        selection=ProjectSelection(
            track_id="track_audio_1",
            clip_id="clip_audio_remove",
            subtitle_block_id="caption_remove",
        ),
    )
    store.save(workspace, project)

    updated = store.remove_asset(workspace, asset_id="asset_library")

    assert [asset.id for asset in updated.assets] == ["asset_keep"]
    assert updated.clips == []
    assert [item.asset_id for item in updated.asset_transcriptions] == ["asset_keep"]
    assert updated.lane_transcriptions == []
    caption_ids = {caption.id for caption in updated.captions}
    assert "caption_remove" not in caption_ids
    assert "caption_manual" in caption_ids
    assert updated.selection.clip_id is None
    assert updated.selection.subtitle_block_id is None
    assert library_media.exists() is False
    assert mask_dir.exists() is False
    assert clip_bounce.exists() is False
    assert lane_bounce.exists() is False
    assert keep_media.exists() is True


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
        "Editorial",
        "Audio 1",
        "Audio 2",
    ]
    assert [track.order for track in normalized.tracks] == [0, 1, 2, 3, 4]


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
        "Editorial",
        "Audio 1",
        "Audio 2",
        "Audio 3",
    ]


def test_set_lane_transcription_uses_editorial_lane_for_generated_subtitles(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    workspace = JobWorkspace(settings.projects_root, "job_subtitles_host")
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
        source_audio_path="jobs/transcriptions/asset_source/lane_track_audio_1_bounce.wav",
        asset_source_audio_paths={
            "asset_source": "jobs/transcriptions/asset_source/lane_track_audio_1_bounce.wav",
        },
    )

    assert updated.lane_transcriptions[0].lane_id == "track_audio_1"
    assert (
        updated.lane_transcriptions[0].source_audio_path
        == "jobs/transcriptions/asset_source/lane_track_audio_1_bounce.wav"
    )
    assert (
        updated.asset_transcriptions[0].source_audio_path
        == "jobs/transcriptions/asset_source/lane_track_audio_1_bounce.wav"
    )
    assert [caption.track_id for caption in updated.captions] == ["track_subtitle_1", "track_subtitle_1"]
    assert [caption.text for caption in updated.captions] == ["ciao", "lane"]


def test_story_lane_editorial_transcript_uses_story_clip_transcriptions(tmp_path):
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
                    AssetTranscriptionWord(id="word_before", start=0.5, end=0.7, text="prima"),
                    AssetTranscriptionWord(id="word_ciao", start=1.0, end=1.24, text="ciao"),
                    AssetTranscriptionWord(id="word_clip", start=1.28, end=1.52, text="clip"),
                    AssetTranscriptionWord(id="word_after", start=2.2, end=2.4, text="dopo"),
                ],
                source_lane_id="track_audio_1",
                source_audio_path="jobs/transcriptions/asset_source/clip_audio_1_bounce.wav",
            )
        ],
    )

    transcript = store.story_lane_editorial_transcript(project)

    assert transcript is not None
    assert transcript.source == "story-lane-clips:track_audio_1"
    assert [word.text for word in transcript.words] == ["ciao", "clip"]
    assert [(round(word.start, 2), round(word.end, 2)) for word in transcript.words] == [
        (5.0, 5.24),
        (5.28, 5.52),
    ]


def test_normalize_generated_subtitles_preserves_editorial_result_blocks(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
        tracks=[
            TimelineTrack(id="track_video_1", kind=TimelineTrackKind.video, name="Video 1", order=0),
            TimelineTrack(id="track_subtitle_1", kind=TimelineTrackKind.subtitle, name="Editorial", order=1),
            TimelineTrack(id="track_audio_1", kind=TimelineTrackKind.audio, name="Audio 1", order=2),
        ],
        captions=[
            SubtitleBlock(
                id="editorial_result_1",
                track_id="track_subtitle_1",
                source_lane_id="editorial:track_audio_1",
                start=0.0,
                end=0.8,
                text="ciao clip",
                origin=ClipOrigin.generated,
            )
        ],
        asset_transcriptions=[
            AssetTranscription(
                asset_id="asset_source",
                language="it",
                words=[],
                source_lane_id="track_audio_1",
                source_audio_path="jobs/transcriptions/asset_source/clip_audio_1_bounce.wav",
            )
        ],
    )

    normalized, changed = store._normalize_generated_subtitles(project)

    assert changed is False
    assert [caption.id for caption in normalized.captions] == ["editorial_result_1"]


def test_replace_editorial_result_captions_uses_labeled_spans_for_editorial_lane(tmp_path):
    store = EditorialProjectStore(AppSettings(workspace_root=tmp_path / "workspace"))
    project = EditorialProject(
        sequence=ProjectSequence(),
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
        captions=[
            SubtitleBlock(
                id="editorial_result_legacy",
                track_id="track_subtitle_1",
                source_lane_id="editorial:track_audio_1",
                start=0.0,
                end=0.5,
                text="legacy",
                origin=ClipOrigin.generated,
            )
        ],
    )

    updated = store.replace_editorial_result_captions(
        project,
        story_lane_id="track_audio_1",
        spans=[
            LabeledSpan(
                text="eh",
                display_text="eh",
                start=0.0,
                end=0.2,
                label=SpanLabel.cut,
                reason="filler",
            ),
            LabeledSpan(
                text="ciao",
                display_text="ciao",
                start=0.35,
                end=0.6,
                label=SpanLabel.keep,
                reason="content keep",
            ),
            LabeledSpan(
                text="oggi",
                display_text="oggi",
                start=0.62,
                end=0.82,
                label=SpanLabel.keep,
                reason="content keep",
            ),
        ],
    )

    assert [caption.source_lane_id for caption in updated.captions] == [
        "editorial:track_audio_1:CUT",
        "editorial:track_audio_1:KEEP",
    ]
    assert [caption.text for caption in updated.captions] == [
        "CUT: eh",
        "KEEP: ciao oggi",
    ]


def test_set_clip_transcription_replaces_only_the_selected_clip_range(tmp_path):
    settings = AppSettings(workspace_root=tmp_path / "workspace")
    store = EditorialProjectStore(settings)
    workspace = JobWorkspace(settings.projects_root, "job_clip_transcription")
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
        source_audio_path="jobs/transcriptions/asset_source/clip_audio_1_bounce.wav",
    )

    clip = next(item for item in updated.clips if item.id == "clip_audio_1")
    words = updated.asset_transcriptions[0].words

    assert clip.transcription_status == LaneTranscriptionStatus.completed
    assert (
        clip.transcription_source_audio_path
        == "jobs/transcriptions/asset_source/clip_audio_1_bounce.wav"
    )
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
    workspace = JobWorkspace(settings.projects_root, "job_runtime_recovery")
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
                source_audio_path="jobs/transcriptions/asset_source/lane_track_audio_1_bounce.wav",
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

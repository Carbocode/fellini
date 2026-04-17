from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator


def utcnow() -> datetime:
    return datetime.now(UTC)


class JobStatus(StrEnum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


class StepName(StrEnum):
    ingest = "ingest"
    transcription = "transcription"
    alignment = "alignment"
    editorial = "editorial"
    render = "render"


class StepStatus(StrEnum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


class RunProfile(StrEnum):
    fast = "fast"
    balanced = "balanced"
    quality = "quality"
    custom = "custom"


class ExecutionMode(StrEnum):
    automatic = "automatic"
    step_by_step = "step_by_step"


class SpanLabel(StrEnum):
    keep = "KEEP"
    cut = "CUT"
    shorten = "SHORTEN"
    maybe = "MAYBE"


class InputAsset(BaseModel):
    original_name: str
    stored_name: str
    media_kind: str = "video"


class ProjectAssetKind(StrEnum):
    video = "video"
    audio = "audio"


class AssetPreviewStatus(StrEnum):
    missing = "missing"
    generating = "generating"
    ready = "ready"
    failed = "failed"


class AssetPreviewVariantKind(StrEnum):
    original = "original"
    mask = "mask"


class AssetProcessingStatus(StrEnum):
    idle = "idle"
    running = "running"
    completed = "completed"
    failed = "failed"


class TimelineTrackKind(StrEnum):
    video = "video"
    audio = "audio"
    subtitle = "subtitle"


class AudioTrackRole(StrEnum):
    story = "story"
    support = "support"


class ClipOrigin(StrEnum):
    generated = "generated"
    manual = "manual"


class LaneTranscriptionStatus(StrEnum):
    idle = "idle"
    running = "running"
    completed = "completed"
    failed = "failed"


class ClipCrop(BaseModel):
    left: float = 0.0
    top: float = 0.0
    right: float = 0.0
    bottom: float = 0.0


class ClipTransform(BaseModel):
    x: float = 0.0
    y: float = 0.0
    scale: float = 1.0
    rotation: float = 0.0
    opacity: float = 1.0
    crop: ClipCrop = Field(default_factory=ClipCrop)


class ClipAudio(BaseModel):
    gain: float = 1.0
    muted: bool = False
    fade_in_ms: int = 0
    fade_out_ms: int = 0


class ClipTranscriptionOptions(BaseModel):
    language: str | None = None
    model: str | None = None
    beam_size: int | None = Field(default=None, ge=1, le=10)
    vad_filter: bool | None = None
    use_whisperx: bool | None = None


class ProjectAsset(BaseModel):
    id: str
    origin: str = "library"
    kind: ProjectAssetKind
    label: str
    path: str
    duration: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    sample_rate: int | None = None
    has_audio: bool = False
    transcript_ref: str | None = None
    preview: AssetPreviewVariants | None = None
    background_removal: AssetBackgroundRemoval | None = None


class AssetPreviewEntry(BaseModel):
    status: AssetPreviewStatus = AssetPreviewStatus.missing
    resource_path: str | None = None
    version: int = 1
    error: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class AssetPreviewBundle(BaseModel):
    filmstrip: AssetPreviewEntry | None = None
    waveform: AssetPreviewEntry | None = None


class AssetPreviewVariants(BaseModel):
    original: AssetPreviewBundle | None = None
    mask: AssetPreviewBundle | None = None


class AssetBackgroundRemoval(BaseModel):
    status: AssetProcessingStatus = AssetProcessingStatus.idle
    phase: str | None = None
    progress: float = 0.0
    message: str = ""
    error: str | None = None
    original_path: str | None = None
    mask_video_path: str | None = None
    benchmark_path: str | None = None
    progress_path: str | None = None
    updated_at: datetime = Field(default_factory=utcnow)


class TimelineTrack(BaseModel):
    id: str
    kind: TimelineTrackKind
    name: str
    order: int = 0
    visible: bool = True
    muted: bool = False
    locked: bool = False
    auto_generated: bool = False
    role: AudioTrackRole | None = None

    @field_validator("role")
    @classmethod
    def validate_audio_role(cls, value: AudioTrackRole | None, info) -> AudioTrackRole | None:
        kind = info.data.get("kind")
        if kind != TimelineTrackKind.audio:
            return None
        return value or AudioTrackRole.support


class TimelineClip(BaseModel):
    id: str
    asset_id: str
    track_id: str
    linked_group_id: str | None = None
    start: float = 0.0
    source_in: float = 0.0
    source_out: float = 0.0
    z_index: int = 0
    enabled: bool = True
    origin: ClipOrigin = ClipOrigin.manual
    mask_enabled: bool = False
    transform: ClipTransform = Field(default_factory=ClipTransform)
    audio: ClipAudio = Field(default_factory=ClipAudio)
    captions_enabled: bool = True
    transcription_options: ClipTranscriptionOptions = Field(default_factory=ClipTranscriptionOptions)
    transcription_status: LaneTranscriptionStatus = LaneTranscriptionStatus.idle
    transcription_message: str | None = None
    transcription_source_audio_path: str | None = None
    transcription_updated_at: datetime = Field(default_factory=utcnow)
    transcription_error: str | None = None

    @property
    def duration(self) -> float:
        return max(0.0, self.source_out - self.source_in)

    @property
    def end(self) -> float:
        return self.start + self.duration


class SourceWordRef(BaseModel):
    segment_id: str
    word_index: int


class SubtitleBlock(BaseModel):
    id: str
    track_id: str
    source_lane_id: str
    source_clip_id: str | None = None
    source_asset_id: str | None = None
    source_asset_start: float | None = None
    source_asset_end: float | None = None
    start: float
    end: float
    text: str
    origin: ClipOrigin = ClipOrigin.generated
    source_word_refs: list[SourceWordRef] = Field(default_factory=list)


class AssetTranscriptionWord(BaseModel):
    id: str
    start: float
    end: float
    text: str
    source_word_refs: list[SourceWordRef] = Field(default_factory=list)


class AssetTranscription(BaseModel):
    asset_id: str
    language: str = "it"
    words: list[AssetTranscriptionWord] = Field(default_factory=list)
    source_lane_id: str | None = None
    source_audio_path: str | None = None
    updated_at: datetime = Field(default_factory=utcnow)
    error: str | None = None


class LaneTranscription(BaseModel):
    lane_id: str
    status: LaneTranscriptionStatus = LaneTranscriptionStatus.idle
    language: str = "it"
    segments: list[TranscriptSegment] = Field(default_factory=list)
    source_audio_path: str | None = None
    updated_at: datetime = Field(default_factory=utcnow)
    error: str | None = None

    @property
    def words(self) -> list[WordTiming]:
        items: list[WordTiming] = []
        for segment in self.segments:
            items.extend(segment.words)
        return items


class ProjectSequence(BaseModel):
    width: int = 1080
    height: int = 1920
    fps: float = 30.0
    sample_rate: int = 48000
    background: str = "#000000"


class ProjectSelection(BaseModel):
    track_id: str | None = None
    clip_id: str | None = None
    subtitle_block_id: str | None = None


class EditorialProject(BaseModel):
    version: int = 1
    revision: int = 0
    sequence: ProjectSequence = Field(default_factory=ProjectSequence)
    assets: list[ProjectAsset] = Field(default_factory=list)
    tracks: list[TimelineTrack] = Field(default_factory=list)
    clips: list[TimelineClip] = Field(default_factory=list)
    captions: list[SubtitleBlock] = Field(default_factory=list)
    asset_transcriptions: list[AssetTranscription] = Field(default_factory=list)
    lane_transcriptions: list[LaneTranscription] = Field(default_factory=list)
    selection: ProjectSelection = Field(default_factory=ProjectSelection)
    updated_at: datetime = Field(default_factory=utcnow)


class PipelineToggles(BaseModel):
    use_whisperx: bool = True
    use_local_llm: bool = False
    use_diarization: bool = False
    render_clean: bool = True
    render_captioned: bool = True


class TranscriptionConfig(BaseModel):
    model: str = "large-v3"
    beam_size: int = Field(default=5, ge=1, le=10)
    vad_filter: bool = True
    condition_on_prev_text: bool = False
    word_timestamps: bool = True
    compute_type: str = "int8"
    device: str = "auto"


class SubtitleConfig(BaseModel):
    chunk_words: int = Field(default=3, ge=1, le=6)
    font_name: str = "Avenir Next"
    font_size: int = Field(default=68, ge=24, le=140)
    text_color: str = "FFFFFF"
    active_color: str = "73E3FF"
    outline_color: str = "101214"
    bottom_margin: int = Field(default=220, ge=80, le=480)
    pop_in_ms: int = Field(default=140, ge=0, le=1000)

    @field_validator("text_color", "active_color", "outline_color")
    @classmethod
    def validate_ass_color(cls, value: str) -> str:
        candidate = value.strip().lstrip("#").upper()
        if len(candidate) != 6 or any(char not in "0123456789ABCDEF" for char in candidate):
            msg = f"Invalid ASS color value: {value}"
            raise ValueError(msg)
        return candidate


class RenderConfig(BaseModel):
    width: int = Field(default=1080, ge=256)
    height: int = Field(default=1920, ge=256)
    video_codec: str = "libx264"
    audio_codec: str = "aac"
    crf: int = Field(default=18, ge=0, le=35)
    preset: str = "slow"
    audio_bitrate: str = "192k"

    @field_validator("width", "height")
    @classmethod
    def validate_even_dimension(cls, value: int) -> int:
        if value % 2 != 0:
            msg = "Render dimensions must be even numbers."
            raise ValueError(msg)
        return value


class DecisionConfig(BaseModel):
    filler_words: list[str] = Field(
        default_factory=lambda: [
            "eh",
            "ehm",
            "emm",
            "mmm",
            "uhm",
            "allora",
            "cioe",
            "cioè",
            "ok",
            "diciamo",
            "praticamente",
            "tipo",
        ]
    )
    repetition_window_seconds: float = Field(default=0.6, ge=0.1, le=2.0)
    soft_pause_threshold_seconds: float = Field(default=0.8, ge=0.05, le=4.0)
    hard_pause_threshold_seconds: float = Field(default=1.5, ge=0.1, le=6.0)
    leading_context_seconds: float = Field(default=0.4, ge=0.02, le=2.0)
    trailing_context_seconds: float = Field(default=0.4, ge=0.02, le=2.0)
    retained_pause_seconds: float = Field(default=0.5, ge=0.0, le=3.0)
    local_model_name: str = "Qwen/Qwen3-8B"


class JobRequest(BaseModel):
    title: str = "Nuovo progetto"
    profile: RunProfile = RunProfile.balanced
    execution_mode: ExecutionMode = ExecutionMode.automatic
    language: str = "it"
    editorial_notes: str = ""
    input_assets: list[InputAsset] = Field(default_factory=list)
    toggles: PipelineToggles = Field(default_factory=PipelineToggles)
    transcription: TranscriptionConfig = Field(default_factory=TranscriptionConfig)
    subtitle: SubtitleConfig = Field(default_factory=SubtitleConfig)
    render: RenderConfig = Field(default_factory=RenderConfig)
    decision: DecisionConfig = Field(default_factory=DecisionConfig)

    @classmethod
    def with_profile(cls, **kwargs: Any) -> JobRequest:
        request = cls(**kwargs)
        return request.apply_profile_overrides()

    def apply_profile_overrides(self) -> JobRequest:
        if self.profile == RunProfile.fast:
            self.transcription.compute_type = "int8"
            self.toggles.use_local_llm = False
            self.subtitle.chunk_words = min(self.subtitle.chunk_words, 3)
        elif self.profile == RunProfile.quality:
            self.transcription.compute_type = "float16"
            self.toggles.use_whisperx = True
            self.toggles.use_local_llm = True
            self.subtitle.chunk_words = max(self.subtitle.chunk_words, 3)
        return self


class ProbeInfo(BaseModel):
    path: str
    duration_seconds: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    sample_rate: int | None = None
    has_audio: bool = True
    format_name: str | None = None


class SpeechSegment(BaseModel):
    start: float
    end: float
    confidence: float = 1.0


class WordTiming(BaseModel):
    text: str
    start: float
    end: float
    confidence: float = 1.0


class TranscriptSegment(BaseModel):
    id: str
    start: float
    end: float
    text: str
    words: list[WordTiming] = Field(default_factory=list)


class TranscriptArtifact(BaseModel):
    language: str
    segments: list[TranscriptSegment] = Field(default_factory=list)
    source: str
    notes: list[str] = Field(default_factory=list)

    @property
    def words(self) -> list[WordTiming]:
        items: list[WordTiming] = []
        for segment in self.segments:
            items.extend(segment.words)
        return items


class LabeledSpan(BaseModel):
    text: str
    display_text: str
    start: float
    end: float
    label: SpanLabel
    reason: str
    risk: str = "low"
    confidence: float = 1.0
    protected: bool = False


class KeepRange(BaseModel):
    start: float
    end: float
    reason: str


class SoftCut(BaseModel):
    at: float
    audio_fade_ms: int
    video_cut: str = "hard"


class EditDecisionList(BaseModel):
    source_video: str
    keep_ranges: list[KeepRange] = Field(default_factory=list)
    soft_cuts: list[SoftCut] = Field(default_factory=list)


class CaptionChunk(BaseModel):
    start: float
    end: float
    words: list[WordTiming] = Field(default_factory=list)
    display_words: list[str] = Field(default_factory=list)


class CaptionArtifact(BaseModel):
    chunks: list[CaptionChunk] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class RenderPlan(BaseModel):
    edited_master: str | None = None
    clean_output: str | None = None
    captioned_output: str | None = None
    subtitles_path: str | None = None


class StepSnapshot(BaseModel):
    name: StepName
    status: StepStatus = StepStatus.pending
    progress: int = 0
    message: str = ""
    started_at: datetime | None = None
    finished_at: datetime | None = None
    artifacts: list[str] = Field(default_factory=list)
    can_run: bool = False
    blocked_reason: str = ""


class JobSnapshot(BaseModel):
    id: str
    title: str
    status: JobStatus = JobStatus.pending
    request: JobRequest
    steps: list[StepSnapshot]
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    current_step: StepName | None = None
    error: str | None = None
    workspace: str
    logs: list[str] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)

    def step(self, name: StepName) -> StepSnapshot:
        for item in self.steps:
            if item.name == name:
                return item
        msg = f"Unknown step {name}"
        raise KeyError(msg)


class PipelineState(BaseModel):
    probe_info: list[ProbeInfo] = Field(default_factory=list)
    duration_seconds: float = 0.0
    mezzanine_path: str | None = None
    audio_path: str | None = None
    raw_transcript: TranscriptArtifact | None = None
    aligned_transcript: TranscriptArtifact | None = None
    labeled_spans: list[LabeledSpan] = Field(default_factory=list)
    edl: EditDecisionList | None = None
    captions: CaptionArtifact | None = None
    render_plan: RenderPlan | None = None


DEFAULT_STEPS = [
    StepName.ingest,
    StepName.transcription,
    StepName.editorial,
    StepName.render,
]


def default_step_snapshots() -> list[StepSnapshot]:
    return [StepSnapshot(name=name) for name in DEFAULT_STEPS]


def as_relative(path: Path, base: Path) -> str:
    return str(path.relative_to(base))

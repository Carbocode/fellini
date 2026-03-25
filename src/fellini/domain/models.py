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
    width: int = Field(default=1080, ge=720)
    height: int = Field(default=1920, ge=1280)
    video_codec: str = "libx264"
    audio_codec: str = "aac"
    crf: int = Field(default=18, ge=0, le=35)
    preset: str = "slow"
    audio_bitrate: str = "192k"


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

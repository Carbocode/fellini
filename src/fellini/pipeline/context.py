from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from fellini.adapters.alignment import TranscriptAligner
from fellini.adapters.asr import FasterWhisperTranscriber
from fellini.adapters.ass import AssSubtitleBuilder
from fellini.adapters.decision import LocalLLMRefiner, RuleBasedDecisionEngine
from fellini.adapters.ffmpeg import FFmpegAdapter
from fellini.domain.models import (
    CaptionArtifact,
    EditDecisionList,
    JobRequest,
    LabeledSpan,
    PipelineState,
    ProbeInfo,
    RenderPlan,
    StepName,
    TranscriptArtifact,
)
from fellini.services.job_store import JobStore
from fellini.services.workspace import JobWorkspace
from fellini.settings import AppSettings


class PipelineContext:
    def __init__(
        self,
        *,
        settings: AppSettings,
        request: JobRequest,
        workspace: JobWorkspace,
        store: JobStore,
    ) -> None:
        self.settings = settings
        self.request = request
        self.workspace = workspace
        self.store = store
        self.state = PipelineState()
        self.ffmpeg = FFmpegAdapter(settings)
        self.transcriber = FasterWhisperTranscriber(settings.degraded_mode_when_ai_missing)
        self.aligner = TranscriptAligner(settings.degraded_mode_when_ai_missing)
        self.decision_engine = RuleBasedDecisionEngine()
        self.llm_refiner = LocalLLMRefiner()
        self.subtitle_builder = AssSubtitleBuilder()

    def load_state(self) -> None:
        snapshot_state = None
        if self.workspace.state_path.exists():
            payload = json.loads(self.workspace.state_path.read_text(encoding="utf-8"))
            snapshot_state = PipelineState.model_validate(payload)
        self.hydrate_state(snapshot_state)

    def hydrate_state(self, snapshot_state: PipelineState | None = None) -> None:
        # Disk artifacts are the source of truth for reruns so manual/API edits
        # are picked up even if the cached pipeline snapshot is stale.
        state = snapshot_state.model_copy(deep=True) if snapshot_state else PipelineState()
        probe_artifact = self.workspace.artifact_path("01_media_probe.json")
        if probe_artifact.exists():
            payload = json.loads(probe_artifact.read_text(encoding="utf-8"))
            state.probe_info = [
                ProbeInfo.model_validate(item) for item in payload.get("sources", [])
            ]
            state.duration_seconds = sum(item.duration_seconds for item in state.probe_info)

        mezzanine_path = self.workspace.temp_path("source_mezzanine.mp4")
        if mezzanine_path.exists():
            state.mezzanine_path = str(mezzanine_path)

        audio_path = self.workspace.temp_path("audio_16k_mono.wav")
        if audio_path.exists():
            state.audio_path = str(audio_path)

        artifact_map: list[tuple[str, str, type[BaseModel] | None]] = [
            ("03_transcript_raw.json", "raw_transcript", TranscriptArtifact),
            ("04_transcript_aligned.json", "aligned_transcript", TranscriptArtifact),
            ("06_edit_decision_list.json", "edl", EditDecisionList),
            ("07_caption_display.json", "captions", CaptionArtifact),
            ("09_render_plan.json", "render_plan", RenderPlan),
        ]
        for filename, field_name, model_type in artifact_map:
            artifact = self.workspace.artifact_path(filename)
            if not artifact.exists():
                continue
            payload = json.loads(artifact.read_text(encoding="utf-8"))
            value = model_type.model_validate(payload) if model_type else payload
            setattr(state, field_name, value)

        spans_artifact = self.workspace.artifact_path("05_spans_labeled.json")
        if spans_artifact.exists():
            payload = json.loads(spans_artifact.read_text(encoding="utf-8"))
            state.labeled_spans = [
                LabeledSpan.model_validate(item) for item in payload.get("spans", [])
            ]

        self.state = state

    def save_state(self) -> None:
        self.workspace.state_path.write_text(
            self.state.model_dump_json(indent=2),
            encoding="utf-8",
        )

    def prune_from_step(self, step_name: StepName) -> None:
        if step_name == StepName.ingest:
            self.state = PipelineState()
            return

        if step_name == StepName.transcription:
            self.state.raw_transcript = None
            self.state.aligned_transcript = None
            self.state.labeled_spans = []
            self.state.edl = None
            self.state.captions = None
            self.state.render_plan = None
            return

        if step_name == StepName.alignment:
            self.state.aligned_transcript = None
            self.state.labeled_spans = []
            self.state.edl = None
            self.state.captions = None
            self.state.render_plan = None
            return

        if step_name == StepName.editorial:
            self.state.labeled_spans = []
            self.state.edl = None
            self.state.captions = None
            self.state.render_plan = None
            return

        if step_name == StepName.render:
            self.state.render_plan = RenderPlan()
            return

    def save_json_artifact(
        self, filename: str, payload: BaseModel | dict[str, Any] | list[Any]
    ) -> str:
        target = self.workspace.artifact_path(filename)
        if isinstance(payload, BaseModel):
            serialized = payload.model_dump(mode="json")
        else:
            serialized = payload
        target.write_text(json.dumps(serialized, indent=2, ensure_ascii=False), encoding="utf-8")
        return self.workspace.relative(target)

    def save_text_artifact(self, filename: str, content: str) -> str:
        target = self.workspace.artifact_path(filename)
        target.write_text(content, encoding="utf-8")
        return self.workspace.relative(target)

    def output_relative(self, path: Path) -> str:
        return self.workspace.relative(path)

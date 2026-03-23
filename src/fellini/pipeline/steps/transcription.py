from __future__ import annotations

from pathlib import Path

from fellini.domain.models import StepName
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep


class TranscriptionStep(PipelineStep):
    name = StepName.transcription
    description = "Run VAD-aware transcription."

    def run(self, context: PipelineContext) -> list[str]:
        audio_path = Path(context.state.audio_path or "")
        speech_segments, transcript = context.transcriber.transcribe(
            audio_path,
            context.request.transcription,
            context.request.language,
        )
        context.state.raw_transcript = transcript

        vad_artifact = context.save_json_artifact(
            "02_vad_segments.json",
            {"segments": [segment.model_dump(mode="json") for segment in speech_segments]},
        )
        transcript_artifact = context.save_json_artifact("03_transcript_raw.json", transcript)
        return [vad_artifact, transcript_artifact]

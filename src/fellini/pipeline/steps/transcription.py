from __future__ import annotations

from pathlib import Path

from fellini.domain.models import StepName
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep


class TranscriptionStep(PipelineStep):
    name = StepName.transcription
    description = "Run transcription and word alignment."

    def run(self, context: PipelineContext) -> list[str]:
        audio_path = Path(context.state.audio_path or "")
        speech_segments, transcript = context.transcriber.transcribe(
            audio_path,
            context.request.transcription,
            context.request.language,
        )
        context.state.raw_transcript = transcript
        aligned = context.aligner.align(
            audio_path,
            transcript,
            context.request.transcription,
            context.request.language,
            context.request.toggles.use_whisperx,
        )
        context.state.aligned_transcript = aligned

        vad_artifact = context.save_json_artifact(
            "02_vad_segments.json",
            {"segments": [segment.model_dump(mode="json") for segment in speech_segments]},
        )
        transcript_artifact = context.save_json_artifact("03_transcript_raw.json", transcript)
        aligned_artifact = context.save_json_artifact("04_transcript_aligned.json", aligned)
        return [vad_artifact, transcript_artifact, aligned_artifact]

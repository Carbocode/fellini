from __future__ import annotations

from pathlib import Path

from fellini.domain.models import StepName
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep


class AlignmentStep(PipelineStep):
    name = StepName.alignment
    description = "Align transcript to word-level timestamps."

    def run(self, context: PipelineContext) -> list[str]:
        audio_path = Path(context.state.audio_path or "")
        aligned = context.aligner.align(
            audio_path,
            context.state.raw_transcript
            or context.transcriber._empty_transcript(context.request.language, "empty"),
            context.request.transcription,
            context.request.language,
            context.request.toggles.use_whisperx,
        )
        context.state.aligned_transcript = aligned
        artifact = context.save_json_artifact("04_transcript_aligned.json", aligned)
        return [artifact]

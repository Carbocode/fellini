from __future__ import annotations

from pathlib import Path

from fellini.domain.models import StepName
from fellini.log import get_logger
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep

logger = get_logger(__name__)


class TranscriptionStep(PipelineStep):
    name = StepName.transcription
    description = "Run transcription and word alignment."

    def run(self, context: PipelineContext) -> list[str]:
        audio_path = Path(context.state.audio_path or "")
        logger.info(
            "step.transcription.start audio=%s model=%s language=%s whisperx=%s",
            audio_path,
            context.request.transcription.model,
            context.request.language,
            context.request.toggles.use_whisperx,
        )
        context.report_progress(self.name, 10, "Avvio della trascrizione")
        speech_segments, transcript = context.transcriber.transcribe(
            audio_path,
            context.request.transcription,
            context.request.language,
        )
        context.state.raw_transcript = transcript
        context.report_progress(self.name, 55, "Allineamento parola per parola")
        aligned = context.aligner.align(
            audio_path,
            transcript,
            context.request.transcription,
            context.request.language,
            context.request.toggles.use_whisperx,
        )
        context.state.aligned_transcript = aligned

        context.report_progress(self.name, 85, "Salvataggio transcript e alignment")
        vad_artifact = context.save_json_artifact(
            "02_vad_segments.json",
            {"segments": [segment.model_dump(mode="json") for segment in speech_segments]},
        )
        transcript_artifact = context.save_json_artifact("03_transcript_raw.json", transcript)
        aligned_artifact = context.save_json_artifact("04_transcript_aligned.json", aligned)
        context.report_progress(self.name, 100, "Transcription completata")
        logger.info(
            "step.transcription.done speech_segments=%s transcript_segments=%s aligned_segments=%s source=%s",
            len(speech_segments),
            len(transcript.segments),
            len(aligned.segments),
            aligned.source,
        )
        return [vad_artifact, transcript_artifact, aligned_artifact]

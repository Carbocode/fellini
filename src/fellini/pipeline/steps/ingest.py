from __future__ import annotations

from fellini.domain.models import StepName
from fellini.log import get_logger
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep

logger = get_logger(__name__)


class IngestStep(PipelineStep):
    name = StepName.ingest
    description = "Probe inputs, build mezzanine and extract canonical audio."

    def run(self, context: PipelineContext) -> list[str]:
        sources = [
            context.workspace.upload_path(asset.stored_name)
            for asset in context.request.input_assets
        ]
        logger.info("step.ingest.start sources=%s", [str(source) for source in sources])
        context.report_progress(self.name, 10, "Analisi dei file sorgente")
        probes = [context.ffmpeg.probe_media(source) for source in sources]
        context.state.probe_info = probes
        context.state.duration_seconds = sum(item.duration_seconds for item in probes)

        mezzanine_path = context.workspace.temp_path("source_mezzanine.mp4")
        context.report_progress(self.name, 35, "Creazione del mezzanine")
        context.ffmpeg.create_mezzanine(sources, mezzanine_path, context.workspace.temp_dir)
        audio_path = context.workspace.temp_path("audio_16k_mono.wav")
        context.report_progress(self.name, 75, "Estrazione dell'audio canonico")
        context.ffmpeg.extract_audio(mezzanine_path, audio_path)

        context.state.mezzanine_path = str(mezzanine_path)
        context.state.audio_path = str(audio_path)

        context.report_progress(self.name, 90, "Salvataggio artefatti ingest")
        artifact = context.save_json_artifact(
            "01_media_probe.json",
            {"sources": [probe.model_dump(mode="json") for probe in probes]},
        )
        context.report_progress(self.name, 100, "Ingest completato")
        logger.info(
            "step.ingest.done sources=%s duration=%.3f mezzanine=%s audio=%s",
            len(sources),
            context.state.duration_seconds,
            mezzanine_path,
            audio_path,
        )
        return [
            artifact,
            context.output_relative(mezzanine_path),
            context.output_relative(audio_path),
        ]

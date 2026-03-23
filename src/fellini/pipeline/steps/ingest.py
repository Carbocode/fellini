from __future__ import annotations

from fellini.domain.models import StepName
from fellini.pipeline.context import PipelineContext
from fellini.pipeline.steps.base import PipelineStep


class IngestStep(PipelineStep):
    name = StepName.ingest
    description = "Probe inputs, build mezzanine and extract canonical audio."

    def run(self, context: PipelineContext) -> list[str]:
        sources = [
            context.workspace.upload_path(asset.stored_name)
            for asset in context.request.input_assets
        ]
        probes = [context.ffmpeg.probe_media(source) for source in sources]
        context.state.probe_info = probes
        context.state.duration_seconds = sum(item.duration_seconds for item in probes)

        mezzanine_path = context.workspace.temp_path("source_mezzanine.mp4")
        context.ffmpeg.create_mezzanine(sources, mezzanine_path, context.workspace.temp_dir)
        audio_path = context.workspace.temp_path("audio_16k_mono.wav")
        context.ffmpeg.extract_audio(mezzanine_path, audio_path)

        context.state.mezzanine_path = str(mezzanine_path)
        context.state.audio_path = str(audio_path)

        artifact = context.save_json_artifact(
            "01_media_probe.json",
            {"sources": [probe.model_dump(mode="json") for probe in probes]},
        )
        return [
            artifact,
            context.output_relative(mezzanine_path),
            context.output_relative(audio_path),
        ]

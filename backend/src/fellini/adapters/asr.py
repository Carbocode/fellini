from __future__ import annotations

import ctypes
import importlib.util
import sys
from pathlib import Path

from fellini.domain.models import (
    SpeechSegment,
    TranscriptArtifact,
    TranscriptionConfig,
    TranscriptSegment,
    WordTiming,
)
from fellini.log import get_logger

logger = get_logger(__name__)


class DependencyMissingError(RuntimeError):
    pass


class FasterWhisperTranscriber:
    def __init__(self, degraded_mode_when_missing: bool = True) -> None:
        self.degraded_mode_when_missing = degraded_mode_when_missing

    def transcribe(
        self, audio_path: Path, config: TranscriptionConfig, language: str
    ) -> tuple[list[SpeechSegment], TranscriptArtifact]:
        logger.info(
            "asr.transcribe.start audio=%s model=%s device=%s compute_type=%s language=%s",
            audio_path,
            config.model,
            config.device,
            config.compute_type,
            language,
        )
        if importlib.util.find_spec("faster_whisper") is None:
            if self.degraded_mode_when_missing:
                logger.warning("asr.transcribe.degraded_missing_dependency audio=%s", audio_path)
                return [], self._empty_transcript(language, source="degraded-fallback")
            msg = "Missing dependency `faster-whisper`. Install `pip install -e .[asr]`."
            raise DependencyMissingError(msg)

        from faster_whisper import WhisperModel

        device = self._resolve_device(config.device)
        model = WhisperModel(config.model, device=device, compute_type=config.compute_type)
        segments_iter, info = model.transcribe(
            str(audio_path),
            language=language,
            beam_size=config.beam_size,
            vad_filter=config.vad_filter,
            word_timestamps=config.word_timestamps,
            condition_on_previous_text=config.condition_on_prev_text,
        )

        speech_segments: list[SpeechSegment] = []
        transcript_segments: list[TranscriptSegment] = []
        for index, segment in enumerate(segments_iter):
            words = [
                WordTiming(
                    text=(word.word or "").strip(),
                    start=float(word.start or segment.start),
                    end=float(word.end or segment.end),
                    confidence=float(word.probability or 1.0),
                )
                for word in (segment.words or [])
                if (word.word or "").strip()
            ]
            transcript_segments.append(
                TranscriptSegment(
                    id=f"seg_{index:04d}",
                    start=float(segment.start),
                    end=float(segment.end),
                    text=segment.text.strip(),
                    words=words,
                )
            )
            speech_segments.append(
                SpeechSegment(start=float(segment.start), end=float(segment.end), confidence=1.0)
            )

        transcript = TranscriptArtifact(
            language=getattr(info, "language", language) or language,
            segments=transcript_segments,
            source="faster-whisper",
        )
        logger.info(
            "asr.transcribe.done audio=%s speech_segments=%s transcript_segments=%s language=%s",
            audio_path,
            len(speech_segments),
            len(transcript_segments),
            transcript.language,
        )
        return speech_segments, transcript

    @staticmethod
    def _empty_transcript(language: str, source: str) -> TranscriptArtifact:
        return TranscriptArtifact(
            language=language,
            segments=[],
            source=source,
            notes=[
                (
                    "ASR backend unavailable. Pipeline continued in degraded mode "
                    "without transcript-derived edits."
                )
            ],
        )

    @staticmethod
    def _resolve_device(device: str) -> str:
        requested = device.strip().lower()
        if requested == "auto":
            if importlib.util.find_spec("torch") is None:
                return "cpu"
            import torch

            if not torch.cuda.is_available():
                return "cpu"

            missing_runtime = FasterWhisperTranscriber._missing_cuda_runtime_libraries()
            if missing_runtime:
                logger.warning(
                    "asr.cuda_runtime_missing requested=auto fallback=cpu missing=%s",
                    ",".join(missing_runtime),
                )
                return "cpu"
            return "cuda"

        if requested == "cuda":
            missing_runtime = FasterWhisperTranscriber._missing_cuda_runtime_libraries()
            if missing_runtime:
                joined = ", ".join(missing_runtime)
                msg = (
                    "CUDA requested for faster-whisper but required runtime libraries are missing: "
                    f"{joined}. Use device=cpu or install the CUDA/cuDNN runtime."
                )
                raise RuntimeError(msg)

        return requested

    @staticmethod
    def _missing_cuda_runtime_libraries() -> list[str]:
        if not sys.platform.startswith("linux"):
            return []
        if importlib.util.find_spec("torch") is None:
            return []
        import torch

        if not torch.cuda.is_available():
            return []

        required = [
            "libcudnn_ops_infer.so.8",
            "libcudnn_cnn_infer.so.8",
        ]
        missing: list[str] = []
        for library_name in required:
            try:
                ctypes.CDLL(library_name)
            except OSError:
                missing.append(library_name)
        return missing

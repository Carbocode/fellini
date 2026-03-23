from __future__ import annotations

import importlib.util
from pathlib import Path

from fellini.domain.models import (
    TranscriptArtifact,
    TranscriptionConfig,
    TranscriptSegment,
    WordTiming,
)


class TranscriptAligner:
    def __init__(self, degraded_mode_when_missing: bool = True) -> None:
        self.degraded_mode_when_missing = degraded_mode_when_missing

    def align(
        self,
        audio_path: Path,
        transcript: TranscriptArtifact,
        config: TranscriptionConfig,
        language: str,
        use_whisperx: bool,
    ) -> TranscriptArtifact:
        if not transcript.segments:
            return transcript

        if use_whisperx and importlib.util.find_spec("whisperx") is not None:
            return self._whisperx_align(audio_path, transcript, config, language)

        if use_whisperx and not self.degraded_mode_when_missing:
            msg = "Missing dependency `whisperx`. Install `pip install -e .[asr]`."
            raise RuntimeError(msg)

        return self._heuristic_align(transcript)

    def _whisperx_align(
        self,
        audio_path: Path,
        transcript: TranscriptArtifact,
        config: TranscriptionConfig,
        language: str,
    ) -> TranscriptArtifact:
        import whisperx

        device = self._resolve_device(config.device)
        model, metadata = whisperx.load_align_model(language_code=language, device=device)
        payload = {
            "segments": [segment.model_dump(exclude={"words"}) for segment in transcript.segments]
        }
        aligned = whisperx.align(payload["segments"], model, metadata, str(audio_path), device)
        segments: list[TranscriptSegment] = []

        for index, segment in enumerate(aligned.get("segments", [])):
            words = [
                WordTiming(
                    text=(word.get("word") or "").strip(),
                    start=float(word.get("start", segment.get("start", 0.0))),
                    end=float(word.get("end", segment.get("end", 0.0))),
                    confidence=float(word.get("score", 1.0) or 1.0),
                )
                for word in segment.get("words", [])
                if (word.get("word") or "").strip()
            ]
            segments.append(
                TranscriptSegment(
                    id=f"seg_{index:04d}",
                    start=float(segment.get("start", 0.0)),
                    end=float(segment.get("end", 0.0)),
                    text=(segment.get("text") or "").strip(),
                    words=words,
                )
            )

        return TranscriptArtifact(
            language=transcript.language,
            segments=segments,
            source="whisperx",
            notes=transcript.notes,
        )

    @staticmethod
    def _heuristic_align(transcript: TranscriptArtifact) -> TranscriptArtifact:
        if any(segment.words for segment in transcript.segments):
            return transcript

        segments: list[TranscriptSegment] = []
        for segment in transcript.segments:
            tokens = [token for token in segment.text.split() if token]
            if not tokens:
                segments.append(segment)
                continue
            duration = max(0.01, segment.end - segment.start)
            slot = duration / len(tokens)
            words = [
                WordTiming(
                    text=token,
                    start=segment.start + slot * index,
                    end=segment.start + slot * (index + 1),
                    confidence=0.7,
                )
                for index, token in enumerate(tokens)
            ]
            segments.append(segment.model_copy(update={"words": words}))

        return TranscriptArtifact(
            language=transcript.language,
            segments=segments,
            source=f"{transcript.source}+heuristic",
            notes=transcript.notes,
        )

    @staticmethod
    def _resolve_device(device: str) -> str:
        if device != "auto":
            return device
        if importlib.util.find_spec("torch") is None:
            return "cpu"
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"

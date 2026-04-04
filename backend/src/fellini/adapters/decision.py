from __future__ import annotations

import re
from dataclasses import dataclass

from fellini.domain.models import (
    CaptionArtifact,
    CaptionChunk,
    DecisionConfig,
    EditDecisionList,
    KeepRange,
    LabeledSpan,
    RenderPlan,
    SoftCut,
    SpanLabel,
    SubtitleConfig,
    TranscriptArtifact,
    WordTiming,
)

TOKEN_CLEAN_RE = re.compile(r"[^\w\dàèéìòù]+", re.IGNORECASE)
NUMBER_RE = re.compile(r"^\d+([.,:/-]\d+)*$")


@dataclass(slots=True)
class EditorialBundle:
    spans: list[LabeledSpan]
    edl: EditDecisionList
    captions: CaptionArtifact
    render_plan: RenderPlan


class RuleBasedDecisionEngine:
    def label_transcript(
        self, transcript: TranscriptArtifact, config: DecisionConfig
    ) -> list[LabeledSpan]:
        words = transcript.words
        labeled: list[LabeledSpan] = []
        previous_kept: LabeledSpan | None = None
        filler_words = {self._normalize(word) for word in config.filler_words}

        for word in words:
            normalized = self._normalize(word.text)
            protected = self._is_protected(word.text)
            label = SpanLabel.keep
            reason = "content keep"
            risk = "low"

            if normalized in filler_words and not protected:
                label = SpanLabel.cut
                reason = "italian filler"
            elif previous_kept and normalized == self._normalize(previous_kept.text):
                gap = word.start - previous_kept.end
                if gap <= config.repetition_window_seconds and not protected:
                    label = SpanLabel.cut
                    reason = "immediate repetition"
            elif word.confidence < 0.45 and protected:
                label = SpanLabel.maybe
                reason = "protected low-confidence token"
                risk = "medium"

            span = LabeledSpan(
                text=word.text,
                display_text=word.text,
                start=word.start,
                end=word.end,
                label=label,
                reason=reason,
                risk=risk,
                confidence=word.confidence,
                protected=protected,
            )
            labeled.append(span)
            if span.label != SpanLabel.cut:
                previous_kept = span

        return labeled

    def build_edl(
        self,
        spans: list[LabeledSpan],
        duration_seconds: float,
        source_video: str,
        config: DecisionConfig,
    ) -> EditDecisionList:
        keep_words = [span for span in spans if span.label != SpanLabel.cut]
        if not keep_words:
            return EditDecisionList(
                source_video=source_video,
                keep_ranges=[
                    KeepRange(start=0.0, end=duration_seconds, reason="fallback full keep")
                ],
                soft_cuts=[],
            )

        keep_ranges: list[KeepRange] = []
        soft_cuts: list[SoftCut] = []
        current_start = max(0.0, keep_words[0].start - config.leading_context_seconds)
        previous = keep_words[0]

        for current in keep_words[1:]:
            gap = current.start - previous.end
            if gap <= config.soft_pause_threshold_seconds:
                previous = current
                continue

            preserved_pause = self._pause_budget(gap, config)
            trailing_context, leading_context = self._split_pause_budget(
                preserved_pause, config
            )
            keep_ranges.append(
                KeepRange(
                    start=current_start,
                    end=max(previous.end + trailing_context, current_start + 0.05),
                    reason="compressed pause"
                    if gap <= config.hard_pause_threshold_seconds
                    else "removed silence",
                )
            )
            soft_cuts.append(SoftCut(at=previous.end, audio_fade_ms=20, video_cut="hard"))
            current_start = max(0.0, current.start - leading_context)
            previous = current

        keep_ranges.append(
            KeepRange(
                start=current_start,
                end=min(
                    duration_seconds,
                    max(previous.end + config.trailing_context_seconds, current_start + 0.05),
                ),
                reason="content keep",
            )
        )
        return EditDecisionList(
            source_video=source_video,
            keep_ranges=self._merge_ranges(keep_ranges),
            soft_cuts=soft_cuts,
        )

    def build_captions(self, spans: list[LabeledSpan], subtitle: SubtitleConfig) -> CaptionArtifact:
        words = [self._as_word(span) for span in spans if span.label != SpanLabel.cut]
        if not words:
            return CaptionArtifact(
                chunks=[], notes=["No transcript words available for subtitle generation."]
            )

        chunks: list[CaptionChunk] = []
        current_words: list[WordTiming] = []
        current_display: list[str] = []

        def flush() -> None:
            nonlocal current_words, current_display
            if not current_words:
                return
            chunks.append(
                CaptionChunk(
                    start=current_words[0].start,
                    end=current_words[-1].end,
                    words=current_words,
                    display_words=current_display,
                )
            )
            current_words = []
            current_display = []

        for index, word in enumerate(words):
            current_words.append(word)
            current_display.append(word.text)
            next_word = words[index + 1] if index + 1 < len(words) else None
            chunk_duration = current_words[-1].end - current_words[0].start
            should_flush = len(current_words) >= subtitle.chunk_words
            should_flush = should_flush or word.text.endswith((".", "!", "?"))
            should_flush = should_flush or chunk_duration >= 1.8
            if next_word and next_word.start - word.end > 0.45:
                should_flush = True
            if should_flush:
                flush()

        flush()
        return CaptionArtifact(chunks=chunks)

    def build_editorial_bundle(
        self,
        transcript: TranscriptArtifact,
        duration_seconds: float,
        source_video: str,
        subtitle: SubtitleConfig,
        decision: DecisionConfig,
    ) -> EditorialBundle:
        spans = self.label_transcript(transcript, decision)
        edl = self.build_edl(spans, duration_seconds, source_video, decision)
        captions = self.build_captions(spans, subtitle)
        return EditorialBundle(spans=spans, edl=edl, captions=captions, render_plan=RenderPlan())

    @staticmethod
    def _normalize(token: str) -> str:
        return TOKEN_CLEAN_RE.sub("", token.casefold())

    @staticmethod
    def _is_protected(token: str) -> bool:
        clean = TOKEN_CLEAN_RE.sub("", token)
        return bool(NUMBER_RE.match(clean) or any(char.isdigit() for char in token))

    @staticmethod
    def _as_word(span: LabeledSpan) -> WordTiming:
        return WordTiming(
            text=span.display_text, start=span.start, end=span.end, confidence=span.confidence
        )

    @staticmethod
    def _pause_budget(gap: float, config: DecisionConfig) -> float:
        total_context = config.leading_context_seconds + config.trailing_context_seconds
        return min(gap, config.retained_pause_seconds, total_context)

    @staticmethod
    def _split_pause_budget(
        pause_budget: float, config: DecisionConfig
    ) -> tuple[float, float]:
        total_context = config.leading_context_seconds + config.trailing_context_seconds
        if pause_budget <= 0 or total_context <= 0:
            return 0.0, 0.0

        trailing_share = config.trailing_context_seconds / total_context
        trailing_context = pause_budget * trailing_share
        leading_context = pause_budget - trailing_context
        return trailing_context, leading_context

    @staticmethod
    def _merge_ranges(ranges: list[KeepRange]) -> list[KeepRange]:
        if not ranges:
            return []
        merged = [ranges[0]]
        for current in ranges[1:]:
            previous = merged[-1]
            if current.start <= previous.end + 0.01:
                merged[-1] = KeepRange(
                    start=previous.start,
                    end=max(previous.end, current.end),
                    reason=previous.reason,
                )
            else:
                merged.append(current)
        return merged


class LocalLLMRefiner:
    def refine(self, spans: list[LabeledSpan], enabled: bool, model_name: str) -> list[LabeledSpan]:
        _ = model_name
        if not enabled:
            return spans
        return spans

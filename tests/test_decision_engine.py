import pytest

from fellini.adapters.decision import RuleBasedDecisionEngine
from fellini.domain.models import (
    DecisionConfig,
    SpanLabel,
    SubtitleConfig,
    TranscriptArtifact,
    TranscriptSegment,
    WordTiming,
)


def test_rule_engine_cuts_fillers_and_repetitions():
    transcript = TranscriptArtifact(
        language="it",
        source="test",
        segments=[
            TranscriptSegment(
                id="seg_0001",
                start=0.0,
                end=2.0,
                text="eh oggi oggi parliamo di 2026",
                words=[
                    WordTiming(text="eh", start=0.0, end=0.2, confidence=0.9),
                    WordTiming(text="oggi", start=0.25, end=0.55, confidence=0.95),
                    WordTiming(text="oggi", start=0.58, end=0.88, confidence=0.95),
                    WordTiming(text="parliamo", start=0.92, end=1.3, confidence=0.96),
                    WordTiming(text="di", start=1.31, end=1.4, confidence=0.9),
                    WordTiming(text="2026", start=1.42, end=1.7, confidence=0.2),
                ],
            )
        ],
    )

    engine = RuleBasedDecisionEngine()
    spans = engine.label_transcript(transcript, DecisionConfig())

    assert spans[0].label == SpanLabel.cut
    assert spans[2].label == SpanLabel.cut
    assert spans[-1].label == SpanLabel.maybe

    captions = engine.build_captions(spans, SubtitleConfig(chunk_words=3))
    assert len(captions.chunks) >= 1

    edl = engine.build_edl(
        spans, duration_seconds=2.0, source_video="source.mp4", config=DecisionConfig()
    )
    assert edl.keep_ranges
    assert edl.keep_ranges[0].start >= 0


def test_build_edl_preserves_context_without_merging_valid_cuts():
    transcript = TranscriptArtifact(
        language="it",
        source="test",
        segments=[
            TranscriptSegment(
                id="seg_0001",
                start=0.0,
                end=2.0,
                text="ciao dopo",
                words=[
                    WordTiming(text="ciao", start=0.5, end=0.8, confidence=0.98),
                    WordTiming(text="dopo", start=1.15, end=1.45, confidence=0.98),
                ],
            )
        ],
    )

    engine = RuleBasedDecisionEngine()
    spans = engine.label_transcript(transcript, DecisionConfig())
    edl = engine.build_edl(
        spans,
        duration_seconds=2.0,
        source_video="source.mp4",
        config=DecisionConfig(
            soft_pause_threshold_seconds=0.25,
            hard_pause_threshold_seconds=0.7,
            leading_context_seconds=0.18,
            trailing_context_seconds=0.18,
            retained_pause_seconds=0.24,
        ),
    )

    assert len(edl.keep_ranges) == 2
    assert edl.keep_ranges[0].start == pytest.approx(0.32, abs=0.001)
    assert edl.keep_ranges[0].end == pytest.approx(0.92, abs=0.001)
    assert edl.keep_ranges[1].start == pytest.approx(1.03, abs=0.001)
    assert edl.keep_ranges[1].end == pytest.approx(1.63, abs=0.001)

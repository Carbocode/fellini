from fellini.adapters.ass import AssSubtitleBuilder
from fellini.domain.models import (
    CaptionArtifact,
    CaptionChunk,
    SubtitleConfig,
    WordTiming,
)


def test_ass_builder_generates_highlight_dialogues():
    builder = AssSubtitleBuilder()
    artifact = CaptionArtifact(
        chunks=[
            CaptionChunk(
                start=0.0,
                end=1.0,
                words=[
                    WordTiming(text="questa", start=0.0, end=0.4),
                    WordTiming(text="parte", start=0.4, end=0.8),
                ],
                display_words=["questa", "parte"],
            )
        ]
    )

    ass = builder.build(
        artifact,
        SubtitleConfig(
            text_color="112233",
            active_color="73E3FF",
            outline_color="445566",
            pop_in_ms=180,
        ),
        width=1080,
        height=1920,
    )

    assert "[Script Info]" in ass
    # Single Dialogue spanning the entire chunk
    assert "Dialogue: 0,0:00:00.00,0:00:00.80" in ass
    # Both words in the same line
    assert "questa" in ass
    assert "parte" in ass
    # ASS colors must be stored in BBGGRR order, not CSS RRGGBB.
    assert "Style: Base,Avenir Next,68,&H00332211,&H00FFE373,&H00665544" in ass
    # Timed color overrides for karaoke highlight
    assert "\\c&H00FFE373&" in ass
    assert "\\t(" in ass
    # The chunk pop-in now animates from a smaller scale instead of being a no-op.
    assert "\\fscx84\\fscy84\\t(0,180,\\fscx100\\fscy100)" in ass
    # Only one Dialogue line per chunk
    assert ass.count("Dialogue:") == 1

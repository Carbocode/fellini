from __future__ import annotations

from fellini.domain.models import CaptionArtifact, SubtitleConfig


class AssSubtitleBuilder:
    def build(
        self, captions: CaptionArtifact, config: SubtitleConfig, width: int, height: int
    ) -> str:
        header = self._header(config, width, height)
        body = [
            self._dialogues_for_chunk(chunk, config, width, height) for chunk in captions.chunks
        ]
        return header + "".join(body)

    def _header(self, config: SubtitleConfig, width: int, height: int) -> str:
        text_color = self._ass_color(config.text_color)
        active_color = self._ass_color(config.active_color)
        outline_color = self._ass_color(config.outline_color)
        return "".join(
            [
                "[Script Info]\n",
                "ScriptType: v4.00+\n",
                f"PlayResX: {width}\n",
                f"PlayResY: {height}\n",
                "ScaledBorderAndShadow: yes\n",
                "\n",
                "[V4+ Styles]\n",
                (
                    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
                    "OutlineColour, BackColour, "
                ),
                (
                    "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
                    "BorderStyle, Outline, "
                ),
                "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n",
                (
                    f"Style: Base,{config.font_name},{config.font_size},"
                    f"{text_color},{active_color},"
                ),
                (
                    f"{outline_color},&H64000000,1,0,0,0,100,100,0,0,1,4,2,2,"
                    f"96,96,{config.bottom_margin},1\n"
                ),
                "\n",
                "[Events]\n",
                (
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
                    "Effect, Text\n"
                ),
            ]
        )

    def _dialogues_for_chunk(self, chunk, config: SubtitleConfig, width: int, height: int) -> str:
        words = chunk.words
        display = list(chunk.display_words or [w.text for w in words])
        if not words:
            return ""

        text_color = self._ass_color(config.text_color)
        active_color = self._ass_color(config.active_color)
        pos_x = width // 2
        pos_y = height - config.bottom_margin
        chunk_start = words[0].start
        chunk_end = words[-1].end

        # Build a single Dialogue line for the entire chunk.
        # Each word uses timed color overrides so only the active word
        # highlights — the text block stays on screen without re-animating.
        parts: list[str] = []
        for i, word in enumerate(words):
            escaped = self._escape(display[i])
            # Time offsets relative to the Dialogue start (in ms)
            word_on = max(0, round((word.start - chunk_start) * 1000))
            word_off = max(word_on + 1, round((word.end - chunk_start) * 1000))

            if i == 0:
                # First word: start already highlighted, then revert at word_off.
                parts.append(
                    "{\\c" + active_color + "&\\fscx106\\fscy106"
                    + f"\\t({word_off},{word_off},"
                    + f"\\c{text_color}&\\fscx100\\fscy100)"
                    + "}"
                    + escaped
                )
            else:
                # Subsequent words: default color, highlight on, then revert.
                parts.append(
                    "{\\c" + text_color + "&"
                    + f"\\t({word_on},{word_on},"
                    + f"\\c{active_color}&\\fscx106\\fscy106)"
                    + f"\\t({word_off},{word_off},"
                    + f"\\c{text_color}&\\fscx100\\fscy100)"
                    + "}"
                    + escaped
                )

        text = " ".join(parts)

        line = (
            "Dialogue: 0,"
            + self._timestamp(chunk_start)
            + ","
            + self._timestamp(chunk_end)
            + ",Base,,0,0,0,,"
            + "{\\an2"
            + f"\\pos({pos_x},{pos_y})"
            + self._line_intro_transform(config.pop_in_ms)
            + "}"
            + text
            + "\n"
        )
        return line

    @staticmethod
    def _timestamp(seconds: float) -> str:
        total_centiseconds = round(seconds * 100)
        hours, remainder = divmod(total_centiseconds, 360000)
        minutes, remainder = divmod(remainder, 6000)
        secs, centiseconds = divmod(remainder, 100)
        return f"{hours}:{minutes:02d}:{secs:02d}.{centiseconds:02d}"

    @staticmethod
    def _escape(text: str) -> str:
        return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")")

    @staticmethod
    def _ass_color(rgb_hex: str) -> str:
        red = rgb_hex[0:2]
        green = rgb_hex[2:4]
        blue = rgb_hex[4:6]
        return f"&H00{blue}{green}{red}"

    @staticmethod
    def _line_intro_transform(pop_in_ms: int) -> str:
        if pop_in_ms <= 0:
            return "\\fscx100\\fscy100"
        return f"\\fscx84\\fscy84\\t(0,{pop_in_ms},\\fscx100\\fscy100)"

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
                    f"&H00{config.text_color},&H00{config.active_color},"
                ),
                (
                    f"&H00{config.outline_color},&H64000000,1,0,0,0,100,100,0,0,1,4,2,2,"
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
        lines: list[str] = []
        pos_x = width // 2
        pos_y = height - config.bottom_margin

        for active_index, active_word in enumerate(chunk.words):
            display_words = list(chunk.display_words or [word.text for word in chunk.words])
            display_words[active_index] = (
                "{\\c&H00"
                + config.active_color
                + "&\\fscx106\\fscy106}"
                + self._escape(display_words[active_index])
                + "{\\r}"
            )
            text = " ".join(
                self._escape(word) if "{\\c&H00" not in word else word for word in display_words
            )
            lines.append(
                "Dialogue: 0,"
                + self._timestamp(active_word.start)
                + ","
                + self._timestamp(active_word.end)
                + ",Base,,0,0,0,,"
                + "{\\an2"
                + f"\\pos({pos_x},{pos_y})"
                + "\\fscx92\\fscy92"
                + f"\\t(0,{config.pop_in_ms},\\fscx100\\fscy100)"
                + "}"
                + text
                + "\n"
            )

        return "".join(lines)

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

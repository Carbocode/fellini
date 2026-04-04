from __future__ import annotations

import logging

_DEFAULT_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
_DEFAULT_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def configure_logging(level: str = "INFO") -> None:
    resolved_level = getattr(logging, level.upper(), logging.INFO)
    root_logger = logging.getLogger()

    if not root_logger.handlers:
        logging.basicConfig(
            level=resolved_level,
            format=_DEFAULT_FORMAT,
            datefmt=_DEFAULT_DATE_FORMAT,
        )
    else:
        root_logger.setLevel(resolved_level)

    logging.getLogger("fellini").setLevel(resolved_level)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

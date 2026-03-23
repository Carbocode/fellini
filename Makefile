POETRY ?= poetry

.PHONY: install install-full dev test lint lock check

install:
	$(POETRY) install --with dev

install-full:
	$(POETRY) install --with dev,asr,llm

dev:
	$(POETRY) run uvicorn fellini.app:create_app --factory --reload

test:
	$(POETRY) run pytest

lint:
	$(POETRY) run ruff check .

lock:
	$(POETRY) lock

check:
	$(POETRY) check

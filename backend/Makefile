POETRY ?= poetry
PYTHONPATH ?= src
HOST ?= 127.0.0.1
PORT ?= 8123
ARGS ?=

.PHONY: install install-full dev test lint lock check mps-test matanyone-benchmark matanyone-run

install:
	$(POETRY) install --with dev

install-full:
	$(POETRY) install --with dev,asr,llm,vision

dev:
	PYTHONPATH=$(PYTHONPATH) $(POETRY) run python -m fellini serve --host $(HOST) --port $(PORT)

test:
	$(POETRY) run pytest

lint:
	$(POETRY) run ruff check .

lock:
	$(POETRY) lock

check:
	$(POETRY) check

mps-test:
	$(POETRY) run python scripts/test_pytorch_mps.py

matanyone-benchmark:
	$(POETRY) run python scripts/run_matanyone_benchmark.py $(ARGS)

matanyone-run:
	$(MAKE) matanyone-benchmark ARGS='$(ARGS)'

POETRY ?= poetry

.PHONY: install install-full dev dev-all test lint lock check fe-install fe-dev fe-build

install:
	$(POETRY) install --with dev

install-full:
	$(POETRY) install --with dev,asr,llm

dev:
	$(POETRY) run uvicorn fellini.app:create_app --factory --reload

dev-all:
	@trap 'kill 0' EXIT; \
	$(POETRY) run uvicorn fellini.app:create_app --factory --reload --port 8000 & \
	cd frontend && bun run dev & \
	wait

test:
	$(POETRY) run pytest

lint:
	$(POETRY) run ruff check .

lock:
	$(POETRY) lock

check:
	$(POETRY) check

fe-install:
	cd frontend && bun install

fe-dev:
	cd frontend && bun run dev

fe-build:
	cd frontend && bun run build

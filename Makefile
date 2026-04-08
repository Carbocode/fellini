BACKEND_DIR ?= backend
BUN ?= bun
ARGS ?=

.PHONY: setup setup-full install install-full dev dev-all test lint lock check mps-test matanyone-benchmark matanyone-run fe-install fe-dev fe-build

setup:
	$(MAKE) install
	$(MAKE) fe-install

setup-full:
	$(MAKE) install-full
	$(MAKE) fe-install

install:
	$(MAKE) -C $(BACKEND_DIR) install

install-full:
	$(MAKE) -C $(BACKEND_DIR) install-full

dev:
	$(MAKE) -C $(BACKEND_DIR) dev

dev-all:
	@trap 'kill 0' EXIT; \
	$(MAKE) -C $(BACKEND_DIR) dev PORT=8000 & \
	cd frontend && $(BUN) run dev & \
	wait

test:
	$(MAKE) -C $(BACKEND_DIR) test

lint:
	$(MAKE) -C $(BACKEND_DIR) lint

lock:
	$(MAKE) -C $(BACKEND_DIR) lock

check:
	$(MAKE) -C $(BACKEND_DIR) check

mps-test:
	$(MAKE) -C $(BACKEND_DIR) mps-test

matanyone-benchmark:
	$(MAKE) -C $(BACKEND_DIR) matanyone-benchmark ARGS='$(ARGS)'

matanyone-run:
	$(MAKE) -C $(BACKEND_DIR) matanyone-run ARGS='$(ARGS)'

fe-install:
	cd frontend && $(BUN) install

fe-dev:
	cd frontend && $(BUN) run dev

fe-build:
	cd frontend && $(BUN) run build

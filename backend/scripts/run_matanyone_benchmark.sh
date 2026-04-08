#!/usr/bin/env bash
set -euo pipefail

BACKEND_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BACKEND_ROOT"
poetry run python "$BACKEND_ROOT/scripts/run_matanyone_benchmark.py" "$@"

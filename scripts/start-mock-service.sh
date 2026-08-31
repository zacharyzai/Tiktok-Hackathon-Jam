#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir/mock-service"

log() {
  printf '[mock-service] %s\n' "$*" >&2
}

if [[ ! -d venv ]]; then
  log "Creating venv and installing dependencies (first run only)."
  python3 -m venv venv
  ./venv/bin/pip install -q -r requirements.txt
fi

export MOCK_SERVICE_INTERNAL_SECRET="${MOCK_SERVICE_INTERNAL_SECRET:-dev-only-internal-secret-change-me}"
log "Starting on http://localhost:8000 (Ctrl+C to stop)."
exec ./venv/bin/python3 main.py

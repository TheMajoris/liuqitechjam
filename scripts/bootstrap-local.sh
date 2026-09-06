#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

mkdir -p data workspaces codex-home

echo "Next:"
echo "  1. Fill ARK_API_KEY, SUPERVISOR_MODEL, BYTEPLUS_ACCESS_KEY, and BYTEPLUS_SECRET_KEY in .env"
echo "  2. Run: npm run poc (provisions local PostgreSQL and starts the full POC)"
echo "     For Compose against an existing database, set DATABASE_URL, run the documented migration/provision steps, then: docker compose up --build"

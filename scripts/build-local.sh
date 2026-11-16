#!/usr/bin/env bash
# Build PDF Tools' Vite web app locally. API and workers are Bun TypeScript and
# have no separate compile step; built mode runs them without watch/hot reload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="${BUN_BIN:-}"
if [ -z "$BUN" ]; then
  BUN="$(command -v bun 2>/dev/null || true)"
fi
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "bun is required" >&2; exit 1; }

echo "[build] PDF Tools dependencies"
"$BUN" install --frozen-lockfile

echo "[build] PDF Tools web -> apps/web/dist"
"$BUN" run build

test -f "$ROOT/apps/web/dist/index.html"
echo "[build] done. Start with: scripts/run-built-local.sh up"

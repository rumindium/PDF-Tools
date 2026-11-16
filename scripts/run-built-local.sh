#!/usr/bin/env bash
# Run PDF Tools' production web bundle and Bun API/workers without Docker/root.
# Build the web app first with scripts/build-local.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILT_DIR="${STACK_BUILT_DIR:-$ROOT/artifacts}"

if [ "$#" -eq 0 ]; then
  set -- up
fi

case "$1" in
  -h|--help|help)
    cat <<EOF
Usage: scripts/run-built-local.sh {up|down|status|logs|check|engines|env}

Runs the Vite build in apps/web/dist and Bun API/workers without hot reload.
PDF web: http://localhost:5180
PDF API: http://localhost:8080
EOF
    exit 0
    ;;
esac

exec env \
  STACK_BUILT=1 \
  STACK_BUILT_DIR="$BUILT_DIR" \
  bash "$ROOT/scripts/noroot-stack.sh" "$@"

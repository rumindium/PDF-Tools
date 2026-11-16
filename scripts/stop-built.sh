#!/usr/bin/env bash
# Stop the PDF no-root stack when it was started in built mode.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: scripts/stop-built.sh

Stops the no-root stack started by scripts/run-built-local.sh (built mode).
This is idempotent and does not use Docker or root.
EOF
    exit 0
    ;;
esac

exec bash "$ROOT/scripts/run-built-local.sh" down

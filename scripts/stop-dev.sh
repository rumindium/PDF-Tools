#!/usr/bin/env bash
# Stop the PDF no-root stack when it was started in dev mode.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: scripts/stop-dev.sh

Stops the no-root stack started by scripts/noroot-stack.sh (dev mode).
This is idempotent and does not use Docker or root.
EOF
    exit 0
    ;;
esac

exec bash "$ROOT/scripts/noroot-stack.sh" down

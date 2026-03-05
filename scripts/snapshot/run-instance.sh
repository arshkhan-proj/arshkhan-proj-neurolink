#!/usr/bin/env bash
# Run sandbox with --cwd = instance dir. Usage: run-instance.sh <instance-dir> [dev|lint|...]
# Default command: pnpm dev -- --host 0.0.0.0. Run from Neurolink repo root.

set -euo pipefail

NEUROLINK_ROOT="${NEUROLINK_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$NEUROLINK_ROOT"

# pnpm run snapshot:run -- <instance-dir> [cmd] passes -- as first arg; skip it
[[ "${1:-}" == "--" ]] && shift
INSTANCE="${1:?Usage: run-instance.sh <instance-dir> [dev|lint|...]}"
CMD="${2:-dev}"

INSTANCE_ABS="$(cd "$INSTANCE" 2>/dev/null && pwd)" || { echo "Instance not found: $INSTANCE"; exit 1; }

case "$CMD" in
  dev)
    RUN_CMD="pnpm dev -- --host 0.0.0.0"
    ;;
  lint)
    RUN_CMD="pnpm lint"
    ;;
  *)
    RUN_CMD="pnpm $CMD"
    ;;
esac

echo "[snapshot] Running sandbox: cwd=$INSTANCE_ABS cmd=$RUN_CMD"
exec pnpm run cli sandbox \
  --cmd "$RUN_CMD" \
  --cwd "$INSTANCE_ABS" \
  --timeout 3600000

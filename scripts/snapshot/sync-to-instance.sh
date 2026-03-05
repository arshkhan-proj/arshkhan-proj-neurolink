#!/usr/bin/env bash
# Rsync source code from SNAPSHOT_SOURCE into an instance dir (excludes node_modules, .git, etc).
# Usage: sync-to-instance.sh <instance-dir>
# Run from Neurolink repo root.

set -euo pipefail

NEUROLINK_ROOT="${NEUROLINK_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$NEUROLINK_ROOT"

SOURCE="${SNAPSHOT_SOURCE:-../lighthouse}"
# pnpm run snapshot:sync -- <instance-dir> may pass -- as first arg
[[ "${1:-}" == "--" ]] && shift
INSTANCE="${1:?Usage: sync-to-instance.sh <instance-dir>}"

SOURCE_ABS="$(cd "$SOURCE" 2>/dev/null && pwd)" || { echo "Source not found: $SOURCE"; exit 1; }
INSTANCE_ABS="$(cd "$INSTANCE" 2>/dev/null && pwd)" || { echo "Instance not found: $INSTANCE"; exit 1; }

echo "[snapshot] Syncing $SOURCE_ABS -> $INSTANCE_ABS (code only)"
rsync -av --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude .svelte-kit \
  --exclude build \
  --exclude dev.log \
  --exclude .turbo \
  --exclude coverage \
  "$SOURCE_ABS/" "$INSTANCE_ABS/"

echo "[snapshot] Done. Restart the sandbox to pick up changes."

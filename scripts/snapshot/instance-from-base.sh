#!/usr/bin/env bash
# Create a new instance dir by copying SNAPSHOT_BASE. Run from Neurolink repo root.

set -euo pipefail

NEUROLINK_ROOT="${NEUROLINK_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$NEUROLINK_ROOT"

BASE="${SNAPSHOT_BASE:-../lighthouse-base}"
PREFIX="${SNAPSHOT_INSTANCE_PREFIX:-../lighthouse-instance}"

BASE_ABS="$(cd "$BASE" 2>/dev/null && pwd)" || { echo "Base not found: $BASE"; exit 1; }
PARENT="$(cd "$(dirname "$PREFIX")" 2>/dev/null && pwd)"
PREFIX_NAME="$(basename "$PREFIX")"
ID="${INSTANCE_ID:-$(date +%s)}"
INSTANCE_ABS="$PARENT/${PREFIX_NAME}-$ID"

echo "[snapshot] Copying base $BASE_ABS -> $INSTANCE_ABS"
rm -rf "$INSTANCE_ABS"
cp -a "$BASE_ABS" "$INSTANCE_ABS"
echo "$INSTANCE_ABS"

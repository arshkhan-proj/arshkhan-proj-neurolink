#!/usr/bin/env bash
# Create frozen base from SNAPSHOT_SOURCE: copy, pnpm install, optional build.
# Run from Neurolink repo root. Overwrites SNAPSHOT_BASE.

set -euo pipefail

NEUROLINK_ROOT="${NEUROLINK_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$NEUROLINK_ROOT"

SOURCE="${SNAPSHOT_SOURCE:-../lighthouse}"
BASE="${SNAPSHOT_BASE:-../lighthouse-base}"

SOURCE_ABS="$(cd "$SOURCE" 2>/dev/null && pwd)" || { echo "Source not found: $SOURCE"; exit 1; }
BASE_ABS="$(cd "$(dirname "$BASE")" 2>/dev/null && pwd)/$(basename "$BASE")"

echo "[snapshot] Creating base from $SOURCE_ABS -> $BASE_ABS"
rm -rf "$BASE_ABS"
mkdir -p "$(dirname "$BASE_ABS")"
cp -a "$SOURCE_ABS" "$BASE_ABS"

cd "$BASE_ABS"
echo "[snapshot] Installing dependencies (pnpm install)..."
pnpm install

if grep -q '"build":' package.json 2>/dev/null; then
  echo "[snapshot] Running build..."
  pnpm run build || true
fi

echo "[snapshot] Base ready at $BASE_ABS"

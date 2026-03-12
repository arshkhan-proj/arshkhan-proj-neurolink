#!/usr/bin/env bash
set -euo pipefail

# WORK_DIR is passed from the Node server; default to /app if missing
WORK_DIR="${WORK_DIR:-/app}"

cd "$WORK_DIR"

# Run Neurolink CLI sandbox checks against this snapshot dir
node /app/dist/cli/index.js sandbox \
  --cmd "pnpm lint && pnpm test" \
  --cwd "$WORK_DIR" \
  --timeout 3600000 \
  --env NODE_ENV=test
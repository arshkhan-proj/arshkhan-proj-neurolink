#!/usr/bin/env bash
set -euo pipefail

cd /app

node dist/cli/index.js sandbox \
  --cmd "pnpm lint && pnpm test" \
  --cwd /app \
  --timeout 3600000 \
  --env NODE_ENV=test

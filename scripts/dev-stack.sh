#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"
export CLOUDFLARE_ACCOUNT_ID="$(node -p "JSON.parse(require('fs').readFileSync('workers/gateway/wrangler.jsonc', 'utf8')).account_id")"
npm --prefix apps/web run build
npm run db:migrate:local

exec npx wrangler dev \
  --config workers/gateway/wrangler.jsonc \
  --config workers/auth/wrangler.jsonc \
  --config workers/git/wrangler.jsonc \
  --config workers/forge/wrangler.jsonc \
  --config workers/deploy/wrangler.jsonc \
  --config workers/limits/wrangler.jsonc \
  --persist-to .wrangler/state \
  --ip 127.0.0.1 \
  --local-upstream "localhost:${GITEDGE_GATEWAY_PORT:-8877}" \
  --port "${GITEDGE_GATEWAY_PORT:-8877}"

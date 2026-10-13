#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"
# Remote Artifacts bindings need an account: the environment wins, then the operator file, then the Wrangler login.
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(node scripts/operator-config.mjs account-id)"
fi
if [ -n "$CLOUDFLARE_ACCOUNT_ID" ]; then
  export CLOUDFLARE_ACCOUNT_ID
else
  unset CLOUDFLARE_ACCOUNT_ID
fi
pnpm --dir apps/web run build
pnpm run db:migrate:local

exec pnpm exec wrangler dev \
  --config workers/gateway/wrangler.jsonc \
  --config workers/auth/wrangler.jsonc \
  --config workers/git/wrangler.jsonc \
  --config workers/forge/wrangler.jsonc \
  --config workers/deploy/wrangler.jsonc \
  --config workers/limits/wrangler.jsonc \
  --config workers/actions/wrangler.jsonc \
  --config workers/mcp/wrangler.jsonc \
  --persist-to .wrangler/state \
  --ip 127.0.0.1 \
  --local-upstream "localhost:${GITEDGE_GATEWAY_PORT:-8877}" \
  --port "${GITEDGE_GATEWAY_PORT:-8877}"

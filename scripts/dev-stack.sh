#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"
export CLOUDFLARE_ACCOUNT_ID="$(node --input-type=module -e "import { accountId } from './scripts/deploy-stack.mjs'; console.log(accountId())")"
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
  --persist-to .wrangler/state \
  --ip 127.0.0.1 \
  --local-upstream "localhost:${GITEDGE_GATEWAY_PORT:-8877}" \
  --port "${GITEDGE_GATEWAY_PORT:-8877}"

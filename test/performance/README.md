# Isolated D1 benchmark

This Worker binds only `gitedge-d1-performance-benchmark-temp`; it does not
import application code or use the product D1 binding. Its Wrangler config has a
placeholder database UUID. Replace it only with the ID of a newly created,
disposable benchmark database. Never point this config at a production database.

The fixture migration creates indexed `bench_sessions` and
`bench_collaborators` tables plus eight bounded `bench_audit` rows. The
authenticated `/seed` endpoint resets only those tables and inserts 16
sessions, 16 collaborators and eight audit rows. Benchmark requests perform up
to eight indexed reads or updates per request; writes only increment those
eight audit rows.

The runner resets the fixture before each of six sequential rounds: read, write
and mixed requests, each in sequential and D1 batch modes. Each measured round
makes at most 80 HTTP requests with concurrency capped at eight. The single
fixture-reset request runs sequentially outside that round's concurrency limit.
`D1_BENCH_OPERATIONS` caps
read/write statements per request at eight. For the mixed path it caps read/write
pairs, so at most 16 SQL statements run in one request. HTTP latency is measured
by the runner; Worker elapsed time and D1 binding wall time are measured inside
the Worker; SQL duration and read/write row counts come from each official
`D1Result.meta` record. D1 binding wall time includes queueing and other binding
overhead. D1 does not expose queue wait as a separate duration, so the report
labels it as unmeasured. The fields follow Cloudflare's [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
and [D1 return object](https://developers.cloudflare.com/d1/worker-api/return-object/).

For a local isolated run, generate a random token and put it in
`test/performance/.dev.vars`:

```sh
cd /path/to/gitedge
TOKEN=$(openssl rand -hex 32)
printf 'BENCH_TOKEN=%s\n' "$TOKEN" > test/performance/.dev.vars
pnpm exec wrangler d1 migrations apply gitedge-d1-performance-benchmark-temp --local \
  --persist-to test/performance/.wrangler --config test/performance/wrangler.jsonc
pnpm exec wrangler dev --local --port 8799 --persist-to test/performance/.wrangler \
  --config test/performance/wrangler.jsonc
```

In another terminal, read the same token from `.dev.vars`, then run:

```sh
export D1_BENCH_TOKEN="$(sed -n 's/^BENCH_TOKEN=//p' test/performance/.dev.vars)"
D1_BENCH_URL=http://127.0.0.1:8799 \
pnpm exec node test/performance/d1-benchmark.mjs
```

Remote use is opt-in. The runner refuses remote hosts unless passed
`--remote-test-origin` with the exact HTTPS origin of the dedicated
`gitedge-d1-performance-benchmark.<account>.workers.dev` Worker, and still
requires the random `D1_BENCH_TOKEN` environment variable. Before deploying,
create a new disposable D1 database, update the placeholder UUID in this
config to that database only, apply this directory's migration remotely, set
the Worker's `BENCH_TOKEN` secret, and deploy this config. Delete that temporary
database and Worker after the measurements. This repository does not create,
deploy, or delete remote resources.

Keep `d1-benchmark-env.d.ts` synchronized after config changes with
`pnpm exec wrangler types --config test/performance/wrangler.jsonc --include-runtime=false test/performance/d1-benchmark-env.d.ts`.
Check the Worker types with `pnpm exec tsc -p test/performance/tsconfig.json`.

```sh
export D1_BENCH_TOKEN="$(sed -n 's/^BENCH_TOKEN=//p' test/performance/.dev.vars)"
pnpm exec node test/performance/d1-benchmark.mjs \
  --remote-test-origin https://gitedge-d1-performance-benchmark.<account>.workers.dev
```

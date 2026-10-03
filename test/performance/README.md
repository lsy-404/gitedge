# D1 endpoint benchmark

Run the harness against a local Worker endpoint:

```sh
D1_BENCH_URL=http://127.0.0.1:8787/repositories/r1/issues \
D1_BENCH_METHOD=GET \
D1_BENCH_REQUESTS=1000 \
D1_BENCH_CONCURRENCY=16 \
pnpm exec node test/performance/d1-benchmark.mjs
```

For a local write endpoint, set `D1_BENCH_METHOD` and provide a representative
`D1_BENCH_BODY`. Use a disposable local database and restore it between runs.
The harness refuses non-local hosts.

`httpEndToEndLatency` includes the request, Worker work, and response body read.
`d1SqlExecution` is reported only when the Worker returns
`Server-Timing: d1-sql;dur=<milliseconds>`; the D1 binding does not otherwise
expose isolated SQL execution time. D1 queue wait is not exposed separately, so
the harness reports it as unmeasured instead of deriving it from HTTP latency.

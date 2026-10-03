const args = process.argv.slice(2);
let remoteTestOrigin;
for (let index = 0; index < args.length; index += 1) {
  if (
    args[index] !== "--remote-test-origin" ||
    remoteTestOrigin !== undefined ||
    !args[index + 1]
  ) {
    throw new Error(
      "Usage: d1-benchmark.mjs [--remote-test-origin https://gitedge-d1-performance-benchmark.<account>.workers.dev]"
    );
  }
  remoteTestOrigin = args[index + 1];
  index += 1;
}

const baseValue = remoteTestOrigin ?? process.env.D1_BENCH_URL;
if (!baseValue) {
  throw new Error("Set D1_BENCH_URL for local runs or pass --remote-test-origin explicitly.");
}
const baseUrl = new URL(baseValue);
if (remoteTestOrigin !== undefined) {
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.port !== "" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash ||
    !/^gitedge-d1-performance-benchmark\.[a-z0-9-]+\.workers\.dev$/i.test(baseUrl.hostname)
  ) {
    throw new Error("Remote runs require the exact dedicated benchmark workers.dev origin.");
  }
} else if (
  !["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname) ||
  !["http:", "https:"].includes(baseUrl.protocol)
) {
  throw new Error("Without --remote-test-origin, benchmark requests are restricted to localhost.");
}

const token = process.env.D1_BENCH_TOKEN;
if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
  throw new Error(
    "Set D1_BENCH_TOKEN to a 32-byte random token encoded as 64 hexadecimal characters."
  );
}

const requests = Number(process.env.D1_BENCH_REQUESTS ?? 80);
const concurrency = Number(process.env.D1_BENCH_CONCURRENCY ?? 8);
const operationsPerRequest = Number(process.env.D1_BENCH_OPERATIONS ?? 4);
if (!Number.isSafeInteger(requests) || requests < 1 || requests > 80) {
  throw new Error("D1_BENCH_REQUESTS must be between 1 and 80 per round.");
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  throw new Error("D1_BENCH_CONCURRENCY must be between 1 and 8.");
}
if (
  !Number.isSafeInteger(operationsPerRequest) ||
  operationsPerRequest < 1 ||
  operationsPerRequest > 8
) {
  throw new Error("D1_BENCH_OPERATIONS must be between 1 and 8.");
}

const headers = { Authorization: `Bearer ${token}` };
const timeoutMs = 30_000;

async function postSeed() {
  const response = await fetch(new URL("/seed", baseUrl), {
    method: "POST",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(`Seed failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.ceil(fraction * sorted.length) - 1];
  return {
    samples: sorted.length,
    minMs: Number(sorted[0].toFixed(3)),
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)),
  };
}

async function runRound(path, mode) {
  const fixtureSeed = await postSeed();
  const samples = [];
  const failures = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(requests, concurrency) }, async () => {
      while (next < requests) {
        const requestIndex = next++;
        const offset = (requestIndex * operationsPerRequest) % 16;
        const url = new URL(`/${path}`, baseUrl);
        url.searchParams.set("mode", mode);
        url.searchParams.set("count", String(operationsPerRequest));
        url.searchParams.set("offset", String(offset));
        const started = performance.now();
        try {
          const response = await fetch(url, {
            method: path === "read" ? "GET" : "POST",
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
          });
          const responseText = await response.text();
          const httpElapsedMs = performance.now() - started;
          const payload = JSON.parse(responseText);
          if (!response.ok) {
            failures.push({ request: requestIndex + 1, status: response.status, payload });
            continue;
          }
          samples.push({ httpElapsedMs, ...payload });
        } catch (error) {
          failures.push({ request: requestIndex + 1, error: String(error) });
        }
      }
    })
  );

  const sum = (key) => samples.reduce((total, sample) => total + Number(sample[key] ?? 0), 0);
  const result = {
    path,
    mode,
    fixtureSeed,
    requests,
    concurrency: Math.min(requests, concurrency),
    operationsPerRequest,
    httpLatency: summarize(samples.map((sample) => sample.httpElapsedMs)),
    workerElapsed: summarize(samples.map((sample) => sample.workerElapsedMs)),
    d1BindingElapsed: summarize(samples.map((sample) => sample.d1BindingElapsedMs)),
    sqlExecution: {
      sources: [...new Set(samples.flatMap((sample) => sample.sqlDurationSources ?? []))],
      perRequest: summarize(samples.map((sample) => sample.sqlDurationMs)),
      totalMs: Number(sum("sqlDurationMs").toFixed(3)),
    },
    queryCount: sum("queryCount"),
    d1BindingCallCount: sum("d1BindingCallCount"),
    rowsReturned: sum("rowsReturned"),
    rowsRead: sum("rowsRead"),
    rowsWritten: sum("rowsWritten"),
    d1QueueWaitMeasured: false,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

for (const path of ["read", "write", "mixed"]) {
  for (const mode of ["sequential", "batch"]) {
    await runRound(path, mode);
  }
}

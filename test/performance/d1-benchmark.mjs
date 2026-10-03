const urlValue = process.env.D1_BENCH_URL;
if (!urlValue) {
  throw new Error("Set D1_BENCH_URL to a local Worker URL.");
}

const url = new URL(urlValue);
if (
  !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
  !["http:", "https:"].includes(url.protocol)
) {
  throw new Error("D1 benchmark requests are restricted to localhost.");
}

const requests = Number(process.env.D1_BENCH_REQUESTS ?? 100);
const concurrency = Number(process.env.D1_BENCH_CONCURRENCY ?? 8);
const method = (process.env.D1_BENCH_METHOD ?? "GET").toUpperCase();
const body = process.env.D1_BENCH_BODY;
if (!Number.isSafeInteger(requests) || requests < 1 || requests > 100_000) {
  throw new Error("D1_BENCH_REQUESTS must be between 1 and 100000.");
}
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 128) {
  throw new Error("D1_BENCH_CONCURRENCY must be between 1 and 128.");
}
if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method)) {
  throw new Error("Unsupported D1_BENCH_METHOD.");
}

const durations = [];
const sqlDurations = [];
const failures = [];
let next = 0;
const workerCount = Math.min(concurrency, requests);

await Promise.all(
  Array.from({ length: workerCount }, async () => {
    while (next < requests) {
      const index = next++;
      const started = performance.now();
      try {
        const response = await fetch(url, {
          method,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: ["GET", "HEAD"].includes(method) || body === undefined ? undefined : body,
        });
        await response.arrayBuffer();
        durations.push(performance.now() - started);
        if (!response.ok) failures.push({ request: index + 1, status: response.status });
        const serverTiming = response.headers.get("Server-Timing") ?? "";
        for (const item of serverTiming.split(",")) {
          const match = item.trim().match(/^d1-sql\s*;\s*dur=(\d+(?:\.\d+)?)/i);
          if (match) sqlDurations.push(Number(match[1]));
        }
      } catch (error) {
        failures.push({ request: index + 1, error: String(error) });
      }
    }
  })
);

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

console.log(
  JSON.stringify(
    {
      target: url.origin,
      method,
      requested: requests,
      concurrency: workerCount,
      httpEndToEndLatency: summarize(durations),
      d1SqlExecution: sqlDurations.length
        ? { source: "Server-Timing: d1-sql;dur=...", ...summarize(sqlDurations) }
        : { measured: false, reason: "Worker did not expose d1-sql Server-Timing." },
      d1QueueTime: {
        measured: false,
        reason: "D1 does not expose queue wait separately from SQL operation latency.",
      },
      failures,
    },
    null,
    2
  )
);

if (failures.length > 0) process.exitCode = 1;

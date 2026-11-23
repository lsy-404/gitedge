import { z } from "zod";

const BACKEND = "https://colab.research.google.com/tun/m/";
const XSSI_PREFIX = ")]}'\n";
const REQUEST_TIMEOUT_MS = 30_000;
// Allocation can take longer than an ordinary request.
const ASSIGN_TIMEOUT_MS = 90_000;
const ASSIGN_RETRIES = 3;
const ASSIGN_BACKOFF_MS = 10_000;

const proxySchema = z.object({ url: z.string().url(), token: z.string().min(1) });
const assignmentSchema = z.object({ endpoint: z.string().min(1), runtimeProxyInfo: proxySchema });
const assignTokenSchema = z.object({ token: z.string().min(1) });
const ccuSchema = z.object({
  currentBalance: z.number(),
  consumptionRateHourly: z.number(),
});
const assignmentsSchema = z.object({
  assignments: z.array(z.object({ endpoint: z.string() })).default([]),
});

export interface ColabAssignment {
  endpoint: string;
  proxyUrl: string;
  proxyToken: string;
}

export class ColabBackendError extends Error {
  constructor(
    readonly status: number | null,
    message: string
  ) {
    super(message);
  }
}

export class TooManyAssignmentsError extends Error {}

// The session backend's notebook hash: the UUID with "_" for "-", padded with "." to 44 characters.
export function notebookHash(uuid: string): string {
  return uuid.replaceAll("-", "_").padEnd(44, ".");
}

async function backend(
  accessToken: string,
  path: string,
  init: {
    method?: "GET" | "POST";
    query?: Record<string, string>;
    xsrf?: string;
    timeoutMs?: number;
  } = {}
): Promise<unknown> {
  const url = new URL(path, BACKEND);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  url.searchParams.set("authuser", "0");
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "X-Colab-Client-Agent": "colab-cli",
  });
  if (init.xsrf) headers.set("X-Goog-Colab-Token", init.xsrf);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ColabBackendError(null, cause instanceof Error ? cause.message : "request failed");
  }
  const text = await response.text();
  if (!response.ok)
    throw new ColabBackendError(
      response.status,
      `Colab ${init.method ?? "GET"} ${url.pathname} returned HTTP ${response.status}.`
    );
  const body = text.startsWith(XSSI_PREFIX) ? text.slice(XSSI_PREFIX.length) : text;
  return body ? JSON.parse(body) : null;
}

function presentAssignment(value: z.infer<typeof assignmentSchema>): ColabAssignment {
  return {
    endpoint: value.endpoint,
    proxyUrl: value.runtimeProxyInfo.url,
    proxyToken: value.runtimeProxyInfo.token,
  };
}

type AssignState = { assignment: ColabAssignment } | { token: string };

async function readAssignment(accessToken: string, nbh: string): Promise<AssignState> {
  const body = await backend(accessToken, "assign", {
    query: { nbh, variant: "DEFAULT", accelerator: "NONE" },
  });
  const existing = assignmentSchema.safeParse(body);
  if (existing.success) return { assignment: presentAssignment(existing.data) };
  return { token: assignTokenSchema.parse(body).token };
}

/** Returns the runtime assigned to this notebook hash, allocating a CPU runtime when there is none. */
export async function assignRuntime(accessToken: string, uuid: string): Promise<ColabAssignment> {
  const nbh = notebookHash(uuid);
  let state = await readAssignment(accessToken, nbh);
  for (let attempt = 0; ; attempt++) {
    if ("assignment" in state) return state.assignment;
    try {
      const body = await backend(accessToken, "assign", {
        method: "POST",
        query: { nbh, variant: "DEFAULT", accelerator: "NONE" },
        xsrf: state.token,
        timeoutMs: ASSIGN_TIMEOUT_MS,
      });
      return presentAssignment(assignmentSchema.parse(body));
    } catch (error) {
      if (error instanceof ColabBackendError && error.status === 412)
        throw new TooManyAssignmentsError(error.message);
      const retryable =
        error instanceof ColabBackendError &&
        (error.status === null || [502, 503, 504].includes(error.status));
      if (!retryable || attempt >= ASSIGN_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, ASSIGN_BACKOFF_MS * 2 ** attempt));
      // An uncertain POST may have allocated; read again before posting again.
      state = await readAssignment(accessToken, nbh);
    }
  }
}

/** Returns the runtime assigned to this notebook hash without allocating one. */
export async function findAssignment(
  accessToken: string,
  uuid: string
): Promise<ColabAssignment | null> {
  const state = await readAssignment(accessToken, notebookHash(uuid));
  return "assignment" in state ? state.assignment : null;
}

export async function unassignRuntime(accessToken: string, endpoint: string): Promise<void> {
  const path = `unassign/${encodeURIComponent(endpoint)}`;
  const { token } = assignTokenSchema.parse(await backend(accessToken, path));
  await backend(accessToken, path, { method: "POST", xsrf: token });
}

export async function listAssignmentEndpoints(accessToken: string): Promise<string[]> {
  const body = assignmentsSchema.parse(await backend(accessToken, "assignments"));
  return body.assignments.map((assignment) => assignment.endpoint);
}

export async function readComputeUnits(
  accessToken: string
): Promise<{ balance: number; rateHourly: number }> {
  const body = ccuSchema.parse(await backend(accessToken, "ccu-info"));
  return { balance: body.currentBalance, rateHourly: body.consumptionRateHourly };
}

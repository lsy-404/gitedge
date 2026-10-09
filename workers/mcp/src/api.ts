import { z } from "zod";
import { readTextLimited } from "../../../src/worker/common/readText";
import type { Logger } from "../../../src/worker/common/logger";

export interface GatewayBinding {
  fetch(request: Request): Promise<Response>;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH";

export type ApiOutcome<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly retryAfter?: number;
    };

/** Upper bound for one upstream response body; Git file listings and files stay well below it. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const ErrorBodySchema = z.object({
  error: z.union([z.object({ code: z.string(), message: z.string() }), z.string()]),
  retryAfter: z.number().optional(),
});

export interface ApiRequest {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
}

/** Builds `/api/...` from raw segments so caller input can never change the path structure. */
export function apiPath(...segments: readonly (string | number)[]): string {
  return `/api/${segments.map((segment) => encodeURIComponent(String(segment))).join("/")}`;
}

/**
 * Calls the public REST API through the Gateway with the caller's own credential, so the Gateway
 * and the services stay authoritative for authentication, scopes, repository access and limits.
 */
export class GitEdgeApi {
  constructor(
    private readonly gateway: GatewayBinding,
    private readonly origin: string,
    private readonly authorization: string,
    private readonly clientIp: string | null,
    private readonly logger: Logger
  ) {}

  async call<T>(
    method: ApiMethod,
    path: string,
    schema: z.ZodType<T>,
    request: ApiRequest = {}
  ): Promise<ApiOutcome<T>> {
    const url = new URL(path, this.origin);
    for (const [name, value] of Object.entries(request.query ?? {}))
      if (value !== undefined) url.searchParams.set(name, String(value));
    const headers = new Headers({
      Authorization: this.authorization,
      Accept: "application/json",
      "User-Agent": "gitedge-mcp",
    });
    if (this.clientIp) headers.set("CF-Connecting-IP", this.clientIp);
    if (request.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.gateway.fetch(
      new Request(url, {
        method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      })
    );
    const text = await readTextLimited(response.body, MAX_RESPONSE_BYTES);
    if (text === null) {
      this.logger.warn("mcp:upstream-too-large", { method, path, status: response.status });
      return {
        ok: false,
        status: 502,
        code: "response_too_large",
        message: "The API response exceeds the MCP size limit; narrow the request.",
      };
    }
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const parsed = ErrorBodySchema.safeParse(payload);
      const error = parsed.success ? parsed.data.error : null;
      this.logger.info("mcp:upstream-refused", { method, path, status: response.status });
      return {
        ok: false,
        status: response.status,
        code: typeof error === "object" && error ? error.code : `http_${response.status}`,
        message:
          typeof error === "object" && error
            ? error.message
            : typeof error === "string"
              ? error
              : `Request failed with HTTP ${response.status}.`,
        ...(parsed.success && parsed.data.retryAfter !== undefined
          ? { retryAfter: parsed.data.retryAfter }
          : {}),
      };
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.logger.error("mcp:upstream-invalid", {
        method,
        path,
        status: response.status,
        issues: parsed.error.issues.length,
      });
      return {
        ok: false,
        status: 502,
        code: "invalid_response",
        message: "The API returned an unexpected response.",
      };
    }
    return { ok: true, status: response.status, data: parsed.data };
  }
}

import { bytesToHex } from "./encoding";

export const WEBHOOK_REQUEST_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 4 * 1024;
export const WEBHOOK_MAX_ATTEMPTS = 5;

const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".test",
  ".home",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".private",
] as const;

/** Static SSRF screen: HTTPS on 443, a public-looking DNS name, no credentials, IP literals or internal suffixes. */
export function isPublicWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/g, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443")
    )
      return false;
    if (
      !host.includes(".") ||
      host === "localhost" ||
      PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    )
      return false;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) return false;
    if (host === "0.0.0.0" || host === "metadata.google.internal") return false;
    return true;
  } catch {
    return false;
  }
}

/** HMAC-SHA256 of the exact request body in the GitHub-compatible `sha256=<hex>` form. */
export async function signWebhookBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${bytesToHex(new Uint8Array(bytes))}`;
}

/** Delay before the next attempt after `attempts` failed attempts: 1, 2, 4, 8 minutes, capped at 15. */
export function webhookRetryDelay(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

async function drainBounded(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        completed = true;
        return;
      }
      bytes += part.value.byteLength;
      if (bytes > WEBHOOK_MAX_RESPONSE_BYTES) throw new Error("response_too_large");
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // A failed stream may reject cancellation; release its lock regardless.
      }
    }
    reader.releaseLock();
  }
}

export interface WebhookSendResult {
  readonly responseStatus: number | null;
  readonly errorCode: string | null;
  readonly delivered: boolean;
}

/** POSTs a signed body without following redirects and reads at most a bounded response. */
export async function sendWebhook(request: {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}): Promise<WebhookSendResult> {
  try {
    const result = await fetch(request.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
      headers: request.headers,
      body: request.body,
    });
    await drainBounded(result);
    if (result.status >= 200 && result.status < 300)
      return { responseStatus: result.status, errorCode: null, delivered: true };
    return {
      responseStatus: result.status,
      errorCode: result.status >= 300 && result.status < 400 ? "redirect_rejected" : "http_error",
      delivered: false,
    };
  } catch (error) {
    const errorCode =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
        ? "timeout"
        : error instanceof Error && error.message === "response_too_large"
          ? "response_too_large"
          : "network_error";
    return { responseStatus: null, errorCode, delivered: false };
  }
}

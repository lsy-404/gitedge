import type { QuotaDetail } from "../../../packages/contracts/src/ops";

export function jsonResponse(body: object, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  return Response.json(body, { status, headers: result });
}

export function dataResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return jsonResponse({ data }, status, headers);
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit
): Response {
  return jsonResponse({ error: { code, message } }, status, headers);
}

export function quotaExceededResponse(message: string, quota: QuotaDetail): Response {
  return jsonResponse({ error: { code: "quota_exceeded", message, quota } }, 403);
}

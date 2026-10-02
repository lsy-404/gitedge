import { readTextLimited } from "../../../src/worker/common/readText";

export function dataResponse(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}
export function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
export async function readJsonLimited(request: Request): Promise<unknown> {
  try {
    const text = await readTextLimited(request.body, 65_536);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

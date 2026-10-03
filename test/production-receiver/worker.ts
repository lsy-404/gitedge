import { readTextLimited } from "../../src/worker/common/readText";

export default {
  async fetch(request: Request, env: { WEBHOOK_SECRET: string }): Promise<Response> {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const signature = request.headers.get("X-GitEdge-Signature-256") ?? "";
    if (!/^sha256=[0-9a-f]{64}$/.test(signature) || !env.WEBHOOK_SECRET)
      return new Response("Invalid signature", { status: 401 });
    const body = await readTextLimited(request.body, 65_536);
    if (body === null) return new Response("Too large", { status: 413 });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const bytes = Uint8Array.from(signature.slice(7).match(/../g) ?? [], (hex) =>
      parseInt(hex, 16)
    );
    const valid = await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
    return new Response(valid ? "Verified" : "Invalid", { status: valid ? 202 : 401 });
  },
};

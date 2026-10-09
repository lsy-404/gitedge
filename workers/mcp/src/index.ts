import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCP_PATH } from "../../../packages/contracts/src/openapi";
import { createLogger } from "../../../src/worker/common/logger";
import { readTextLimited } from "../../../src/worker/common/readText";
import { GitEdgeApi, type GatewayBinding } from "./api";
import { createGitEdgeMcpServer } from "./tools";

export interface McpEnv {
  /** The public Gateway; every tool call goes through it with the caller's own credential. */
  GATEWAY: GatewayBinding;
  LOG_LEVEL?: string;
}

const MAX_REQUEST_BYTES = 1_048_576;
/** Batched messages run concurrently, so a batch is capped well below the SDK's own limit. */
const MAX_BATCH_MESSAGES = 10;

function jsonError(status: number, code: string, message: string, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  return Response.json({ error: { code, message } }, { status, headers: result });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/** Stateless Streamable HTTP endpoint: each POST builds a fresh server bound to its caller. */
export async function handleMcpRequest(request: Request, env: McpEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== MCP_PATH) return jsonError(404, "not_found", "Endpoint was not found.");
  const authorization = request.headers.get("Authorization") ?? "";
  if (!/^Bearer \S+$/.test(authorization))
    return jsonError(401, "unauthorized", "A Bearer access token is required.", {
      "WWW-Authenticate": 'Bearer realm="GitEdge"',
    });
  if (request.method !== "POST")
    return jsonError(405, "method_not_allowed", "Use POST for MCP requests.", { Allow: "POST" });
  const logger = createLogger(env.LOG_LEVEL, { service: "mcp" });
  const text = await readTextLimited(request.body, MAX_REQUEST_BYTES);
  if (text === null) {
    logger.warn("mcp:request-rejected", { reason: "body" });
    return jsonRpcError(413, -32000, "Request body exceeds 1 MiB or is not UTF-8.");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
  }
  if (Array.isArray(parsedBody) && parsedBody.length > MAX_BATCH_MESSAGES) {
    logger.warn("mcp:request-rejected", { reason: "batch", messages: parsedBody.length });
    return jsonRpcError(400, -32600, `A batch holds at most ${MAX_BATCH_MESSAGES} messages.`);
  }
  const api = new GitEdgeApi(
    env.GATEWAY,
    url.origin,
    authorization,
    request.headers.get("CF-Connecting-IP"),
    logger
  );
  const server = createGitEdgeMcpServer(api, logger);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request, { parsedBody });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  fetch: handleMcpRequest,
};

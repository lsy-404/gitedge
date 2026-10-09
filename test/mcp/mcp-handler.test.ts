import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  readTrustedUser,
  type AccessTokenIdentity,
  type Issue,
} from "../../packages/contracts/src/index";
import {
  handleGatewayRequest,
  type GatewayEnv,
  type GatewayService,
} from "../../workers/gateway/src/index";
import { handleMcpRequest } from "../../workers/mcp/src/index";

const ORIGIN = "https://gitedge.example.com";
const READ_TOKEN = `gep_${"r".repeat(64)}`;
const WRITE_TOKEN = `gep_${"w".repeat(64)}`;
const LIMITED_TOKEN = `gep_${"l".repeat(64)}`;
const tokens: Record<string, AccessTokenIdentity> = {
  [READ_TOKEN]: { id: "t-read", scopes: ["repo:read"] },
  [WRITE_TOKEN]: { id: "t-write", scopes: ["issues:write"] },
  [LIMITED_TOKEN]: { id: "t-limited", scopes: ["repo:read"], repositoryIds: ["r1", "r-gone"] },
};

const issue: Issue = {
  id: "i1",
  number: 1,
  title: "Broken build",
  body: "Steps",
  state: "open",
  author: "alice",
  actor: { kind: "user", id: "u1", name: "alice" },
  labels: ["bug"],
  assignees: [],
  reviewers: [],
  createdAt: 1,
  updatedAt: 2,
};

const repository = {
  id: "r1",
  namespaceId: "n1",
  owner: "alice",
  name: "site",
  slug: "site",
  description: "",
  visibility: "private",
  defaultBranch: "main",
  archived: false,
  issuesEnabled: true,
  pullsEnabled: true,
  discussionsEnabled: true,
  wikiEnabled: true,
  tasksEnabled: true,
  agentsEnabled: true,
  deploymentsEnabled: false,
  graphEnabled: true,
  actionsEnabled: false,
  actionsNetworkEnabled: false,
  onlineEditingEnabled: true,
  allowMergeCommit: true,
  allowSquashMerge: true,
  allowRebaseMerge: true,
  deleteBranchOnMerge: false,
  requiredApprovals: 0,
  requirePassingChecks: false,
  createdAt: 1,
  updatedAt: 1,
  viewerRole: "admin",
  canWrite: true,
};

function service(handler: (request: Request) => Response | Promise<Response>): GatewayService {
  return { fetch: async (request) => handler(request) };
}

interface Stack {
  env: GatewayEnv;
  authCalls: Request[];
  forgeCalls: Request[];
}

/** Real Gateway and MCP handlers; Auth and Forge are fakes that apply token scopes like the services. */
function stack(): Stack {
  const authCalls: Request[] = [];
  const forgeCalls: Request[] = [];
  const env: GatewayEnv = {
    AUTH: service((request) => {
      authCalls.push(request);
      const bearer = request.headers.get("Authorization")?.slice(7) ?? "";
      const token = tokens[bearer];
      if (token)
        return Response.json({ data: { id: "u1", identifier: "alice", groupKey: "free", token } });
      if (request.headers.has("Authorization"))
        return Response.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 });
      return Response.json({ data: null });
    }),
    FORGE: service((request) => {
      forgeCalls.push(request);
      const user = readTrustedUser(request);
      const path = new URL(request.url).pathname;
      if (!user)
        return Response.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 });
      if (path === "/repositories" && user.token?.repositoryIds)
        return Response.json(
          { error: { code: "forbidden", message: "Access token is limited to its repositories." } },
          { status: 403 }
        );
      if (path === "/repositories/r1") return Response.json({ data: repository });
      if (path === "/repositories/by-name/alice/site") return Response.json({ data: repository });
      if (path === "/repositories/r1/issues" && request.method === "GET")
        return Response.json({ data: [issue], truncated: false });
      if (path === "/repositories/r1/issues" && request.method === "POST") {
        if (!user.token?.scopes.includes("issues:write"))
          return Response.json(
            {
              error: {
                code: "insufficient_scope",
                message: "Access token requires the issues:write scope.",
              },
            },
            { status: 403 }
          );
        return Response.json({ data: { ...issue, number: 2, title: "New" } }, { status: 201 });
      }
      return Response.json({ error: { code: "not_found", message: "Missing." } }, { status: 404 });
    }),
    GIT: service((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/repositories/r1/file")
        return Response.json({
          data: {
            path: "notes.txt",
            oid: "b".repeat(40),
            size: 14,
            binary: false,
            content: "one\ntwo\nthree\nfour\nfive",
          },
        });
      if (path === "/repositories/r1/files")
        return Response.json({
          data: {
            oid: "c".repeat(40),
            paths: ["README.md", "src/index.ts", "src/lib/router.ts", "test/router.test.ts"],
            truncated: true,
          },
        });
      return Response.json({ error: { code: "not_found", message: "Missing." } }, { status: 404 });
    }),
    ASSETS: service(() => new Response("asset")),
    RATE_LIMITER: {
      getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
    },
  };
  env.MCP = service((request) =>
    handleMcpRequest(request, {
      GATEWAY: service((inner) => handleGatewayRequest(inner, env)),
      LOG_LEVEL: "error",
    })
  );
  return { env, authCalls, forgeCalls };
}

let nextId = 1;
function rpc(
  env: GatewayEnv,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = { Authorization: `Bearer ${READ_TOKEN}` }
): Promise<Response> {
  return handleGatewayRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "CF-Connecting-IP": "203.0.113.9",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
    env
  );
}

const ToolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  }),
});

async function callTool(
  env: GatewayEnv,
  name: string,
  args: Record<string, unknown>,
  token = READ_TOKEN
): Promise<{ isError: boolean; value: unknown }> {
  const response = await rpc(
    env,
    "tools/call",
    { name, arguments: args },
    {
      Authorization: `Bearer ${token}`,
    }
  );
  expect(response.status).toBe(200);
  const parsed = ToolResultSchema.parse(await response.json());
  return {
    isError: parsed.result.isError ?? false,
    value: JSON.parse(parsed.result.content[0].text),
  };
}

describe("MCP server through the Gateway", () => {
  it("initializes and lists every tool", async () => {
    const { env } = stack();
    const initialized = await rpc(env, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.status).toBe(200);
    const init = z
      .object({ result: z.object({ serverInfo: z.object({ name: z.string() }) }) })
      .parse(await initialized.json());
    expect(init.result.serverInfo.name).toBe("gitedge");

    const listed = await rpc(env, "tools/list", {});
    const tools = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({
              name: z.string(),
              inputSchema: z.object({ type: z.literal("object") }),
              annotations: z.object({ readOnlyHint: z.boolean() }),
            })
          ),
        }),
      })
      .parse(await listed.json()).result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "claim_task",
        "comment_issue",
        "comment_pull_request",
        "create_issue",
        "create_pull_request",
        "get_issue",
        "get_notifications",
        "get_pull_request",
        "get_repository",
        "list_issues",
        "list_pull_requests",
        "list_repositories",
        "list_tasks",
        "list_tree",
        "read_file",
        "search_files",
        "submit_review",
        "update_task",
      ].sort()
    );
    expect(tools.find((tool) => tool.name === "create_issue")?.annotations.readOnlyHint).toBe(
      false
    );
    expect(tools.find((tool) => tool.name === "read_file")?.annotations.readOnlyHint).toBe(true);
  });

  it("calls the REST API through the Gateway with the caller's identity", async () => {
    const { env, forgeCalls } = stack();
    const result = await callTool(env, "list_issues", { repository: "alice/site" });
    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({
      items: [{ number: 1, title: "Broken build", labels: ["bug"] }],
      total: 1,
      nextOffset: null,
      upstreamTruncated: false,
    });
    expect(forgeCalls.map((request) => new URL(request.url).pathname)).toEqual([
      "/repositories/by-name/alice/site",
      "/repositories/r1/issues",
    ]);
    for (const request of forgeCalls) {
      expect(request.headers.has("Authorization")).toBe(false);
      expect(readTrustedUser(request)?.token?.id).toBe("t-read");
    }
  });

  it("keeps token scopes authoritative for write tools", async () => {
    const { env } = stack();
    const refused = await callTool(env, "create_issue", { repository: "alice/site", title: "New" });
    expect(refused).toEqual({
      isError: true,
      value: {
        status: 403,
        code: "insufficient_scope",
        message: "Access token requires the issues:write scope.",
      },
    });
    const created = await callTool(
      env,
      "create_issue",
      { repository: "alice/site", title: "New" },
      WRITE_TOKEN
    );
    expect(created).toMatchObject({ isError: false, value: { number: 2, title: "New" } });
  });

  it("rejects invalid tool input before calling the API", async () => {
    const { env, forgeCalls } = stack();
    const response = await rpc(env, "tools/call", {
      name: "get_issue",
      arguments: { repository: "../../auth/x", number: 1 },
    });
    const body = JSON.stringify(await response.json());
    expect(body).toContain("owner/name");
    expect(forgeCalls).toHaveLength(0);
  });

  it("rejects unauthenticated, cookie-only and invalid credentials at the Gateway", async () => {
    const { env, authCalls } = stack();
    let reached = 0;
    env.MCP = service(() => {
      reached += 1;
      return new Response("mcp");
    });
    const missing = await rpc(env, "tools/list", {}, {});
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toContain("Bearer");
    const cookie = await rpc(env, "tools/list", {}, { Cookie: "gitedge_session=browser" });
    expect(cookie.status).toBe(401);
    const invalid = await rpc(env, "tools/list", {}, { Authorization: "Bearer gep_wrong" });
    expect(invalid.status).toBe(401);
    expect(reached).toBe(0);
    expect(authCalls.every((request) => !request.headers.has("Cookie"))).toBe(true);
  });

  it("forwards only the bearer credential and strips forged identity headers", async () => {
    const { env } = stack();
    let forwarded: Request | undefined;
    env.MCP = service((request) => {
      forwarded = request;
      return new Response("mcp");
    });
    const response = await rpc(
      env,
      "tools/list",
      {},
      {
        Authorization: `Bearer ${READ_TOKEN}`,
        Cookie: "gitedge_session=browser",
        "X-GitEdge-User-Id": "forged",
      }
    );
    expect(response.status).toBe(200);
    expect(forwarded?.headers.get("Authorization")).toBe(`Bearer ${READ_TOKEN}`);
    expect(forwarded?.headers.has("Cookie")).toBe(false);
    expect(forwarded?.headers.has("X-GitEdge-User-Id")).toBe(false);
  });

  it("answers 503 when the MCP service is not bound and 405 for non-POST requests", async () => {
    const { env } = stack();
    const unbound = { ...env, MCP: undefined };
    expect((await rpc(unbound, "tools/list", {})).status).toBe(503);
    const get = await handleGatewayRequest(
      new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${READ_TOKEN}` } }),
      env
    );
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
  });

  it("pages file content by line and searches paths like the file finder", async () => {
    const { env } = stack();
    const first = await callTool(env, "read_file", {
      repository: "alice/site",
      path: "notes.txt",
      maxLines: 2,
    });
    expect(first.value).toMatchObject({
      content: "one\ntwo",
      startLine: 1,
      endLine: 2,
      totalLines: 5,
      nextStartLine: 3,
    });
    const last = await callTool(env, "read_file", {
      repository: "alice/site",
      path: "notes.txt",
      startLine: 5,
    });
    expect(last.value).toMatchObject({ content: "five", nextStartLine: null });
    const past = await callTool(env, "read_file", {
      repository: "alice/site",
      path: "notes.txt",
      startLine: 9,
    });
    expect(past).toMatchObject({ isError: true, value: { status: 400 } });
    const found = await callTool(env, "search_files", {
      repository: "alice/site",
      query: "router",
    });
    expect(found.value).toMatchObject({
      paths: ["src/lib/router.ts", "test/router.test.ts"],
      searched: 4,
      upstreamTruncated: true,
    });
  });

  it("lists only the allowed repositories of a token limited to repositories", async () => {
    const { env } = stack();
    const listed = await callTool(env, "list_repositories", {}, LIMITED_TOKEN);
    expect(listed.value).toMatchObject({
      total: 2,
      items: [{ id: "r1", fullName: "alice/site" }],
    });
  });

  it("caps JSON-RPC batches and request size before running tools", async () => {
    const { env, forgeCalls } = stack();
    const batch = Array.from({ length: 11 }, (_, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: "tools/call",
      params: { name: "list_issues", arguments: { repository: "alice/site" } },
    }));
    const headers = {
      Authorization: `Bearer ${READ_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const tooMany = await handleGatewayRequest(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(batch) }),
      env
    );
    expect(tooMany.status).toBe(400);
    const tooLarge = await handleGatewayRequest(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: "x".repeat(1_048_577) }),
      env
    );
    expect(tooLarge.status).toBe(413);
    expect(forgeCalls).toHaveLength(0);
  });
});

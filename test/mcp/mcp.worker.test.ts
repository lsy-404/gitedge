import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import auth from "../../workers/auth/src/index";
import forge from "../../workers/forge/src/index";
import { handleGatewayRequest, type GatewayEnv } from "../../workers/gateway/src/index";
import { handleMcpRequest } from "../../workers/mcp/src/index";
import { API_OPERATIONS } from "../../packages/contracts/src/openapi";
import {
  authCall,
  authEnv,
  createPerson,
  createRepository,
  forgeCall,
  forgeEnv,
  migrate,
  origin,
  type Person,
} from "../support/stack";
import { unlimitedRateLimiter } from "../support/rate-limiter";

/** Real Gateway, Auth, Forge and MCP; Git answers with empty data because no tool here reads files. */
const gatewayEnv: GatewayEnv = {
  AUTH: { fetch: (request) => auth.fetch(request, authEnv) },
  FORGE: { fetch: (request) => forge.fetch(request, forgeEnv) },
  GIT: { fetch: async () => Response.json({ data: [] }) },
  ASSETS: { fetch: async () => new Response("asset") },
  RATE_LIMITER: unlimitedRateLimiter,
  MCP: {
    fetch: (request) =>
      handleMcpRequest(request, {
        GATEWAY: { fetch: (inner) => handleGatewayRequest(inner, gatewayEnv) },
        LOG_LEVEL: "error",
      }),
  },
};

const CreatedTokenSchema = z.object({ data: z.object({ token: z.string() }) });
const ToolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  }),
});

async function createToken(person: Person, scopes: string[]): Promise<string> {
  const response = await authCall(person, "/access-tokens", "POST", {
    name: scopes.join(" "),
    scopes,
    expiresInDays: 7,
  });
  expect(response.status).toBe(201);
  return CreatedTokenSchema.parse(await response.json()).data.token;
}

let nextId = 1;
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; value: unknown }> {
  const response = await handleGatewayRequest(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    gatewayEnv
  );
  expect(response.status).toBe(200);
  const parsed = ToolResultSchema.parse(await response.json());
  return {
    isError: parsed.result.isError ?? false,
    value: JSON.parse(parsed.result.content[0].text),
  };
}

/** Fails on any key the documented JSON Schema does not declare, at any depth. */
function undeclaredKeys(schema: unknown, value: unknown, at = "$"): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = z
    .object({
      properties: z.record(z.string(), z.unknown()).optional(),
      items: z.unknown().optional(),
      anyOf: z.array(z.unknown()).optional(),
      additionalProperties: z.unknown().optional(),
    })
    .parse(schema);
  if (node.anyOf) {
    const options = node.anyOf.map((option) => undeclaredKeys(option, value, at));
    return options.some((issues) => issues.length === 0) ? [] : (options[0] ?? []);
  }
  if (Array.isArray(value))
    return value.flatMap((item, index) => undeclaredKeys(node.items, item, `${at}[${index}]`));
  if (typeof value !== "object" || value === null || !node.properties) return [];
  const properties = node.properties;
  return Object.entries(value).flatMap(([key, child]) =>
    key in properties
      ? undeclaredKeys(properties[key], child, `${at}.${key}`)
      : node.additionalProperties === false
        ? [`${at}.${key}`]
        : []
  );
}

let alice: Person;
let bob: Person;
let repositoryId = "";
let readToken = "";
let writeToken = "";
let bobToken = "";
let adminToken = "";

beforeAll(async () => {
  await migrate();
  alice = await createPerson("alice-mcp");
  bob = await createPerson("bob-mcp");
  repositoryId = await createRepository(alice, "site", "private");
  readToken = await createToken(alice, ["repo:read"]);
  writeToken = await createToken(alice, ["issues:write"]);
  bobToken = await createToken(bob, ["admin"]);
  adminToken = await createToken(alice, ["admin"]);
  const task = await forgeCall(alice, `/repositories/${repositoryId}/tasks`, "POST", {
    type: "Feature",
    title: "Ship the MCP server",
  });
  expect(task.status).toBe(201);
});

describe("MCP tools against the real services", () => {
  it("refuses write tools for a read-only token and allows them with the scope", async () => {
    const refused = await callTool(readToken, "create_issue", {
      repository: "alice-mcp/site",
      title: "From a read token",
    });
    expect(refused.isError).toBe(true);
    expect(refused.value).toMatchObject({ status: 403, code: "insufficient_scope" });

    const created = await callTool(writeToken, "create_issue", {
      repository: "alice-mcp/site",
      title: "From MCP",
      body: "Created through the MCP server.",
    });
    expect(created).toMatchObject({ isError: false, value: { number: 1, title: "From MCP" } });
    const commented = await callTool(writeToken, "comment_issue", {
      repository: "alice-mcp/site",
      number: 1,
      body: "First comment",
    });
    expect(commented.isError).toBe(false);

    const listed = await callTool(readToken, "list_issues", { repository: "alice-mcp/site" });
    expect(listed.value).toMatchObject({ total: 1, items: [{ number: 1, author: "alice-mcp" }] });
    const issue = await callTool(readToken, "get_issue", {
      repository: "alice-mcp/site",
      number: 1,
    });
    expect(issue.value).toMatchObject({
      title: "From MCP",
      comments: { total: 1, items: [{ body: "First comment", author: "alice-mcp" }] },
    });
  });

  it("hides private repositories from other accounts", async () => {
    for (const [tool, args] of [
      ["get_repository", { repository: "alice-mcp/site" }],
      ["list_issues", { repository: "alice-mcp/site" }],
      ["create_issue", { repository: "alice-mcp/site", title: "Intrusion" }],
    ] as const) {
      const result = await callTool(bobToken, tool, args);
      expect(result, tool).toMatchObject({ isError: true, value: { status: 404 } });
    }
    const repositories = await callTool(bobToken, "list_repositories", {});
    expect(repositories.value).toMatchObject({ total: 0, items: [] });
  });

  it("claims and updates a task as the token's own user", async () => {
    const readOnly = await callTool(readToken, "claim_task", {
      repository: "alice-mcp/site",
      number: 1,
    });
    expect(readOnly.value).toMatchObject({ status: 403, code: "insufficient_scope" });

    const claimed = await callTool(writeToken, "claim_task", {
      repository: "alice-mcp/site",
      number: 1,
    });
    expect(claimed).toMatchObject({
      isError: false,
      value: {
        number: 1,
        status: "in_progress",
        assignee: { kind: "user", id: alice.id, name: "alice-mcp" },
      },
    });
    const updated = await callTool(writeToken, "update_task", {
      repository: "alice-mcp/site",
      number: 1,
      status: "done",
    });
    expect(updated.value).toMatchObject({ status: "done" });
    const tasks = await callTool(readToken, "list_tasks", {
      repository: "alice-mcp/site",
      status: "done",
    });
    expect(tasks.value).toMatchObject({ total: 1, items: [{ number: 1 }] });
  });

  it("returns exactly the documented response shapes", async () => {
    const samples: Record<string, string> = {
      repositoryId,
      owner: "alice-mcp",
      repo: "site",
      number: "1",
    };
    const checked: string[] = [];
    for (const operation of API_OPERATIONS) {
      if (operation.method !== "GET" || operation.service === "git") continue;
      // Health probes absent bindings and no pull request exists in this fixture.
      if (operation.path === "/api/health" || operation.path.includes("/pull-requests/{number}"))
        continue;
      const path = operation.path.replaceAll(/\{([A-Za-z]+)\}/g, (_, name: string) =>
        encodeURIComponent(samples[name] ?? "")
      );
      const response = await handleGatewayRequest(
        new Request(`${origin}${path}`, { headers: { Authorization: `Bearer ${readToken}` } }),
        gatewayEnv
      );
      expect(response.status, operation.operationId).toBe(operation.status);
      const body: unknown = await response.json();
      const parsed = operation.response.safeParse(body);
      expect(parsed.success, `${operation.operationId}: ${parsed.error?.message}`).toBe(true);
      expect(
        undeclaredKeys(z.toJSONSchema(operation.response, { io: "output" }), body),
        operation.operationId
      ).toEqual([]);
      checked.push(operation.operationId);
    }
    expect(checked).toContain("listIssues");
    expect(checked).toContain("getTask");
  });

  it("reaches a Forge handler for every documented write", async () => {
    const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
    for (const operation of API_OPERATIONS) {
      if (operation.method === "GET") continue;
      const path = operation.path
        .replace("{repositoryId}", repositoryId)
        .replace("{number}", operation.path.includes("/pull-requests/") ? "99" : "1");
      const response = await handleGatewayRequest(
        new Request(`${origin}${path}`, {
          method: operation.method,
          headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
          body: "{}",
        }),
        gatewayEnv
      );
      // An empty body is invalid everywhere and pull request 99 does not exist; an unrouted path
      // would instead fall through to 405 or the generic endpoint miss.
      expect(response.status, operation.operationId).not.toBe(405);
      const error = ErrorSchema.safeParse(await response.json());
      expect(error.success && error.data.error.message, operation.operationId).not.toBe(
        "Endpoint was not found."
      );
      expect([400, 404], operation.operationId).toContain(response.status);
    }
  });
});

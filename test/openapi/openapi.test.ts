import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredAccessTokenScope } from "../../packages/contracts/src/access-tokens";
import {
  API_OPERATIONS,
  OPENAPI_METHOD_KEYS,
  OPENAPI_PATH,
  buildOpenApiDocument,
  type ApiOperation,
} from "../../packages/contracts/src/openapi";
import {
  handleGatewayRequest,
  type GatewayEnv,
  type GatewayService,
} from "../../workers/gateway/src/index";

const ORIGIN = "https://gitedge.example.com";
const TOKEN = `gep_${"a".repeat(64)}`;
const samples: Readonly<Record<string, string>> = {
  repositoryId: "r1",
  owner: "alice",
  repo: "site",
  number: "7",
};

function concretePath(operation: ApiOperation): string {
  return operation.path.replaceAll(/\{([A-Za-z]+)\}/g, (_, name: string) => samples[name] ?? "x");
}

interface Received {
  service: string;
  method: string;
  path: string;
}

function routingEnvironment(received: Received[]): GatewayEnv {
  const record = (name: string): GatewayService => ({
    fetch: async (request) => {
      received.push({ service: name, method: request.method, path: new URL(request.url).pathname });
      return Response.json({ data: { ok: true } });
    },
  });
  return {
    AUTH: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        received.push({ service: "auth", method: request.method, path });
        return Response.json({
          data: {
            id: "u1",
            identifier: "alice",
            groupKey: "free",
            token: { id: "t1", scopes: ["admin"] },
          },
        });
      },
    },
    FORGE: record("forge"),
    GIT: record("git"),
    ASSETS: record("assets"),
    RATE_LIMITER: {
      getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
    },
  };
}

/** Route literals the services match, read from source so a new route cannot go unnoticed. */
function sourceLiterals(file: string, pattern: RegExp): Set<string> {
  const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  return new Set(Array.from(source.matchAll(pattern), (match) => match[1]));
}

/** Git API resources that are intentionally outside the OpenAPI document, with the reason. */
const UNDOCUMENTED_GIT_RESOURCES: Readonly<Record<string, string>> = {
  archive: "Binary download; documented in docs/api-endpoints.md.",
  raw: "Binary download; documented in docs/api-endpoints.md.",
  branches: "Branch management for the web Code view.",
  tags: "Tag management for the web Code view.",
  commit: "Commit lookup and multipart web commits used by the web client.",
  edit: "Single-file web edit used by the web client.",
  merge: "Called by Forge only; the Gateway refuses it.",
  graph: "Commit graph rendering for the web client.",
  community: "Community file discovery for the web client.",
  signature: "Signature verification detail for the web client.",
  snapshot: "Deployment source snapshot used by the deployment wizard.",
};

/** Issue, pull request and task sub-resources that are intentionally undocumented. */
const UNDOCUMENTED_FORGE_ACTIONS: Readonly<Record<string, string>> = {
  assignees: "Assignment editing for the web client.",
  diff: "Pull request diff; use the documented Git compare operation.",
  merge: "Merging stays in the web review flow.",
  references: "Issue cross-reference panel for the web client.",
  documents: "Task document editing for the web client.",
  links: "Task link editing for the web client.",
  commits: "Task commit binding for the web client.",
  history: "Wiki page history.",
  revisions: "Wiki page revisions.",
  restore: "Wiki page restore.",
};

/** Forks, stars, merge automation, agent events, AI summaries, Pages and signatures routes. */
const COLLABORATION_ROUTES: readonly string[] = [
  "POST /api/auth/agent-session/renew",
  "POST /api/auth/agents/{agentId}/sessions/{sessionId}/renew",
  "PATCH /api/auth/agents/{agentId}",
  "GET /api/auth/signing-keys",
  "POST /api/auth/signing-keys/challenges",
  "GET /api/forge/explore",
  "GET /api/forge/explore/topics",
  "GET /api/forge/stars",
  "GET /api/forge/agents/{agentId}/event-feed",
  "GET /api/forge/repositories/{repositoryId}/forks",
  "POST /api/forge/repositories/{repositoryId}/forks",
  "GET /api/forge/repositories/{repositoryId}/social",
  "PUT /api/forge/repositories/{repositoryId}/star",
  "DELETE /api/forge/repositories/{repositoryId}/star",
  "PUT /api/forge/repositories/{repositoryId}/watch",
  "PUT /api/forge/repositories/{repositoryId}/topics",
  "GET /api/forge/repositories/{repositoryId}/pages",
  "PUT /api/forge/repositories/{repositoryId}/pages",
  "GET /api/forge/repositories/{repositoryId}/merge-queue",
  "GET /api/forge/repositories/{repositoryId}/agent-events",
  "GET /api/forge/repositories/{repositoryId}/agent-events/stream",
  "GET /api/forge/repositories/{repositoryId}/pull-requests/{number}/auto-merge",
  "PUT /api/forge/repositories/{repositoryId}/pull-requests/{number}/auto-merge",
  "DELETE /api/forge/repositories/{repositoryId}/pull-requests/{number}/auto-merge",
  "GET /api/forge/repositories/{repositoryId}/pull-requests/{number}/merge-queue",
  "POST /api/forge/repositories/{repositoryId}/pull-requests/{number}/merge-queue",
  "DELETE /api/forge/repositories/{repositoryId}/pull-requests/{number}/merge-queue",
  "GET /api/forge/repositories/{repositoryId}/pull-requests/{number}/ai-summary",
  "POST /api/forge/repositories/{repositoryId}/pull-requests/{number}/ai-summary",
  "POST /api/forge/repositories/{repositoryId}/tasks/{number}/claim",
  "POST /api/forge/repositories/{repositoryId}/tasks/{number}/heartbeat",
  "POST /api/forge/repositories/{repositoryId}/tasks/{number}/release",
  "POST /api/forge/repositories/{repositoryId}/tasks/{number}/complete",
  "POST /api/git/repositories/{repositoryId}/fork-sync",
  "GET /api/git/repositories/{repositoryId}/signature",
];

/** Collaboration routes that are intentionally undocumented, with the reason. */
const UNDOCUMENTED_COLLABORATION_ROUTES: Readonly<Record<string, string>> = {
  "POST /api/auth/agents/{agentId}/sessions/{sessionId}/renew":
    "Owner renewal from the agent settings page; agents renew their own session.",
  "PATCH /api/auth/agents/{agentId}": "Agent settings, including the delivery mode, for the owner.",
  "GET /api/auth/signing-keys": "Account security settings for the web client.",
  "POST /api/auth/signing-keys/challenges": "Account security settings for the web client.",
  "GET /api/forge/agents/{agentId}/event-feed": "Owner-facing feed status for agent settings.",
  "GET /api/forge/repositories/{repositoryId}/agent-events/stream":
    "Server-Sent Events, not JSON; documented in docs/api-endpoints.md.",
  "GET /api/git/repositories/{repositoryId}/signature":
    "Signature verification detail for the web client.",
};

describe("OpenAPI document", () => {
  const document = buildOpenApiDocument(ORIGIN);

  it("is an OpenAPI 3.1 document with unique operations and declared path parameters", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: ORIGIN }]);
    const ids = API_OPERATIONS.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = API_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const operation of API_OPERATIONS) {
      const entry = document.paths[operation.path]?.[OPENAPI_METHOD_KEYS[operation.method]];
      expect(entry?.operationId).toBe(operation.operationId);
      const declared = entry?.parameters
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name);
      expect(declared).toEqual(
        Array.from(operation.path.matchAll(/\{([A-Za-z]+)\}/g), (match) => match[1])
      );
      expect(entry?.requestBody !== undefined).toBe(operation.body !== undefined);
      expect(JSON.stringify(entry)).not.toContain('"$schema"');
    }
  });

  it("documents the scope each service enforces for personal access tokens", () => {
    for (const operation of API_OPERATIONS) {
      if (operation.service !== "forge" && operation.service !== "git") {
        expect(operation.scope, operation.operationId).toBeNull();
        continue;
      }
      const parts = concretePath(operation).split("/").filter(Boolean).slice(2);
      expect(operation.scope, operation.operationId).toBe(
        requiredAccessTokenScope(operation.service, operation.method, parts)
      );
    }
  });

  it("routes every documented operation through the Gateway to its service", async () => {
    for (const operation of API_OPERATIONS) {
      const received: Received[] = [];
      const url = new URL(concretePath(operation), ORIGIN);
      for (const query of operation.query ?? [])
        if (query.required) url.searchParams.set(query.name, "value");
      const response = await handleGatewayRequest(
        new Request(url, {
          method: operation.method,
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          ...(operation.method === "GET" ? {} : { body: "{}" }),
        }),
        routingEnvironment(received)
      );
      expect(response.status, operation.operationId).toBe(200);
      const prefix = `/api/${operation.service}`;
      if (operation.service === "gateway") {
        // The Gateway answers these itself; health only probes internal endpoints.
        expect(
          received.every((entry) => entry.service === "auth" || entry.path.startsWith("/internal/"))
        ).toBe(true);
        continue;
      }
      expect(received.at(-1), operation.operationId).toEqual({
        service: operation.service,
        method: operation.method,
        path: concretePath(operation).slice(prefix.length),
      });
    }
  });

  it("serves the document anonymously with a shared cache lifetime", async () => {
    const response = await handleGatewayRequest(
      new Request(`${ORIGIN}${OPENAPI_PATH}`),
      routingEnvironment([])
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(document)));
  });

  it("documents or explicitly excludes every Git API resource", () => {
    const documented = new Set(
      API_OPERATIONS.filter((operation) => operation.service === "git").map((operation) =>
        operation.path.split("/").at(-1)
      )
    );
    const resources = sourceLiterals("workers/git/src/api.ts", /resource === "([a-z-]+)"/g);
    for (const resource of resources)
      expect(
        documented.has(resource) || resource in UNDOCUMENTED_GIT_RESOURCES,
        `Git resource ${resource}`
      ).toBe(true);
    for (const resource of [...documented, ...Object.keys(UNDOCUMENTED_GIT_RESOURCES)])
      expect(resources.has(resource ?? ""), `Git resource ${resource} exists`).toBe(true);
  });

  it("documents or explicitly excludes every collaboration route", () => {
    const documented = new Set(
      API_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`)
    );
    for (const route of COLLABORATION_ROUTES)
      expect(
        documented.has(route) !== route in UNDOCUMENTED_COLLABORATION_ROUTES,
        `Collaboration route ${route}`
      ).toBe(true);
    for (const route of Object.keys(UNDOCUMENTED_COLLABORATION_ROUTES))
      expect(COLLABORATION_ROUTES, route).toContain(route);
  });

  it("documents or explicitly excludes every issue, pull request and task sub-resource", () => {
    const documented = new Set(
      API_OPERATIONS.flatMap((operation) => {
        const match = /\/(?:issues|pull-requests|tasks)\/\{number\}\/([a-z-]+)$/.exec(
          operation.path
        );
        return match ? [match[1]] : [];
      })
    );
    const actions = new Set([
      ...sourceLiterals("workers/forge/src/index.ts", /action === "([a-z-]+)"/g),
      ...sourceLiterals("workers/forge/src/tasks.ts", /action === "([a-z-]+)"/g),
      ...sourceLiterals("workers/forge/src/merge-routes.ts", /action [!=]== "([a-z-]+)"/g),
      ...sourceLiterals("workers/forge/src/ai-summary.ts", /rest\[2\] [!=]== "([a-z-]+)"/g),
    ]);
    for (const action of actions)
      expect(
        documented.has(action) || action in UNDOCUMENTED_FORGE_ACTIONS,
        `Forge action ${action}`
      ).toBe(true);
    for (const action of [...documented, ...Object.keys(UNDOCUMENTED_FORGE_ACTIONS)])
      expect(actions.has(action), `Forge action ${action} exists`).toBe(true);
  });
});

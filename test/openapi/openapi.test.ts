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

import { describe, expect, it } from "vitest";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import actions from "../../workers/actions/src/index";

const workflow = `name: Checks
on:
  workflow_dispatch: {}
jobs:
  test:
    steps:
      - run: echo ready
`;

describe("Actions Worker workflow listing", () => {
  it("reads the selected repository snapshot and marks the workflow as runnable", async () => {
    const fileBytes = new TextEncoder().encode(workflow);
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () =>
                  sql.includes("CASE WHEN m.role")
                    ? { role: "admin" }
                    : {
                        id: "repository-1",
                        created_by: "user-1",
                        visibility: "public",
                        archived: 0,
                        actions_enabled: 1,
                        actions_network_enabled: 0,
                        default_branch: "main",
                      },
              };
            },
          };
        },
      },
      ACTION_RUNS: {},
      GIT: {
        fetch: async () =>
          Response.json({
            data: {
              oid: "a".repeat(40),
              totalBytes: fileBytes.byteLength,
              files: [
                {
                  path: ".github/workflows/checks.yml",
                  contentBase64: btoa(String.fromCharCode(...fileBytes)),
                  mode: "100644",
                },
              ],
            },
          }),
      },
      FORGE: { fetch: async () => new Response(null, { status: 204 }) },
    } as unknown as Parameters<typeof actions.fetch>[1];
    const headers = trustedHeaders({ id: "user-1", identifier: "user", groupKey: "free" });
    const response = await actions.fetch(
      new Request("https://actions.test/repositories/repository-1/workflows?ref=refs/heads/main", {
        headers,
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        oid: "a".repeat(40),
        workflows: [
          {
            path: ".github/workflows/checks.yml",
            name: "Checks",
            supported: true,
            triggers: ["workflow_dispatch"],
          },
        ],
      },
    });
  });

  it("queues a manual run for the exact snapshot and publishes the queued check", async () => {
    const files = [
      {
        path: ".github/workflows/checks.yml",
        contentBase64: btoa(workflow),
        mode: "100644",
      },
      { path: "package.json", contentBase64: "e30=", mode: "100644" },
    ];
    let queuedInput: unknown;
    let queuedRunId = "";
    const writtenChunks: Array<{ index: number; value: string }> = [];
    let scheduled = false;
    let checkPayload: unknown;
    const run = {
      id: "run-1",
      repositoryId: "repository-1",
      commitOid: "b".repeat(40),
      workflowPath: ".github/workflows/checks.yml",
      workflowName: "Checks",
      ref: "refs/heads/main",
      createdBy: "user-1",
      createdAt: 1,
      startedAt: null,
      status: "queued",
      conclusion: null,
      outputTruncated: false,
      jobs: [],
    };
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () =>
                  sql.includes("CASE WHEN m.role")
                    ? { role: "admin" }
                    : {
                        id: "repository-1",
                        created_by: "user-1",
                        visibility: "public",
                        archived: 0,
                        actions_enabled: 1,
                        actions_network_enabled: 0,
                        default_branch: "main",
                      },
                run: async () => ({ meta: { changes: 1 } }),
              };
            },
          };
        },
      },
      ACTION_RUNS: {
        getByName() {
          return {
            async isContainerConfigured() {
              return true;
            },
            async initialize(input: { id: string }) {
              queuedInput = input;
              queuedRunId = input.id;
            },
            async writeInputChunk(index: number, value: string) {
              writtenChunks.push({ index, value });
            },
            async schedule() {
              scheduled = true;
            },
            async getRun() {
              return { ...run, id: queuedRunId };
            },
          };
        },
      },
      GIT: {
        fetch: async () =>
          Response.json({
            data: {
              oid: "b".repeat(40),
              totalBytes: new TextEncoder().encode(workflow).byteLength + 2,
              files,
            },
          }),
      },
      FORGE: {
        fetch: async (request: Request) => {
          checkPayload = await request.json();
          return new Response(null, { status: 204 });
        },
      },
    } as unknown as Parameters<typeof actions.fetch>[1];
    const headers = trustedHeaders({ id: "user-1", identifier: "user", groupKey: "free" });
    const response = await actions.fetch(
      new Request("https://actions.test/repositories/repository-1/runs", {
        method: "POST",
        headers: new Headers([...headers, ["Content-Type", "application/json"]]),
        body: JSON.stringify({
          workflowPath: ".github/workflows/checks.yml",
          ref: "refs/heads/main",
          expectedOid: "b".repeat(40),
        }),
      }),
      env
    );

    expect(response.status).toBe(202);
    expect(queuedInput).toMatchObject({ commitOid: "b".repeat(40), enableInternet: false });
    expect(writtenChunks).toHaveLength(1);
    expect(scheduled).toBe(true);
    expect(checkPayload).toMatchObject({ runId: queuedRunId, status: "queued", conclusion: null });
  });

  it("accepts push automation only from the internal service hostname", async () => {
    const pushWorkflow = `name: Push checks
on:
  push: {}
jobs:
  test:
    steps:
      - run: echo pushed
`;
    const bytes = new TextEncoder().encode(pushWorkflow);
    const files = [
      {
        path: ".github/workflows/push.yml",
        contentBase64: btoa(String.fromCharCode(...bytes)),
        mode: "100644",
      },
    ];
    let queuedInput: { id: string; commitOid: string; ref: string } | undefined;
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () =>
                  sql.includes("CASE WHEN m.role")
                    ? { role: "admin" }
                    : {
                        id: "repository-1",
                        created_by: "user-1",
                        visibility: "public",
                        archived: 0,
                        actions_enabled: 1,
                        actions_network_enabled: 0,
                        default_branch: "main",
                      },
                run: async () => ({ meta: { changes: 1 } }),
              };
            },
          };
        },
      },
      ACTION_RUNS: {
        getByName() {
          return {
            async isContainerConfigured() {
              return true;
            },
            async initialize(input: { id: string; commitOid: string; ref: string }) {
              queuedInput = input;
            },
            async writeInputChunk() {},
            async schedule() {},
            async getRun() {
              return queuedInput
                ? {
                    ...queuedInput,
                    repositoryId: "repository-1",
                    workflowPath: ".github/workflows/push.yml",
                    workflowName: "Push checks",
                    createdBy: "user-1",
                    createdAt: 1,
                    startedAt: null,
                    status: "queued",
                    conclusion: null,
                    outputTruncated: false,
                    jobs: [],
                  }
                : null;
            },
            async cancel() {
              return null;
            },
            async failStaleRun() {
              return null;
            },
          };
        },
      },
      GIT: {
        fetch: async () =>
          Response.json({
            data: {
              oid: "c".repeat(40),
              totalBytes: bytes.byteLength,
              files,
            },
          }),
      },
      FORGE: { fetch: async () => new Response(null, { status: 204 }) },
    } as unknown as Parameters<typeof actions.fetch>[1];
    const headers = trustedHeaders({ id: "user-1", identifier: "user", groupKey: "free" });
    const payload = JSON.stringify({
      repositoryId: "repository-1",
      ref: "refs/heads/main",
      expectedOid: "c".repeat(40),
    });
    const external = await actions.fetch(
      new Request("https://public.test/internal/push", { method: "POST", headers, body: payload }),
      env
    );
    const internal = await actions.fetch(
      new Request("https://actions.internal/internal/push", {
        method: "POST",
        headers,
        body: payload,
      }),
      env
    );

    expect(external.status).toBe(404);
    expect(internal.status).toBe(202);
    await expect(internal.json()).resolves.toMatchObject({
      data: { runs: [{ workflowName: "Push checks", commitOid: "c".repeat(40) }], failures: [] },
    });
  });
});

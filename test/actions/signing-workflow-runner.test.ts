import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { parseJobClaim } from "../../packages/contracts/runner-scheduling.mjs";
import {
  createSigningWorkflow,
  normalizeSigningWorkflowTimeout,
  readSigningReceipt,
} from "../../scripts/runner-broker-signing-workflow.mjs";
import { validateSingleSigningJob } from "../../workers/actions/src/runner-workflow";

const workflow = `name: signed release
on: workflow_dispatch
jobs:
  sign:
    runs-on: [self-hosted, macos, arm64, need-time-5m, need-mem-2g, need-cpu-2, need-tool-python]
    timeout-minutes: 5
    env:
      PYTHON: /opt/toolchain/python
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
      - run: echo "/opt/toolchain/bin" >> "$GITHUB_PATH"
`;

describe("native signing workflow runner", () => {
  it("accepts one static signing job and rejects matrix or multi-job profiles at approval", () => {
    expect(() => validateSingleSigningJob(".github/workflows/sign.yml", workflow)).not.toThrow();
    expect(() =>
      validateSingleSigningJob(
        ".github/workflows/sign.yml",
        workflow.replace(
          "    runs-on:",
          "    strategy:\n      matrix:\n        os: [macos, windows]\n    runs-on:"
        )
      )
    ).toThrow();
    expect(() =>
      validateSingleSigningJob(
        ".github/workflows/sign.yml",
        workflow.replace(
          "  sign:\n",
          "  extra:\n    runs-on: [self-hosted, macos, arm64]\n    steps:\n      - run: true\n  sign:\n"
        )
      )
    ).toThrow();
  });

  it("appends the SDK to the same job after setup steps with only protected-context paths", () => {
    const source = createSigningWorkflow(workflow, {
      platform: "macos",
      clientPath: "/srv/gitedge/scripts/signing/client.mjs",
      contextFile: "/private/context.json",
      outputParent: "/private/run",
      receiptFile: "/private/receipt.json",
      timeoutMinutes: 90,
    });
    expect(source.indexOf("actions/setup-python")).toBeLessThan(
      source.indexOf("GitEdge native signing")
    );
    expect(source).toContain("/opt/toolchain/python");
    expect(source).toContain("GITEDGE_SIGNING_CONTEXT_FILE: /private/context.json");
    const trusted = parseDocument(source).toJS();
    expect(trusted.jobs.sign["timeout-minutes"]).toBe(90);
    expect(trusted.jobs.sign["runs-on"]).toEqual([
      "self-hosted",
      "macos",
      "arm64",
      "need-mem-2g",
      "need-cpu-2",
      "need-tool-python",
      "need-time-90m",
    ]);
    expect(source).not.toContain("runnerToken");
    expect(source).not.toContain("certificate_password");
  });

  it.each([
    [
      "multiple jobs",
      workflow.replace(
        "  sign:\n",
        "  other:\n    runs-on: [self-hosted, macos, arm64]\n    steps:\n      - run: true\n  sign:\n"
      ),
    ],
    [
      "matrix expansion",
      workflow.replace(
        "    runs-on:",
        "    strategy:\n      matrix:\n        os: [macos, windows]\n    runs-on:"
      ),
    ],
    ["conditional skip", workflow.replace("    runs-on:", "    if: false\n    runs-on:")],
  ])("rejects signing workflow preparation with %s before a runner can start", (_name, source) => {
    expect(() =>
      createSigningWorkflow(source, {
        platform: "macos",
        clientPath: "/client.mjs",
        contextFile: "/context.json",
        outputParent: "/run",
        receiptFile: "/receipt.json",
        timeoutMinutes: 90,
      })
    ).toThrow();
  });

  it.each([0, 361, 1.5, Number.NaN])(
    "rejects an invalid trusted signing job timeout (%s)",
    (timeoutMinutes) => {
      expect(() =>
        createSigningWorkflow(workflow, {
          platform: "macos",
          clientPath: "/client.mjs",
          contextFile: "/context.json",
          outputParent: "/run",
          receiptFile: "/receipt.json",
          timeoutMinutes,
        })
      ).toThrow("Signing workflow timeout is invalid.");
    }
  );

  it("rejects malformed time requirements instead of replacing them with the approved budget", () => {
    const invalid = workflow.replace("need-time-5m", "need-time-999m");
    const normalized = normalizeSigningWorkflowTimeout(invalid, 90);
    const labels = parseDocument(normalized).toJS().jobs.sign["runs-on"];
    expect(labels).toContain("need-time-999m");
    expect(parseJobClaim(labels).valid).toBe(false);
  });

  it("requires an SDK receipt even when the runner itself exits successfully", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gitedge-signing-receipt-"));
    try {
      const receipt = path.join(directory, "receipt.json");
      await expect(readSigningReceipt(receipt, "request-id")).rejects.toThrow();
      await writeFile(
        receipt,
        JSON.stringify({
          requestId: "other",
          outputDigest: `sha256:${"a".repeat(64)}`,
          outputSize: 3,
        })
      );
      await expect(readSigningReceipt(receipt, "request-id")).rejects.toThrow();
      await writeFile(
        receipt,
        JSON.stringify({
          requestId: "request-id",
          outputDigest: `sha256:${"a".repeat(64)}`,
          outputSize: 3,
        })
      );
      await expect(readSigningReceipt(receipt, "request-id")).resolves.toMatchObject({
        requestId: "request-id",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

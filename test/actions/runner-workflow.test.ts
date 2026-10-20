import { describe, expect, it } from "vitest";
import {
  parseRunnerWorkflow,
  runnerDispatchInputs,
} from "../../workers/actions/src/runner-workflow";
import { WorkflowValidationError } from "../../workers/actions/src/workflow";

const workflow = (options = "") => `name: Verify
on:
  push:
    branches: [main]
    branches-ignore: [release/**]
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        required: true
        options: [safe, full]
      retries:
        type: number
        default: 2
      verbose:
        type: boolean
        default: false
      note:
        description: Optional note
jobs:
  verify:
    runs-on: [self-hosted, linux, x64, ci]
    steps:
      - run: npm test
${options}`;

describe("parseRunnerWorkflow public contract", () => {
  it("accepts supported triggers, branch filters, permissions and literal host labels", () => {
    const parsed = parseRunnerWorkflow(
      ".github/workflows/verify.yml",
      workflow("permissions:\n  contents: write\n")
    );

    expect(parsed.workflow.triggers).toEqual(["push", "workflow_dispatch"]);
    expect(parsed.workflow.triggerFilters).toEqual({
      push: { branches: ["main"], branchesIgnore: ["release/**"] },
    });
    expect(parsed.permission).toBe("write");
    expect(parsed.labels).toEqual(["self-hosted", "linux", "x64", "ci"]);
    expect(parsed.timeoutMinutes).toBe(60);
  });

  it("defaults contents permission to read", () => {
    expect(parseRunnerWorkflow(".github/workflows/verify.yml", workflow()).permission).toBe("read");
  });

  it.each([
    ["a non-GitHub workflow path", "workflows/verify.yml", workflow()],
    [
      "an unsupported trigger",
      ".github/workflows/verify.yml",
      workflow().replace(
        "  push:\n    branches: [main]\n    branches-ignore: [release/**]\n",
        "  pull_request: {}\n"
      ),
    ],
    [
      "a path filter",
      ".github/workflows/verify.yml",
      workflow().replace("    branches: [main]", "    paths: [src/**]"),
    ],
    [
      "an extra permission",
      ".github/workflows/verify.yml",
      workflow("permissions:\n  contents: read\n  issues: write\n"),
    ],
    [
      "job-level permissions",
      ".github/workflows/verify.yml",
      workflow().replace("    runs-on:", "    permissions: {}\n    runs-on:"),
    ],
    [
      "an unknown workflow declaration",
      ".github/workflows/verify.yml",
      workflow("unsupported: true\n"),
    ],
    [
      "a GitHub-hosted label",
      ".github/workflows/verify.yml",
      workflow().replace("[self-hosted, linux, x64, ci]", "[ubuntu-latest]"),
    ],
    [
      "an expression in runs-on",
      ".github/workflows/verify.yml",
      workflow().replace("[self-hosted, linux, x64, ci]", "${{ runner.os }}"),
    ],
    [
      "an unknown job declaration",
      ".github/workflows/verify.yml",
      workflow().replace("    runs-on:", "    strategy: {}\n    runs-on:"),
    ],
    [
      "an unknown dispatch input field",
      ".github/workflows/verify.yml",
      workflow().replace("        type: choice", "        type: choice\n        unsupported: true"),
    ],
  ])("rejects %s", (_reason, path, source) => {
    expect(() => parseRunnerWorkflow(path, source)).toThrow(WorkflowValidationError);
  });
});

describe("runnerDispatchInputs public contract", () => {
  const definition = parseRunnerWorkflow(".github/workflows/verify.yml", workflow());

  it("applies choice and scalar defaults, accepts supplied typed values, and omits optional values", () => {
    expect(runnerDispatchInputs(definition, { mode: "full", verbose: true })).toEqual({
      mode: "full",
      retries: 2,
      verbose: true,
    });
    expect(runnerDispatchInputs(definition, { mode: "safe", retries: 4, note: "ship" })).toEqual({
      mode: "safe",
      retries: 4,
      verbose: false,
      note: "ship",
    });
  });

  it.each([
    ["a missing required input", {}],
    ["an unknown input", { mode: "safe", extra: "value" }],
    ["an invalid choice", { mode: "fast" }],
    ["a string for a number input", { mode: "safe", retries: "4" }],
    ["a number for a boolean input", { mode: "safe", verbose: 1 }],
    ["a nonscalar value", { mode: "safe", note: ["value"] }],
  ])("rejects %s", (_reason, supplied) => {
    expect(() => runnerDispatchInputs(definition, supplied)).toThrow(WorkflowValidationError);
  });
});

import { describe, expect, it } from "vitest";
import { parseWorkflow, WorkflowValidationError } from "../../workers/actions/src/workflow";

const source = `name: Verify
on:
  workflow_dispatch: {}
  push: {}
jobs:
  test:
    name: Unit tests
    steps:
      - name: Run tests
        shell: bash
        run: npm test
      - run: echo done
        env:
          CI: "true"
`;

describe("parseWorkflow", () => {
  it("normalizes the supported workflow subset", () => {
    expect(parseWorkflow(".github/workflows/verify.yml", source)).toEqual({
      path: ".github/workflows/verify.yml",
      name: "Verify",
      triggers: ["workflow_dispatch", "push"],
      jobs: [
        {
          id: "test",
          name: "Unit tests",
          steps: [
            {
              name: "Run tests",
              run: "npm test",
              shell: "bash",
              workingDirectory: null,
              env: {},
            },
            {
              name: "Step 2",
              run: "echo done",
              shell: "sh",
              workingDirectory: null,
              env: { CI: "true" },
            },
          ],
        },
      ],
    });
  });

  it.each([
    ["unsupported action reference", source.replace("run: npm test", "uses: actions/checkout@v4")],
    ["dynamic expression", source.replace("run: npm test", "run: echo ${{ github.sha }}")],
    ["push filters", source.replace("push: {}", "push:\n    branches: [main]")],
    ["unsupported shell", source.replace("shell: bash", "shell: powershell")],
    ["invalid workflow path", source],
  ])("rejects %s", (reason, yaml) => {
    const path =
      reason === "invalid workflow path"
        ? ".github/workflows/../evil.yml"
        : ".github/workflows/verify.yml";
    expect(() => parseWorkflow(path, yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects duplicate YAML keys and alias expansion", () => {
    expect(() =>
      parseWorkflow(
        ".github/workflows/verify.yml",
        source.replace("name: Verify", "name: Verify\nname: Duplicate")
      )
    ).toThrow(WorkflowValidationError);
    expect(() =>
      parseWorkflow(
        ".github/workflows/verify.yml",
        "name: &workflow Verify\non: { workflow_dispatch: {} }\njobs: { test: { name: *workflow, steps: [{ run: echo ok }] } }\n"
      )
    ).toThrow(WorkflowValidationError);
  });

  it.each([
    ["on: push", "on: push", ["push"]],
    [
      "on: [push, workflow_dispatch]",
      "on: [push, workflow_dispatch]",
      ["push", "workflow_dispatch"],
    ],
  ])("accepts the %s shorthand", (_label, on, triggers) => {
    const yaml = source.replace(/on:\n {2}workflow_dispatch: \{\}\n {2}push: \{\}/, on);
    expect(parseWorkflow(".github/workflows/verify.yml", yaml).triggers).toEqual(triggers);
  });

  it.each([
    ["unsupported list entry", "on: [push, pull_request]"],
    ["empty list", "on: []"],
    ["duplicate entries", "on: [push, push]"],
    ["scalar list entry", "on: [1]"],
    ["number", "on: 5"],
  ])("rejects the on shorthand with %s", (_label, on) => {
    const yaml = source.replace(/on:\n {2}workflow_dispatch: \{\}\n {2}push: \{\}/, on);
    expect(() => parseWorkflow(".github/workflows/verify.yml", yaml)).toThrow(
      WorkflowValidationError
    );
  });
});

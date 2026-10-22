import { describe, expect, it } from "vitest";
import { pythonRuntimeCommand } from "../scripts/signing/ios-sign.mjs";

describe("iOS signing Python runtime", () => {
  it("uses python3 when PYTHON is unset", () => {
    expect(pythonRuntimeCommand({})).toBe("python3");
  });

  it("uses an explicitly configured Python executable", () => {
    expect(pythonRuntimeCommand({ PYTHON: "/opt/homebrew/bin/python3.13" })).toBe(
      "/opt/homebrew/bin/python3.13"
    );
  });
});

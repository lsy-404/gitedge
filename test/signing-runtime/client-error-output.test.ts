import { describe, expect, it } from "vitest";
import { ClientError, formatClientErrorOutput } from "../../scripts/signing/client.mjs";

function signingFailure(message: string, cause: Error = new Error(message)) {
  const error = new ClientError("SIGNING_FAILED");
  error.cause = cause;
  return formatClientErrorOutput(error);
}

describe("safe signing client error output", () => {
  it("preserves the fixed macOS phase while omitting the executor message and stack", () => {
    const output = signingFailure("macOS signing operation failed: archive_validation");

    expect(output).toBe("SIGNING_FAILED\ndiagnostic: macos:archive_validation\n");
  });

  it("preserves fixed DMG and Windows diagnostics", () => {
    expect(signingFailure("disk image operation failed: stapling_exit_17")).toBe(
      "SIGNING_FAILED\ndiagnostic: dmg:stapling_exit_17\n"
    );
    expect(
      signingFailure("Windows signing operation failed: packaging [nsis_tool_makensis_exit_1]")
    ).toBe("SIGNING_FAILED\ndiagnostic: windows:packaging\n");
    expect(
      signingFailure("Windows signing operation failed: codesign [app:Sign:ps_timestamp_missing]")
    ).toBe("SIGNING_FAILED\ndiagnostic: windows:codesign\n");
    expect(
      signingFailure(
        "Windows signing operation failed: unknown_code [https://private.example/token]"
      )
    ).toBe("SIGNING_FAILED\ncause: Error\n");
  });

  it("reports only a built-in Error class when a phase or code is unknown", () => {
    const unknown = new Error(
      "macOS signing operation failed: unknown_secret_phase https://private.example/token"
    );
    unknown.stack = "private stack and filesystem path";

    expect(signingFailure(unknown.message, unknown)).toBe("SIGNING_FAILED\ncause: Error\n");
    expect(signingFailure("untrusted executor error", new TypeError("hidden detail"))).toBe(
      "SIGNING_FAILED\ncause: TypeError\n"
    );
    expect(formatClientErrorOutput(new Error("no message output"))).toBe(
      "SIGNING_FAILED\ncause: Error\n"
    );
  });

  it("never emits secret-like text, URLs, paths, or stack data from an unknown error", () => {
    const unknown = new Error(
      "secret=not-a-real-secret https://private.example/api C:\\private\\signing.p12"
    );
    unknown.stack = "at sign (C:\\private\\runner.js:1:2)";
    const output = signingFailure(unknown.message, unknown);

    expect(output).toBe("SIGNING_FAILED\ncause: Error\n");
    for (const text of ["not-a-real-secret", "https://", "C:\\", "private\\runner", "signing.p12"])
      expect(output).not.toContain(text);
  });

  it("rejects appended data even when it follows a known phase", () => {
    const output = signingFailure(
      "macOS signing operation failed: archive_validation; https://private.example/secret"
    );

    expect(output).toBe("SIGNING_FAILED\ncause: Error\n");
  });
});

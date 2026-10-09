import { describe, expect, it } from "vitest";
import { sanitizeAuditMetadata } from "../../src/worker/common/audit";

describe("audit metadata sanitization", () => {
  it("drops credential-like keys and redacts token-shaped values", () => {
    const clean = sanitizeAuditMetadata({
      role: "write",
      token: "gep_" + "a".repeat(64),
      tokenHash: "abc",
      password: "hunter2hunter2",
      recoveryCodes: ["aaaaa-bbbbb"],
      secret: "s",
      note: "ge_session_" + "b".repeat(64),
      link: "https://stack.test/invite#gei_" + "c".repeat(64),
      prefix: "gep_aaaaaaaa",
      nested: { deep: true },
      scopes: ["repo:read", "admin"],
    });
    expect(clean).toEqual({
      role: "write",
      note: "[redacted]",
      link: "[redacted]",
      prefix: "gep_aaaaaaaa",
      scopes: ["repo:read", "admin"],
    });
  });

  it("bounds long strings and oversized metadata", () => {
    expect(String(sanitizeAuditMetadata({ value: "x".repeat(1000) }).value)).toHaveLength(200);
    const many = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`k${i}`, "y".repeat(100)])
    );
    expect(sanitizeAuditMetadata(many)).toEqual({ truncated: true });
  });
});

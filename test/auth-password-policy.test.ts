import { describe, expect, it } from "vitest";
import { PBKDF2_ITERATIONS } from "../workers/auth/src/password";

describe("Auth password policy", () => {
  it("uses the maximum PBKDF2 iteration count supported by Workers", () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
  });
});

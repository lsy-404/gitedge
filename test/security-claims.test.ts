import { describe, expect, it } from "vitest";
import {
  RECENT_AUTH_WINDOW_MS,
  hasRecentAuth,
  readTrustedUser,
  trustedHeaders,
} from "../packages/contracts/src/index";

describe("recent authentication claim", () => {
  it("holds for ten minutes and not beyond", () => {
    const now = 1_000_000_000_000;
    expect(hasRecentAuth(now - 1000, now)).toBe(true);
    expect(hasRecentAuth(now - RECENT_AUTH_WINDOW_MS + 1, now)).toBe(true);
    expect(hasRecentAuth(now - RECENT_AUTH_WINDOW_MS, now)).toBe(false);
    expect(hasRecentAuth(undefined, now)).toBe(false);
    expect(hasRecentAuth(now + 5000, now)).toBe(false);
  });

  it("travels to downstream services as a trusted header", () => {
    const user = { id: "u1", identifier: "ada", groupKey: "free", recentAuthAt: 1_700_000_000_000 };
    const request = new Request("https://forge.internal/x", { headers: trustedHeaders(user) });
    expect(readTrustedUser(request)).toEqual(user);
    const without = new Request("https://forge.internal/x", {
      headers: trustedHeaders({ id: "u1", identifier: "ada", groupKey: "free" }),
    });
    expect(readTrustedUser(without)?.recentAuthAt).toBeUndefined();
  });

  it("ignores malformed values", () => {
    const headers = trustedHeaders({ id: "u1", identifier: "ada", groupKey: "free" });
    headers.set("X-GitEdge-Recent-Auth", "not-a-number");
    expect(
      readTrustedUser(new Request("https://forge.internal/x", { headers }))?.recentAuthAt
    ).toBeUndefined();
  });
});

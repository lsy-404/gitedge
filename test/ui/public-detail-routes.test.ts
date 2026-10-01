import { describe, expect, it } from "vitest";
import { router } from "../../apps/web/src/router";

describe("anonymous repository detail routes", () => {
  it.each([
    "/verify-ddaa8275/workspace/issues/1",
    "/verify-ddaa8275/workspace/pulls/1",
    "/verify-ddaa8275/workspace/discussions/1",
    "/verify-ddaa8275/workspace/wiki/overview",
  ])("keeps %s on the anonymous-readable repository route", (path) => {
    const resolved = router.resolve(path);

    expect(resolved.matched).not.toHaveLength(0);
    expect(resolved.meta.allowAnonymous).toBe(true);
  });
});

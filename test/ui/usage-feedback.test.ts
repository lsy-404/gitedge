import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import AccountUsage from "../../apps/web/src/components/AccountUsage.vue";
import { ApiError, api, errorMessage, formatBytes } from "../../apps/web/src/lib/api";
import { i18n } from "../../apps/web/src/i18n";
import type { Usage } from "../../packages/contracts/src/ops";
import { mountAt, settle, unmountAll } from "./task-support";

const t = (key: string, values?: Record<string, string | number>) =>
  String(i18n.global.t(key, values ?? {}));

beforeEach(() => {
  i18n.global.locale.value = "en";
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function failure(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      })
    )
  );
  return api.usage().then(
    () => {
      throw new Error("expected failure");
    },
    (cause: unknown) => cause
  );
}

describe("limit feedback", () => {
  it("reads Retry-After from the header and shows the wait time", async () => {
    const cause = await failure(
      429,
      { error: "Rate limit exceeded", retryAfter: 9 },
      { "Retry-After": "42" }
    );
    expect(cause).toBeInstanceOf(ApiError);
    expect((cause as ApiError).retryAfter).toBe(42);
    expect((cause as ApiError).message).toBe("Rate limit exceeded");
    expect(errorMessage(cause, t)).toBe("Too many requests. Try again in 42 seconds.");
  });

  it("falls back to the rate-limit body when the header is absent", async () => {
    const cause = await failure(429, { error: "Rate limit exceeded", retryAfter: 7 });
    expect(errorMessage(cause, t)).toBe("Too many requests. Try again in 7 seconds.");
  });

  it("keeps the generic message when no wait time is known", async () => {
    const cause = await failure(429, { error: { code: "rate_limited", message: "Slow down" } });
    expect(errorMessage(cause, t)).toBe("Too many requests. Try again later.");
  });

  it("explains a quota 403 with used and limit values", async () => {
    const cause = await failure(403, {
      error: {
        code: "quota_exceeded",
        message: "Repository limit reached for this user group.",
        quota: { resource: "repositories", used: 10, limit: 10 },
      },
    });
    expect((cause as ApiError).code).toBe("quota_exceeded");
    expect(errorMessage(cause, t, { 403: "permissionDenied" })).toBe(
      "Quota reached for repositories: 10 of 10."
    );
  });

  it("localizes the message in Chinese and formats storage in bytes units", async () => {
    i18n.global.locale.value = "zh-CN";
    const cause = await failure(403, {
      error: {
        code: "quota_exceeded",
        message: "x",
        quota: { resource: "storage", used: 1_073_741_824, limit: 5_368_709_120 },
      },
    });
    expect(errorMessage(cause, t)).toBe("已达到存储空间配额：1.0 GiB / 5.0 GiB。");
    expect(await failure(429, {}, { "Retry-After": "3" }).then((c) => errorMessage(c, t))).toBe(
      "请求过于频繁，请在 3 秒后重试。"
    );
  });

  it("ignores malformed Retry-After values and quota details", async () => {
    const cause = await failure(
      429,
      {
        error: { code: "x", message: "m", quota: { resource: "repositories", used: -1, limit: 0 } },
      },
      { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }
    );
    expect((cause as ApiError).retryAfter).toBeNull();
    expect((cause as ApiError).quota).toBeNull();
  });

  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5_368_709_120)).toBe("5.0 GiB");
    expect(formatBytes(107_374_182_400)).toBe("100 GiB");
  });
});

describe("Account usage card", () => {
  const usage: Usage = {
    groupKey: "free",
    repositories: { used: 3, limit: 10 },
    storage: { usedBytes: null, limitBytes: 5_368_709_120 },
    maxPushBytes: 268_435_456,
    maxRepositoryBytes: 1_073_741_824,
    rpm: 120,
  };

  it("shows repository use against its limit and an unmeasured storage note", async () => {
    vi.spyOn(api, "usage").mockResolvedValue(usage);
    const mounted = await mountAt("/_verify/account/usage", "/_verify/account/usage", () =>
      h(AccountUsage)
    );
    await settle();
    expect(mounted.root.textContent).toContain("3 of 10 used");
    expect(mounted.root.textContent).toContain("Usage is not measured yet · limit 5.0 GiB");
    expect(mounted.root.textContent).toContain("120 per minute");
    expect(mounted.root.textContent).toContain("free");
    const bar = mounted.root.querySelector("progress");
    expect(bar?.getAttribute("max")).toBe("10");
    expect(bar?.getAttribute("value")).toBe("3");
    expect(mounted.root.querySelectorAll("progress")).toHaveLength(1);
  });

  it("shows measured storage use when the service reports it", async () => {
    vi.spyOn(api, "usage").mockResolvedValue({
      ...usage,
      storage: { usedBytes: 1_073_741_824, limitBytes: 5_368_709_120 },
    });
    const mounted = await mountAt("/_verify/account/usage", "/_verify/account/usage", () =>
      h(AccountUsage)
    );
    await settle();
    expect(mounted.root.textContent).toContain("1.0 GiB of 5.0 GiB used");
    expect(mounted.root.querySelectorAll("progress")).toHaveLength(2);
  });
});

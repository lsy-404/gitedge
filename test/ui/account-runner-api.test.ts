import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../apps/web/src/lib/api";
import { repository } from "./task-support";

afterEach(() => vi.unstubAllGlobals());

describe("account Runner Forge API contract", () => {
  it("reads the owner's private Runner state from the Forge data envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { repository: null } }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.accountRunner()).resolves.toEqual({ repository: null });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/forge/account-runner");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
  });

  it("provisions through an empty-body POST and returns the repository data", async () => {
    const runner = {
      ...repository,
      owner: "ada",
      name: "Runner",
      slug: "runner",
      visibility: "private" as const,
      systemKind: "account_runner" as const,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: runner }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.createAccountRunner()).resolves.toEqual(runner);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/forge/account-runner");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });
});

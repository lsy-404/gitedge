import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  refreshSession,
  sessionState,
  setSession,
} from "../../apps/web/src/lib/session";

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

describe("browser session refresh", () => {
  it("shares the pending request between the shell and route guard", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn(() => pendingResponse);
    vi.stubGlobal("fetch", fetchMock);
    clearSession();
    sessionState.checked = false;

    const shellRefresh = refreshSession();
    const routeGuardRefresh = refreshSession();

    expect(routeGuardRefresh).toBe(shellRefresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(
      new Response(JSON.stringify({ data: { id: "user-1", identifier: "example-user" } }), {
        status: 200,
      })
    );
    await expect(Promise.all([shellRefresh, routeGuardRefresh])).resolves.toEqual([
      { id: "user-1", identifier: "example-user" },
      { id: "user-1", identifier: "example-user" },
    ]);
    expect(sessionState.user?.identifier).toBe("example-user");
    expect(sessionState.checked).toBe(true);
  });

  it("does not restore a session after sign-out wins a pending refresh", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pendingResponse)
    );
    clearSession();
    sessionState.checked = false;

    const pending = refreshSession();
    clearSession();
    resolveFetch(
      new Response(JSON.stringify({ data: { id: "user-1", identifier: "example-user" } }), {
        status: 200,
      })
    );
    await pending;

    expect(sessionState.user).toBeNull();
    expect(sessionState.checked).toBe(true);
    expect(sessionState.loading).toBe(false);
  });

  it("resolves concurrent refreshes to a user explicitly set during the request", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pendingResponse)
    );
    clearSession();
    sessionState.checked = false;

    const pending = refreshSession();
    setSession({ id: "current-user", identifier: "current-user" });
    resolveFetch(
      new Response(JSON.stringify({ data: { id: "stale-user", identifier: "stale-user" } }), {
        status: 200,
      })
    );
    await expect(pending).resolves.toMatchObject({ id: "current-user" });
    expect(sessionState.user?.id).toBe("current-user");
  });
});

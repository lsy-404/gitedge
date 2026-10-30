import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import GitAuthorizeView from "../../apps/web/src/pages/GitAuthorizeView.vue";
import { api } from "../../apps/web/src/lib/api";
import { i18n } from "../../apps/web/src/i18n";
import { setSession, clearSession } from "../../apps/web/src/lib/session";
import { findButton, mountAt, settle, unmountAll } from "./task-support";

beforeEach(() => {
  i18n.global.locale.value = "en";
  setSession({ id: "1", identifier: "alice" });
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
});
describe("Git browser authorization", () => {
  it("displays validated client, account and scopes and submits a decision", async () => {
    const get = vi
      .spyOn(api, "gitOAuthAuthorize")
      .mockResolvedValue({
        clientName: "Git Credential Manager",
        scopes: ["repo:read", "repo:write"],
      });
    const post = vi.spyOn(api, "gitOAuthDecision").mockRejectedValue(new Error("failed"));
    const path = "/_verify/git-oauth?client_id=gitedge-gcm&state=abc";
    const mounted = await mountAt("/_verify/git-oauth", path, () => h(GitAuthorizeView));
    await settle();
    expect(get).toHaveBeenCalledWith("client_id=gitedge-gcm&state=abc");
    expect(mounted.root.textContent).toContain("Git Credential Manager");
    expect(mounted.root.textContent).toContain("user@example.test");
    expect(mounted.root.textContent).toContain("Write and push");
    findButton(mounted.root, "Deny").click();
    await settle();
    expect(post).toHaveBeenCalledWith({ client_id: "gitedge-gcm", state: "abc", approve: false });
  });
  it("shows an error without offering authorization for an invalid request", async () => {
    vi.spyOn(api, "gitOAuthAuthorize").mockRejectedValue(new Error("invalid"));
    const mounted = await mountAt(
      "/_verify/git-invalid",
      "/_verify/git-invalid?redirect_uri=https://evil.test",
      () => h(GitAuthorizeView)
    );
    await settle();
    expect(mounted.root.textContent).not.toContain("Deny");
    expect(mounted.root.querySelector('[role="alert"]')).not.toBeNull();
  });
});

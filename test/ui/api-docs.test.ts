import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import AccessTokenSettings from "../../apps/web/src/components/AccessTokenSettings.vue";
import ApiDocsView from "../../apps/web/src/pages/ApiDocsView.vue";
import { zhOperationSummaries, zhTagNames } from "../../apps/web/src/i18n/apiOperations";
import { i18n } from "../../apps/web/src/i18n";
import { api } from "../../apps/web/src/lib/api";
import { clearSession } from "../../apps/web/src/lib/session";
import { router } from "../../apps/web/src/router";
import { API_OPERATIONS, OPENAPI_PATH } from "../../packages/contracts/src/openapi";
import { control, findButton, mountAt, settle, submit, unmountAll } from "./task-support";

beforeEach(() => {
  i18n.global.locale.value = "en";
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
});

describe("API reference page", () => {
  it("is a public route rendered from the OpenAPI operations", async () => {
    expect(router.resolve("/docs/api").meta.allowAnonymous).toBe(true);
    const mounted = await mountAt("/docs/api", "/docs/api", () => h(ApiDocsView));
    const text = mounted.root.textContent ?? "";
    for (const operation of API_OPERATIONS) {
      expect(text).toContain(operation.path);
      expect(text).toContain(operation.summary);
    }
    expect(mounted.root.querySelector(`a[href="${OPENAPI_PATH}"]`)).not.toBeNull();
    expect(text).toContain(`${window.location.origin}/mcp`);
    expect(text).toContain("Requires the issues:write scope");
  });

  it("translates every operation and tag into Chinese", async () => {
    for (const operation of API_OPERATIONS) {
      expect(zhOperationSummaries[operation.operationId], operation.operationId).toBeTruthy();
      expect(zhTagNames[operation.tag], operation.tag).toBeTruthy();
    }
    i18n.global.locale.value = "zh-CN";
    const mounted = await mountAt("/docs/api", "/docs/api", () => h(ApiDocsView));
    expect(mounted.root.textContent).toContain(zhOperationSummaries.createIssue);
    expect(mounted.root.textContent).toContain("API 参考");
  });
});

describe("MCP settings shortcut", () => {
  it("shows the MCP URL and prefills a token with the scopes the tools use", async () => {
    vi.spyOn(api, "repositories").mockResolvedValue([]);
    vi.spyOn(api, "accessTokens").mockResolvedValue([]);
    const create = vi.spyOn(api, "createAccessToken").mockResolvedValue({
      id: "pat-mcp",
      name: "MCP",
      prefix: "gep_mcp",
      scopes: ["repo:read", "issues:write", "pulls:write"],
      repositories: null,
      createdAt: 1,
      expiresAt: Date.now() + 86_400_000,
      lastUsedAt: null,
      revokedAt: null,
      token: `gep_${"m".repeat(64)}`,
    });
    const mounted = await mountAt("/_verify/account/tokens", "/_verify/account/tokens", () =>
      h(AccessTokenSettings)
    );
    expect(mounted.root.textContent).toContain(`${window.location.origin}/mcp`);
    findButton(mounted.root, "Create token for MCP").click();
    await settle();
    expect(control(mounted.root, "form input").getAttribute("value") ?? "").toBe("MCP");
    submit(control(mounted.root, "form"));
    await settle();
    expect(create).toHaveBeenCalledWith({
      name: "MCP",
      scopes: ["repo:read", "issues:write", "pulls:write"],
      expiresInDays: 30,
    });
    expect(mounted.root.textContent).toContain("Authorization: Bearer <this token>");
  });
});

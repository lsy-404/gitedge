import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RepositoryWebhooks from "../../apps/web/src/components/RepositoryWebhooks.vue";
import { i18n } from "../../apps/web/src/i18n";
import { ApiError, api } from "../../apps/web/src/lib/api";
import type {
  RepositoryWebhook,
  RepositoryWebhookDelivery,
} from "../../packages/contracts/src/webhooks";
import { control, fill, findButton, h, mountAt, settle, submit, unmountAll } from "./task-support";

const hook: RepositoryWebhook = {
  id: "h1",
  url: "https://hooks.example.com/receive",
  contentType: "json",
  events: ["push", "issues"],
  active: true,
  createdAt: 1,
  updatedAt: 2,
};
const delivery: RepositoryWebhookDelivery = {
  id: "d1",
  event: "push",
  action: null,
  status: "failed",
  responseStatus: 500,
  errorCode: "http_error",
  attemptCount: 5,
  nextAttemptAt: null,
  redeliveryOf: null,
  createdAt: 1_790_000_000_000,
  deliveredAt: null,
};

beforeEach(() => {
  i18n.global.locale.value = "en";
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function mountHooks(canManage = true) {
  return mountAt("/_verify/webhooks", "/_verify/webhooks", () =>
    h(RepositoryWebhooks, { repositoryId: "repo-1", canManage })
  );
}

describe("repository webhooks", () => {
  it("does not request administrator-only webhook settings for other members", async () => {
    const list = vi.spyOn(api, "repositoryWebhooks").mockResolvedValue([]);
    const mounted = await mountHooks(false);
    await settle();
    expect(list).not.toHaveBeenCalled();
    expect(mounted.root.textContent).toContain("signed JSON");
    expect(mounted.root.querySelector("form")).toBeNull();
    expect(mounted.root.querySelector('[role="alert"]')).toBeNull();
    mounted.unmount();
  });

  it("lists hooks, creates one and shows the generated secret once", async () => {
    vi.spyOn(api, "repositoryWebhooks").mockResolvedValue([structuredClone(hook)]);
    const create = vi.spyOn(api, "createRepositoryWebhook").mockResolvedValue({
      ...hook,
      id: "h2",
      url: "https://other.example.com/hook",
      events: ["push"],
      secret: "ge_webhook_abc",
    });
    const mounted = await mountHooks();
    expect(mounted.root.textContent).toContain("https://hooks.example.com/receive");
    expect(mounted.root.textContent).toContain("push · issues");

    fill(
      control(mounted.root, ".webhook-form input[type=url], .webhook-form input"),
      "https://other.example.com/hook"
    );
    submit(control(mounted.root, ".webhook-form"));
    await settle();
    expect(create).toHaveBeenCalledWith("repo-1", {
      url: "https://other.example.com/hook",
      contentType: "json",
      events: ["push"],
      active: true,
    });
    expect(mounted.root.textContent).toContain("ge_webhook_abc");
    expect(mounted.root.textContent).toContain("https://other.example.com/hook");
    mounted.unmount();
  });

  it("maps URL rejections to an actionable message", async () => {
    vi.spyOn(api, "repositoryWebhooks").mockResolvedValue([]);
    vi.spyOn(api, "createRepositoryWebhook").mockRejectedValue(
      new ApiError(400, "bad", "invalid_webhook_url")
    );
    const mounted = await mountHooks();
    fill(control(mounted.root, ".webhook-form input"), "https://10.0.0.1/");
    submit(control(mounted.root, ".webhook-form"));
    await settle();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid webhook URL"
    );
    mounted.unmount();
  });

  it("shows deliveries and redelivers a failed one", async () => {
    vi.spyOn(api, "repositoryWebhooks").mockResolvedValue([structuredClone(hook)]);
    const deliveries = vi
      .spyOn(api, "repositoryWebhookDeliveries")
      .mockResolvedValue([structuredClone(delivery)]);
    const redeliver = vi
      .spyOn(api, "redeliverRepositoryWebhook")
      .mockResolvedValue({ ...delivery, id: "d2", status: "success", redeliveryOf: "d1" });
    const mounted = await mountHooks();
    findButton(mounted.root, "Recent deliveries").click();
    await settle();
    expect(deliveries).toHaveBeenCalledWith("repo-1", "h1");
    expect(mounted.root.textContent).toContain("Failed");
    expect(mounted.root.textContent).toContain("HTTP 500");
    expect(mounted.root.textContent).toContain("5 attempts");
    findButton(mounted.root, "Redeliver").click();
    await settle();
    expect(redeliver).toHaveBeenCalledWith("repo-1", "h1", "d1");
    expect(deliveries).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it("sends a test request and removes a hook after confirmation", async () => {
    vi.spyOn(api, "repositoryWebhooks").mockResolvedValue([structuredClone(hook)]);
    vi.spyOn(api, "pingRepositoryWebhook").mockResolvedValue({ ...delivery, status: "success" });
    const remove = vi.spyOn(api, "deleteRepositoryWebhook").mockResolvedValue({ deleted: true });
    const mounted = await mountHooks();
    findButton(mounted.root, "Send test").click();
    await settle();
    expect(mounted.root.textContent).toContain("The test request was delivered.");
    const trigger = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>(".confirm-button button.fluent-button")
    ).find((button) => button.textContent?.includes("Delete"));
    trigger?.click();
    await settle();
    mounted.root
      .querySelector<HTMLButtonElement>(".confirm-button [role='group'] button.fluent-button")
      ?.click();
    await settle();
    expect(remove).toHaveBeenCalledWith("repo-1", "h1");
    expect(mounted.root.textContent).toContain("No webhooks configured.");
    mounted.unmount();
  });

  it("asks for reauthentication when the server requires it", async () => {
    vi.spyOn(api, "repositoryWebhooks").mockResolvedValue([]);
    vi.spyOn(api, "createRepositoryWebhook").mockRejectedValue(
      new ApiError(403, "reauth", "reauth_required")
    );
    const security = vi.spyOn(api, "security").mockRejectedValue(new Error("offline"));
    const mounted = await mountHooks();
    fill(control(mounted.root, ".webhook-form input"), "https://hooks.example.com/x");
    submit(control(mounted.root, ".webhook-form"));
    await settle();
    expect(security).toHaveBeenCalled();
    mounted.unmount();
  });
});

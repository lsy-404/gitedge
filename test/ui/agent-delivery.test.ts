import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentWebhookSettings from "../../apps/web/src/pages/AgentWebhookSettings.vue";
import { i18n } from "../../apps/web/src/i18n";
import { api, type Agent } from "../../apps/web/src/lib/api";
import type { AgentFeedStatus } from "../../packages/contracts/src/agent-events";
import { control, fill, h, mountAt, settle, submit, unmountAll } from "./task-support";

const agent: Agent = {
  id: "a1",
  owner: "example-user",
  handle: "builder",
  profilePath: "/example-user/@builder",
  name: "Builder",
  description: "",
  profilePublic: false,
  createdAt: 1,
  updatedAt: 1,
  disabledAt: null,
  deliveryMode: "webhook",
};
const status: AgentFeedStatus = {
  deliveryMode: "webhook",
  lastPolledAt: null,
  latestCursor: null,
  retained: 0,
  retentionDays: 7,
  maxEvents: 500,
};

beforeEach(() => {
  i18n.global.locale.value = "en";
  vi.spyOn(api, "agentWebhook").mockResolvedValue(null);
  vi.spyOn(api, "agentWebhookDeliveries").mockResolvedValue([]);
});

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const mountPage = () =>
  mountAt("/settings/agents/:id/webhook", "/settings/agents/a1/webhook", () =>
    h(AgentWebhookSettings)
  );

describe("agent event delivery settings", () => {
  it("shows the feed status and saves the chosen delivery mode", async () => {
    vi.spyOn(api, "agent").mockResolvedValue(structuredClone(agent));
    const feed = vi.spyOn(api, "agentFeedStatus").mockResolvedValue({ ...status });
    const update = vi
      .spyOn(api, "updateAgent")
      .mockResolvedValue({ ...agent, deliveryMode: "pull" });
    const mounted = await mountPage();
    expect(feed).toHaveBeenCalledWith("a1");
    expect(mounted.root.textContent).toContain("Never polled");
    expect(mounted.root.textContent).toContain("Events are kept for 7 days, up to 500");

    fill(
      control(mounted.root, "#agent-delivery-title ~ * select, form[aria-labelledby] select"),
      "pull"
    );
    submit(control(mounted.root, "form[aria-labelledby='agent-delivery-title']"));
    await settle();
    expect(update).toHaveBeenCalledWith("a1", { deliveryMode: "pull" });
    expect(mounted.root.textContent).toContain("Delivery mode saved.");
    mounted.unmount();
  });

  it("reports the last poll time and offers every event for webhooks", async () => {
    vi.spyOn(api, "agent").mockResolvedValue({ ...agent, deliveryMode: "both" });
    vi.spyOn(api, "agentFeedStatus").mockResolvedValue({
      ...status,
      deliveryMode: "both",
      lastPolledAt: 1_790_000_000_000,
      latestCursor: 42,
      retained: 3,
    });
    const mounted = await mountPage();
    expect(mounted.root.textContent).not.toContain("Never polled");
    expect(mounted.root.textContent).toContain("42");
    expect(mounted.root.textContent).toContain("Review requested");
    expect(mounted.root.textContent).toContain("Check completed");
    mounted.unmount();
  });
});

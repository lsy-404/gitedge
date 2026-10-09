import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accessTokenAllows,
  requiredAccessTokenScope,
} from "../../packages/contracts/src/access-tokens";
import {
  CreateRepositoryWebhookInputSchema,
  UpdateRepositoryWebhookInputSchema,
} from "../../packages/contracts/src/webhooks";
import {
  isPublicWebhookUrl,
  signWebhookBody,
  webhookRetryDelay,
} from "../../src/worker/common/webhooks";

describe("webhook signing", () => {
  it("produces the GitHub-compatible sha256= HMAC of the exact body", async () => {
    const body = JSON.stringify({ action: "opened", note: "unicode ✓" });
    const expected = createHmac("sha256", "s3cret-value-123456").update(body).digest("hex");
    await expect(signWebhookBody("s3cret-value-123456", body)).resolves.toBe(`sha256=${expected}`);
    await expect(signWebhookBody("other-secret-value-1", body)).resolves.not.toBe(
      `sha256=${expected}`
    );
  });
});

describe("webhook URL screening", () => {
  it.each(["https://hooks.example.com/path", "https://hooks.example.com:443/path?x=1"])(
    "accepts %s",
    (url) => expect(isPublicWebhookUrl(url)).toBe(true)
  );

  it.each([
    "http://hooks.example.com/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://10.0.0.5/hook",
    "https://[::1]/hook",
    "https://service.internal/hook",
    "https://printer.local/hook",
    "https://user:pass@hooks.example.com/",
    "https://hooks.example.com:8443/",
    "https://hooks.example.com/#fragment",
    "https://intranet/",
    "ftp://hooks.example.com/",
    "not a url",
  ])("rejects %s", (url) => expect(isPublicWebhookUrl(url)).toBe(false));
});

describe("webhook retry schedule", () => {
  it("backs off exponentially from one minute and caps at fifteen", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(webhookRetryDelay)).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
    ]);
  });
});

describe("webhook and notification contracts", () => {
  it("validates event lists", () => {
    expect(
      CreateRepositoryWebhookInputSchema.safeParse({
        url: "https://hooks.example.com/x",
        events: ["push", "issues"],
      }).success
    ).toBe(true);
    for (const events of [[], ["push", "push"], ["release"]])
      expect(
        CreateRepositoryWebhookInputSchema.safeParse({ url: "https://hooks.example.com/x", events })
          .success
      ).toBe(false);
    expect(UpdateRepositoryWebhookInputSchema.safeParse({}).success).toBe(false);
    expect(UpdateRepositoryWebhookInputSchema.safeParse({ secret: "short" }).success).toBe(false);
  });

  it("requires the admin scope for webhooks and read scope for notifications", () => {
    expect(requiredAccessTokenScope("forge", "GET", ["repositories", "r1", "webhooks"])).toBe(
      "admin"
    );
    expect(
      requiredAccessTokenScope("forge", "POST", ["repositories", "r1", "webhooks", "h", "ping"])
    ).toBe("admin");
    expect(requiredAccessTokenScope("forge", "GET", ["notifications"])).toBe("repo:read");
    expect(requiredAccessTokenScope("forge", "POST", ["notifications", "read"])).toBe("repo:read");
    expect(accessTokenAllows({ scopes: ["repo:write"] }, "admin")).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import SigningKeySettings from "../../apps/web/src/components/SigningKeySettings.vue";
import GitSignatureStatus from "../../apps/web/src/components/GitSignatureStatus.vue";
import { api } from "../../apps/web/src/lib/api";
import { i18n } from "../../apps/web/src/i18n";
import { fluentUi } from "../../apps/web/src/ui/fluent";
import { fill, findButton, settle, submit } from "./task-support";

function mount(component: typeof SigningKeySettings, props: Record<string, string> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(component, props);
  app.use(i18n);
  app.use(fluentUi);
  app.mount(root);
  return {
    root,
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  i18n.global.locale.value = "zh-CN";
});

describe("SSH signing keys", () => {
  it("lists the key format and guides SSH proofs with ssh-keygen", async () => {
    i18n.global.locale.value = "en";
    vi.spyOn(api, "signingKeys").mockResolvedValue([
      {
        id: "key-1",
        title: "Laptop",
        format: "ssh",
        fingerprint: "SHA256:9y8ZQ7fZSwHfxmOysYAaWEOOTGn1maYhYLhOKgddc8o",
        keyIds: [],
        publicKey: "ssh-ed25519 AAAA",
        createdAt: 1,
        revokedAt: null,
      },
    ]);
    const challenge = vi.spyOn(api, "createSigningChallenge").mockResolvedValue({
      id: "challenge-1",
      format: "ssh",
      fingerprint: "SHA256:new",
      payload: "GitEdge signing key ownership\n",
      expiresAt: Date.now() + 600_000,
    });
    const mounted = mount(SigningKeySettings);
    await settle();
    expect(mounted.root.textContent).toContain("SSH");
    expect(mounted.root.textContent).toContain(
      "SHA256:9y8ZQ7fZSwHfxmOysYAaWEOOTGn1maYhYLhOKgddc8o"
    );
    findButton(mounted.root, "Add signing key").click();
    await settle();
    const form = mounted.root.querySelector<HTMLFormElement>("form");
    if (!form) throw new Error("Signing key form did not render.");
    fill(form.querySelector("input")!, "Laptop");
    fill(
      form.querySelector("textarea")!,
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIgIMgpGn2j4 laptop"
    );
    submit(form);
    await settle();
    expect(challenge).toHaveBeenCalledOnce();
    const text = mounted.root.textContent ?? "";
    expect(text).toContain("ssh-keygen -Y sign -n gitedge");
    expect(text).toContain("git config --global gpg.format ssh");
    expect(text).not.toContain("gpg --armor");
    mounted.unmount();
  });

  it("labels verified SSH commits with the format and fingerprint", async () => {
    i18n.global.locale.value = "en";
    const request = vi.spyOn(api, "commitSignature").mockResolvedValue({
      status: "valid",
      format: "ssh",
      fingerprint: "SHA256:fixture",
      signer: { id: "user-1", identifier: "signer" },
      verifiedAt: 1,
    });
    const mounted = mount(GitSignatureStatus, {
      repositoryId: "repo-1",
      refName: "main",
      oid: "a".repeat(40),
    });
    findButton(mounted.root, "Verify commit signature").click();
    await settle();
    expect(request).toHaveBeenCalledWith("repo-1", "main", "a".repeat(40));
    expect(mounted.root.textContent).toContain("Verified (SSH)");
    expect(mounted.root.textContent).toContain("SHA256:fixture");
    expect(mounted.root.textContent).toContain("signer");
    mounted.unmount();
  });

  it("explains impersonated committer emails", async () => {
    i18n.global.locale.value = "en";
    vi.spyOn(api, "commitSignature").mockResolvedValue({
      status: "email_mismatch",
      format: "ssh",
      fingerprint: "SHA256:fixture",
      signer: { id: "user-1", identifier: "signer" },
      verifiedAt: 1,
    });
    const mounted = mount(GitSignatureStatus, {
      repositoryId: "repo-1",
      refName: "main",
      oid: "b".repeat(40),
    });
    findButton(mounted.root, "Verify commit signature").click();
    await settle();
    expect(mounted.root.querySelector(".badge-danger")?.textContent).toContain(
      "Committer email is verified by another account"
    );
    mounted.unmount();
  });
});

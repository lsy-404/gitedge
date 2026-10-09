import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountSecuritySettings from "../../apps/web/src/components/AccountSecuritySettings.vue";
import AuthView from "../../apps/web/src/pages/AuthView.vue";
import ForgotPasswordView from "../../apps/web/src/pages/ForgotPasswordView.vue";
import ResetPasswordView from "../../apps/web/src/pages/ResetPasswordView.vue";
import { api, ApiError } from "../../apps/web/src/lib/api";
import { i18n } from "../../apps/web/src/i18n";
import { clearSession, sessionState } from "../../apps/web/src/lib/session";
import type { SecuritySummary } from "../../packages/contracts/src/security";
import {
  control,
  fill,
  findButton,
  h,
  isDisabled,
  mountAt,
  settle,
  submit,
  unmountAll,
} from "./task-support";

function summary(overrides: Partial<SecuritySummary> = {}): SecuritySummary {
  return {
    passwordEnabled: true,
    email: null,
    emailAvailable: true,
    totp: { enabled: false, available: true },
    passkeys: [],
    recoveryCodesRemaining: 0,
    secondFactorEnabled: false,
    recentAuth: { valid: true, expiresAt: Date.now() + 60_000, methods: ["password"] },
    ...overrides,
  };
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  vi.spyOn(api, "ssoProviders").mockResolvedValue([]);
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  clearSession();
});

describe("sign-in second factor", () => {
  it("asks for the authenticator code after the password and completes sign-in", async () => {
    vi.spyOn(api, "login").mockResolvedValue({
      secondFactorRequired: true,
      mfaToken: "m".repeat(43),
      methods: ["totp", "recovery"],
    });
    const complete = vi
      .spyOn(api, "completeLogin")
      .mockResolvedValue({ id: "user-1", identifier: "ada" });
    const mounted = await mountAt("/_verify/auth/login", "/_verify/auth/login", () => h(AuthView));
    const inputs = mounted.root.querySelectorAll("input");
    fill(inputs[0], "ada");
    fill(inputs[1], "correct horse battery");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(mounted.root.textContent).toContain("Two-step verification");
    expect(mounted.root.querySelector("input[autocomplete='one-time-code']")).not.toBeNull();
    fill(control(mounted.root, "input[autocomplete='one-time-code']"), "123456");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(complete).toHaveBeenCalledWith("m".repeat(43), { method: "totp", code: "123456" });
    expect(sessionState.user?.identifier).toBe("ada");
  });

  it("offers the other available methods and reports a rejected code", async () => {
    vi.spyOn(api, "login").mockResolvedValue({
      secondFactorRequired: true,
      mfaToken: "m".repeat(43),
      methods: ["totp", "recovery"],
    });
    vi.spyOn(api, "completeLogin").mockRejectedValue(new ApiError(401, "no", "unauthorized"));
    const mounted = await mountAt("/_verify/auth/login-2", "/_verify/auth/login-2", () =>
      h(AuthView)
    );
    const inputs = mounted.root.querySelectorAll("input");
    fill(inputs[0], "ada");
    fill(inputs[1], "correct horse battery");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    Array.from(mounted.root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Recovery code"))
      ?.click();
    await settle();
    fill(control(mounted.root, "input[autocomplete='one-time-code']"), "abcde-fghij");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(mounted.root.textContent).toContain("Verification failed");
    expect(sessionState.user?.identifier).not.toBe("ada");
  });
});

describe("password recovery pages", () => {
  it("hides email reset unless the server can send mail", async () => {
    vi.spyOn(api, "recoveryOptions").mockResolvedValue({ emailReset: false });
    const hidden = await mountAt("/_verify/forgot-a", "/_verify/forgot-a", () =>
      h(ForgotPasswordView)
    );
    expect(hidden.root.textContent).toContain("Use a recovery code");
    expect(hidden.root.textContent).not.toContain("Reset by email");
    hidden.unmount();
    vi.spyOn(api, "recoveryOptions").mockResolvedValue({ emailReset: true });
    const shown = await mountAt("/_verify/forgot-b", "/_verify/forgot-b", () =>
      h(ForgotPasswordView)
    );
    expect(shown.root.textContent).toContain("Reset by email");
  });

  it("resets with a recovery code and confirms generically for email requests", async () => {
    vi.spyOn(api, "recoveryOptions").mockResolvedValue({ emailReset: true });
    const reset = vi.spyOn(api, "resetPasswordWithRecoveryCode").mockResolvedValue({ reset: true });
    const send = vi.spyOn(api, "requestPasswordResetEmail").mockResolvedValue({ sent: true });
    const mounted = await mountAt("/_verify/forgot-c", "/_verify/forgot-c", () =>
      h(ForgotPasswordView)
    );
    const forms = mounted.root.querySelectorAll("form");
    const recoveryInputs = forms[1 - 1].querySelectorAll("input");
    fill(recoveryInputs[0], "ada");
    fill(recoveryInputs[1], "abcde-fghij");
    fill(recoveryInputs[2], "a-brand-new-password");
    await settle();
    submit(forms[0]);
    await settle();
    expect(reset).toHaveBeenCalledWith({
      identifier: "ada",
      recoveryCode: "abcde-fghij",
      newPassword: "a-brand-new-password",
    });
    expect(mounted.root.textContent).toContain("Your password was reset");
    fill(mounted.root.querySelectorAll("form")[0].querySelector("input")!, "ada@example.test");
    await settle();
    submit(mounted.root.querySelectorAll("form")[0]);
    await settle();
    expect(send).toHaveBeenCalledWith("ada@example.test");
    expect(mounted.root.textContent).toContain("If that address belongs to a verified account");
  });

  it("asks for a second factor when the reset link belongs to a protected account", async () => {
    const confirm = vi
      .spyOn(api, "confirmPasswordResetEmail")
      .mockRejectedValueOnce(new ApiError(401, "needs", "second_factor_required"))
      .mockResolvedValueOnce({ reset: true });
    const mounted = await mountAt("/_verify/reset", "/_verify/reset?token=t".padEnd(40, "t"), () =>
      h(ResetPasswordView)
    );
    fill(control(mounted.root, "input[type='password']"), "a-brand-new-password");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(mounted.root.textContent).toContain("two-step verification");
    fill(control(mounted.root, "input[autocomplete='one-time-code']"), "123456");
    await settle();
    submit(control(mounted.root, "form"));
    await settle();
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ factor: { method: "totp", code: "123456" } })
    );
    expect(mounted.root.textContent).toContain("Your password was reset");
  });
});

describe("account security settings", () => {
  it("locks sensitive actions until identity is confirmed again", async () => {
    const locked = summary({
      recentAuth: { valid: false, expiresAt: null, methods: ["password"] },
    });
    vi.spyOn(api, "security").mockResolvedValueOnce(locked).mockResolvedValue(summary());
    const reauth = vi
      .spyOn(api, "reauthenticate")
      .mockResolvedValue({ recentAuthAt: Date.now(), expiresAt: Date.now() + 600_000 });
    const mounted = await mountAt("/_verify/security-a", "/_verify/security-a", () =>
      h(AccountSecuritySettings)
    );
    expect(mounted.root.textContent).toContain("Confirm it is you");
    expect(isDisabled(findButton(mounted.root, "Change password"))).toBe(true);
    const form = mounted.root
      .querySelector("#reauth-title")!
      .closest("section")!
      .querySelector("form")!;
    fill(form.querySelector("input")!, "my current password");
    await settle();
    submit(form);
    await settle();
    expect(reauth).toHaveBeenCalledWith({ method: "password", password: "my current password" });
    expect(mounted.root.textContent).not.toContain("Confirm it is you");
    expect(isDisabled(findButton(mounted.root, "Change password"))).toBe(false);
  });

  it("enrolls an authenticator app with a QR code and shows recovery codes once", async () => {
    vi.spyOn(api, "security")
      .mockResolvedValueOnce(summary())
      .mockResolvedValue(
        summary({ totp: { enabled: true, available: true }, recoveryCodesRemaining: 10 })
      );
    vi.spyOn(api, "enrollTotp").mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/GitEdge:ada?secret=JBSWY3DPEHPK3PXP&issuer=GitEdge",
    });
    const confirm = vi.spyOn(api, "confirmTotp").mockResolvedValue({
      enabled: true,
      recoveryCodes: ["aaaaa-bbbbb", "ccccc-ddddd"],
    });
    const mounted = await mountAt("/_verify/security-b", "/_verify/security-b", () =>
      h(AccountSecuritySettings)
    );
    findButton(mounted.root, "Set up authenticator app").click();
    await settle();
    expect(mounted.root.querySelector(".security-qr svg")).not.toBeNull();
    expect(mounted.root.textContent).toContain("JBSWY3DPEHPK3PXP");
    const form = mounted.root.querySelector(".security-qr")!.closest("form")!;
    fill(form.querySelector("input")!, "654321");
    await settle();
    submit(form);
    await settle();
    expect(confirm).toHaveBeenCalledWith("654321");
    expect(mounted.root.textContent).toContain("aaaaa-bbbbb");
    expect(mounted.root.textContent).toContain("Save these codes now");
    findButton(mounted.root, "I saved them").click();
    await settle();
    expect(mounted.root.textContent).not.toContain("aaaaa-bbbbb");
  });

  it("explains missing email delivery instead of offering email features", async () => {
    vi.spyOn(api, "security").mockResolvedValue(
      summary({ emailAvailable: false, totp: { enabled: false, available: false } })
    );
    const mounted = await mountAt("/_verify/security-c", "/_verify/security-c", () =>
      h(AccountSecuritySettings)
    );
    expect(mounted.root.textContent).toContain("Email delivery is not configured");
    expect(mounted.root.textContent).toContain("No encryption key is configured");
    expect(mounted.root.textContent).not.toContain("Send verification email");
  });
});

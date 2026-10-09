import { env } from "cloudflare:workers";
import { Secret, TOTP } from "otpauth";
import { beforeAll, describe, expect, it } from "vitest";
import auth from "../../workers/auth/src/index";
import { verifyTotpCode } from "../../workers/auth/src/security/totp";
import { RECENT_AUTH_WINDOW_MS } from "../../packages/contracts/src/index";
import { bytesToBase64 } from "../../src/worker/common/encoding";
import { FixtureArtifacts } from "../support/artifacts";
import { countingRateLimiter, unlimitedRateLimiter } from "../support/rate-limiter";
import { runSqlScript } from "../support/database";
import { SoftwareAuthenticator } from "../support/webauthn";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const origin = "https://account.test";
const password = "a-valid-account-test-password";
const sent: { to: string; text: string }[] = [];
const authEnv: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  RATE_LIMITER: unlimitedRateLimiter,
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
  TOTP_ENCRYPTION_KEY: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
  EMAIL_FROM: "noreply@account.test",
  EMAIL: {
    send: async (message) => {
      const to = typeof message.to === "string" ? message.to : "";
      sent.push({ to, text: "text" in message ? (message.text ?? "") : "" });
      return { messageId: "test" };
    },
  } as SendEmail,
};

interface Account {
  id: string;
  identifier: string;
  cookie: string;
}

function sessionCookie(response: Response): string {
  const token = response.headers.get("Set-Cookie")?.match(/gitedge_session=([^;]+)/)?.[1];
  if (!token) throw new Error("Expected an authenticated session cookie.");
  return `gitedge_session=${token}`;
}

function call(
  path: string,
  method = "GET",
  cookie = "",
  body?: unknown,
  overrides: Partial<typeof authEnv> = {}
): Promise<Response> {
  return auth.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...authEnv, ...overrides }
  );
}

async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

let counter = 0;
async function register(): Promise<Account> {
  counter += 1;
  const identifier = `secure-${counter}`;
  const response = await call("/register", "POST", "", { identifier, password });
  expect(response.status).toBe(201);
  return {
    id: (await data<{ id: string }>(response)).id,
    identifier,
    cookie: sessionCookie(response),
  };
}

async function signIn(account: Account): Promise<Response> {
  return call("/login", "POST", "", { identifier: account.identifier, password });
}

function totpFor(secret: string, offsetSteps = 0): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offsetSteps * 30_000,
  });
}

async function enableTotp(account: Account) {
  const enrollment = await data<{ secret: string; otpauthUri: string }>(
    await call("/security/totp", "POST", account.cookie)
  );
  const confirmed = await call("/security/totp/confirm", "POST", account.cookie, {
    code: totpFor(enrollment.secret),
  });
  expect(confirmed.status).toBe(200);
  const result = await data<{ recoveryCodes?: string[] }>(confirmed);
  return { secret: enrollment.secret, recoveryCodes: result.recoveryCodes ?? [] };
}

/** Lets the next TOTP step through replay protection. */
async function resetTotpCounter(account: Account): Promise<void> {
  await env.DB.prepare("UPDATE auth_totp SET last_counter = 0 WHERE user_id = ?")
    .bind(account.id)
    .run();
}

async function expireSudo(account: Account): Promise<void> {
  await env.DB.prepare("UPDATE auth_sessions SET recent_auth_at = ? WHERE user_id = ?")
    .bind(Date.now() - RECENT_AUTH_WINDOW_MS - 1000, account.id)
    .run();
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
});

describe("recovery codes", () => {
  it("issues ten hashed single-use codes and replaces them on regeneration", async () => {
    const account = await register();
    const first = (await enableTotp(account)).recoveryCodes;
    expect(first).toHaveLength(10);
    const stored = await env.DB.prepare(
      "SELECT code_hash FROM auth_recovery_codes WHERE user_id = ?"
    )
      .bind(account.id)
      .all<{ code_hash: string }>();
    expect(stored.results).toHaveLength(10);
    for (const code of first)
      expect(stored.results.some((row) => row.code_hash.includes(code))).toBe(false);

    const second = (
      await data<{ recoveryCodes: string[] }>(
        await call("/security/recovery-codes", "POST", account.cookie)
      )
    ).recoveryCodes;
    expect(second).toHaveLength(10);
    expect(second.some((code) => first.includes(code))).toBe(false);

    const oldReset = await call("/recovery/password", "POST", "", {
      identifier: account.identifier,
      recoveryCode: first[0],
      newPassword: "another-valid-password-1",
    });
    expect(oldReset.status).toBe(401);
  });

  it("resets the password once per code and signs every session out", async () => {
    const account = await register();
    const { recoveryCodes } = await enableTotp(account);
    const reset = await call("/recovery/password", "POST", "", {
      identifier: account.identifier.toUpperCase(),
      recoveryCode: recoveryCodes[0],
      newPassword: "brand-new-password-1",
    });
    expect(reset.status).toBe(200);
    expect((await call("/session", "GET", account.cookie)).status).toBe(401);
    const replay = await call("/recovery/password", "POST", "", {
      identifier: account.identifier,
      recoveryCode: recoveryCodes[0],
      newPassword: "replayed-password-123",
    });
    expect(replay.status).toBe(401);
    const login = await call("/login", "POST", "", {
      identifier: account.identifier,
      password: "brand-new-password-1",
    });
    expect(login.status).toBe(200);
    expect(await data(login)).toMatchObject({ secondFactorRequired: true });
  });

  it("answers unknown accounts and wrong codes identically", async () => {
    const account = await register();
    await enableTotp(account);
    const body = (identifier: string) => ({
      identifier,
      recoveryCode: "aaaaa-bbbbb",
      newPassword: "brand-new-password-1",
    });
    const known = await call("/recovery/password", "POST", "", body(account.identifier));
    const unknown = await call("/recovery/password", "POST", "", body("no-such-account"));
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("rate limits recovery attempts per account", async () => {
    const limited = { RATE_LIMITER: countingRateLimiter() };
    const attempt = () =>
      call(
        "/recovery/password",
        "POST",
        "",
        {
          identifier: "rate-target",
          recoveryCode: "aaaaa-bbbbb",
          newPassword: "brand-new-password-1",
        },
        limited
      );
    const statuses: number[] = [];
    for (let index = 0; index < 7; index += 1) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[6]).toBe(429);
  });
});

describe("authenticator app", () => {
  it("accepts codes inside the window and rejects replays and stale codes", async () => {
    const account = await register();
    const enrollment = await data<{ secret: string }>(
      await call("/security/totp", "POST", account.cookie)
    );
    const totp = new TOTP({ secret: Secret.fromBase32(enrollment.secret), digits: 6, period: 30 });
    const base = Math.floor(Date.now() / 30_000) * 30_000;
    const codeAt = (offset: number) => totp.generate({ timestamp: base + offset * 30_000 });

    expect(await verifyTotpCode(authEnv, account.id, codeAt(0), { now: base })).toBe(false);
    expect(
      await verifyTotpCode(authEnv, account.id, codeAt(0), { activate: true, now: base })
    ).toBe(true);
    expect(await verifyTotpCode(authEnv, account.id, codeAt(0), { now: base })).toBe(false);
    expect(await verifyTotpCode(authEnv, account.id, codeAt(1), { now: base })).toBe(true);
    expect(await verifyTotpCode(authEnv, account.id, codeAt(1), { now: base })).toBe(false);
    expect(await verifyTotpCode(authEnv, account.id, codeAt(0), { now: base })).toBe(false);
    expect(await verifyTotpCode(authEnv, account.id, codeAt(4), { now: base })).toBe(false);
    expect(await verifyTotpCode(authEnv, account.id, "000000", { now: base + 3 * 30_000 })).toBe(
      false
    );
    expect(await verifyTotpCode(authEnv, account.id, codeAt(3), { now: base + 4 * 30_000 })).toBe(
      true
    );
  });

  it("builds an otpauth URI and keeps the secret encrypted at rest", async () => {
    const account = await register();
    const enrollment = await data<{ secret: string; otpauthUri: string }>(
      await call("/security/totp", "POST", account.cookie)
    );
    expect(enrollment.otpauthUri).toContain("otpauth://totp/");
    expect(enrollment.otpauthUri).toContain(`secret=${enrollment.secret}`);
    const row = await env.DB.prepare("SELECT secret_ciphertext FROM auth_totp WHERE user_id = ?")
      .bind(account.id)
      .first<{ secret_ciphertext: string }>();
    expect(row?.secret_ciphertext).not.toContain(enrollment.secret);
    const wrong = await call("/security/totp/confirm", "POST", account.cookie, { code: "000000" });
    expect(wrong.status).toBe(400);
  });

  it("requires the second factor at sign-in and spends the sign-in token", async () => {
    const account = await register();
    const { secret, recoveryCodes } = await enableTotp(account);
    const first = await signIn(account);
    expect(first.status).toBe(200);
    expect(first.headers.get("Set-Cookie")).toBeNull();
    const challenge = await data<{ mfaToken: string; methods: string[] }>(first);
    expect(challenge.methods).toEqual(["totp", "recovery"]);

    const wrong = await call("/login/second-factor", "POST", "", {
      mfaToken: challenge.mfaToken,
      factor: { method: "totp", code: "000000" },
    });
    expect(wrong.status).toBe(401);
    const accepted = await call("/login/second-factor", "POST", "", {
      mfaToken: challenge.mfaToken,
      factor: { method: "totp", code: totpFor(secret, 1) },
    });
    expect(accepted.status).toBe(200);
    expect((await call("/session", "GET", sessionCookie(accepted))).status).toBe(200);
    const reused = await call("/login/second-factor", "POST", "", {
      mfaToken: challenge.mfaToken,
      factor: { method: "recovery", code: recoveryCodes[0] },
    });
    expect(reused.status).toBe(401);
  });

  it("accepts a recovery code once as the second factor", async () => {
    const account = await register();
    const { recoveryCodes } = await enableTotp(account);
    const attempt = async (code: string) => {
      const challenge = await data<{ mfaToken: string }>(await signIn(account));
      return call("/login/second-factor", "POST", "", {
        mfaToken: challenge.mfaToken,
        factor: { method: "recovery", code },
      });
    };
    expect((await attempt(recoveryCodes[2])).status).toBe(200);
    expect((await attempt(recoveryCodes[2])).status).toBe(401);
  });

  it("locks a pending sign-in after repeated wrong codes", async () => {
    const account = await register();
    const { secret } = await enableTotp(account);
    const challenge = await data<{ mfaToken: string }>(await signIn(account));
    for (let index = 0; index < 5; index += 1) {
      const wrong = await call("/login/second-factor", "POST", "", {
        mfaToken: challenge.mfaToken,
        factor: { method: "totp", code: "000000" },
      });
      expect(wrong.status).toBe(401);
    }
    const late = await call("/login/second-factor", "POST", "", {
      mfaToken: challenge.mfaToken,
      factor: { method: "totp", code: totpFor(secret, 1) },
    });
    expect(late.status).toBe(401);
  });

  it("disables only with the password and a current code", async () => {
    const account = await register();
    const { secret } = await enableTotp(account);
    await resetTotpCounter(account);
    const noPassword = await call("/security/totp/disable", "POST", account.cookie, {
      code: totpFor(secret),
    });
    expect(noPassword.status).toBe(401);
    const disabled = await call("/security/totp/disable", "POST", account.cookie, {
      password,
      code: totpFor(secret),
    });
    expect(disabled.status).toBe(200);
    const login = await signIn(account);
    expect(await data(login)).toMatchObject({ identifier: account.identifier });
  });
});

describe("re-authentication window", () => {
  it("guards sensitive actions until the identity is confirmed again", async () => {
    const account = await register();
    expect((await call("/security/recovery-codes", "POST", account.cookie)).status).toBe(200);
    await expireSudo(account);
    const blocked = await call("/security/recovery-codes", "POST", account.cookie);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { code: "reauth_required" } });
    const status = await data<{ recentAuth: { valid: boolean } }>(
      await call("/security", "GET", account.cookie)
    );
    expect(status.recentAuth.valid).toBe(false);

    const wrong = await call("/reauth", "POST", account.cookie, {
      method: "password",
      password: "nope-nope-nope-1",
    });
    expect(wrong.status).toBe(401);
    expect((await call("/security/recovery-codes", "POST", account.cookie)).status).toBe(403);

    const confirmed = await call("/reauth", "POST", account.cookie, {
      method: "password",
      password,
    });
    expect(confirmed.status).toBe(200);
    expect((await call("/security/recovery-codes", "POST", account.cookie)).status).toBe(200);
    const after = await data<{ recentAuth: { valid: boolean; expiresAt: number } }>(
      await call("/security", "GET", account.cookie)
    );
    expect(after.recentAuth.valid).toBe(true);
    expect(after.recentAuth.expiresAt).toBeGreaterThan(Date.now());
  });

  it("confirms with an authenticator code and exposes the claim on the session", async () => {
    const account = await register();
    const { secret } = await enableTotp(account);
    await expireSudo(account);
    expect(
      (await data<{ recentAuthAt?: number }>(await call("/session", "GET", account.cookie)))
        .recentAuthAt
    ).toBeLessThan(Date.now() - RECENT_AUTH_WINDOW_MS);
    await resetTotpCounter(account);
    const confirmed = await call("/reauth", "POST", account.cookie, {
      method: "totp",
      code: totpFor(secret),
    });
    expect(confirmed.status).toBe(200);
    const session = await data<{ recentAuthAt: number }>(
      await call("/session", "GET", account.cookie)
    );
    expect(Date.now() - session.recentAuthAt).toBeLessThan(RECENT_AUTH_WINDOW_MS);
  });

  it("changes the password and keeps only the current session", async () => {
    const account = await register();
    const other = sessionCookie(await signIn(account));
    expect((await call("/session", "GET", other)).status).toBe(200);
    await expireSudo(account);
    expect(
      (
        await call("/security/password", "POST", account.cookie, {
          newPassword: "changed-password-123",
        })
      ).status
    ).toBe(403);
    await call("/reauth", "POST", account.cookie, { method: "password", password });
    const changed = await call("/security/password", "POST", account.cookie, {
      newPassword: "changed-password-123",
    });
    expect(changed.status).toBe(200);
    expect((await call("/session", "GET", account.cookie)).status).toBe(200);
    expect((await call("/session", "GET", other)).status).toBe(401);
  });
});

describe("email verification and reset", () => {
  async function verifiedEmail(account: Account, address: string): Promise<void> {
    sent.length = 0;
    const requested = await call("/security/email", "PUT", account.cookie, { email: address });
    expect(requested.status).toBe(202);
    const token = sent.at(-1)?.text.match(/token=([\w-]+)/)?.[1];
    expect(token).toBeTruthy();
    const verified = await call("/email/verify", "POST", "", { token });
    expect(verified.status).toBe(200);
    const replay = await call("/email/verify", "POST", "", { token });
    expect(replay.status).toBe(400);
  }

  it("verifies an address with a single-use link", async () => {
    const account = await register();
    await verifiedEmail(account, "Person@Example.test");
    const summary = await data<{ email: { address: string; verified: boolean } }>(
      await call("/security", "GET", account.cookie)
    );
    expect(summary.email).toEqual({ address: "person@example.test", verified: true });
  });

  it("emails a reset link that works once and revokes sessions", async () => {
    const account = await register();
    await verifiedEmail(account, "reset-me@example.test");
    sent.length = 0;
    const requested = await call("/recovery/email", "POST", "", { email: "RESET-ME@example.test" });
    expect(requested.status).toBe(202);
    expect(sent).toHaveLength(1);
    const token = sent[0].text.match(/token=([\w-]+)/)?.[1];
    expect(sent[0].text).toContain("/reset-password?token=");
    const reset = await call("/recovery/email/confirm", "POST", "", {
      token,
      newPassword: "reset-by-email-123",
    });
    expect(reset.status).toBe(200);
    expect((await call("/session", "GET", account.cookie)).status).toBe(401);
    const replay = await call("/recovery/email/confirm", "POST", "", {
      token,
      newPassword: "reset-twice-password-1",
    });
    expect(replay.status).toBe(400);
    const login = await call("/login", "POST", "", {
      identifier: account.identifier,
      password: "reset-by-email-123",
    });
    expect(login.status).toBe(200);
  });

  it("rejects expired reset links", async () => {
    const account = await register();
    await verifiedEmail(account, "expired@example.test");
    sent.length = 0;
    await call("/recovery/email", "POST", "", { email: "expired@example.test" });
    const token = sent[0].text.match(/token=([\w-]+)/)?.[1];
    await env.DB.prepare("UPDATE auth_one_time_tokens SET expires_at = ? WHERE user_id = ?")
      .bind(Date.now() - 1, account.id)
      .run();
    const reset = await call("/recovery/email/confirm", "POST", "", {
      token,
      newPassword: "reset-by-email-123",
    });
    expect(reset.status).toBe(400);
  });

  it("does not reveal whether an address belongs to an account", async () => {
    const account = await register();
    await verifiedEmail(account, "known@example.test");
    sent.length = 0;
    const known = await call("/recovery/email", "POST", "", { email: "known@example.test" });
    const unknown = await call("/recovery/email", "POST", "", { email: "unknown@example.test" });
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    expect(sent.map((message) => message.to)).toEqual(["known@example.test"]);
  });

  it("does not disclose an address verified by another account", async () => {
    const owner = await register();
    await verifiedEmail(owner, "shared@example.test");
    const other = await register();
    sent.length = 0;
    const requested = await call("/security/email", "PUT", other.cookie, {
      email: "shared@example.test",
    });
    expect(requested.status).toBe(202);
    expect(sent).toHaveLength(0);
  });

  it("asks for a second factor before an email reset when two-factor sign-in is on", async () => {
    const account = await register();
    await verifiedEmail(account, "twofactor@example.test");
    const { recoveryCodes } = await enableTotp(account);
    sent.length = 0;
    await call("/recovery/email", "POST", "", { email: "twofactor@example.test" });
    const token = sent[0].text.match(/token=([\w-]+)/)?.[1];
    const missing = await call("/recovery/email/confirm", "POST", "", {
      token,
      newPassword: "reset-by-email-123",
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: "second_factor_required" } });
    const wrong = await call("/recovery/email/confirm", "POST", "", {
      token,
      newPassword: "reset-by-email-123",
      factor: { method: "totp", code: "000000" },
    });
    expect(wrong.status).toBe(401);
    const ok = await call("/recovery/email/confirm", "POST", "", {
      token,
      newPassword: "reset-by-email-123",
      factor: { method: "recovery", code: recoveryCodes[0] },
    });
    expect(ok.status).toBe(200);
  });

  it("hides email reset when delivery is not configured", async () => {
    const options = await call("/recovery/options", "GET", "", undefined, { EMAIL: undefined });
    expect(await data(options)).toEqual({ emailReset: false });
    const request = await call(
      "/recovery/email",
      "POST",
      "",
      { email: "a@example.test" },
      { EMAIL: undefined }
    );
    expect(request.status).toBe(503);
    expect(await data(await call("/recovery/options"))).toEqual({ emailReset: true });
  });
});

describe("passkeys", () => {
  async function registerPasskey(
    account: Account,
    authenticator: SoftwareAuthenticator,
    name = "Laptop"
  ) {
    const prepared = await data<{ options: { challenge: string } }>(
      await call("/security/passkeys/options", "POST", account.cookie)
    );
    return call("/security/passkeys", "POST", account.cookie, {
      name,
      response: await authenticator.register(prepared.options.challenge),
    });
  }

  it("registers, renames and removes a passkey", async () => {
    const account = await register();
    const authenticator = await SoftwareAuthenticator.create(origin);
    const created = await registerPasskey(account, authenticator);
    expect(created.status).toBe(201);
    expect((await data<{ recoveryCodes?: string[] }>(created)).recoveryCodes).toHaveLength(10);
    const listed = await data<{ passkeys: { id: string; name: string }[] }>(
      await call("/security", "GET", account.cookie)
    );
    expect(listed.passkeys).toMatchObject([{ id: authenticator.id, name: "Laptop" }]);
    expect(
      (
        await call(`/security/passkeys/${authenticator.id}`, "PATCH", account.cookie, {
          name: "Work laptop",
        })
      ).status
    ).toBe(200);
    expect(
      (await call(`/security/passkeys/${authenticator.id}`, "DELETE", account.cookie)).status
    ).toBe(200);
    expect(
      (await call(`/security/passkeys/${authenticator.id}`, "DELETE", account.cookie)).status
    ).toBe(404);
  });

  it("signs in without a password and rejects a replayed assertion", async () => {
    const account = await register();
    const authenticator = await SoftwareAuthenticator.create(origin);
    await registerPasskey(account, authenticator);
    const prepared = await data<{ challengeId: string; options: { challenge: string } }>(
      await call("/login/passkey/options", "POST")
    );
    const assertion = await authenticator.assert(prepared.options.challenge);
    const login = await call("/login/passkey", "POST", "", {
      challengeId: prepared.challengeId,
      response: assertion,
    });
    expect(login.status).toBe(200);
    expect((await call("/session", "GET", sessionCookie(login))).status).toBe(200);
    const replay = await call("/login/passkey", "POST", "", {
      challengeId: prepared.challengeId,
      response: assertion,
    });
    expect(replay.status).toBe(401);
  });

  it("works as the second factor after a password", async () => {
    const account = await register();
    const authenticator = await SoftwareAuthenticator.create(origin);
    await registerPasskey(account, authenticator);
    const challenge = await data<{ mfaToken: string; methods: string[] }>(await signIn(account));
    expect(challenge.methods).toEqual(["passkey", "recovery"]);
    const prepared = await data<{ options: { challenge: string } }>(
      await call("/login/second-factor/options", "POST", "", { mfaToken: challenge.mfaToken })
    );
    const done = await call("/login/second-factor", "POST", "", {
      mfaToken: challenge.mfaToken,
      factor: {
        method: "passkey",
        response: await authenticator.assert(prepared.options.challenge, { userVerified: false }),
      },
    });
    expect(done.status).toBe(200);
  });

  it("confirms identity for sensitive actions with a passkey", async () => {
    const account = await register();
    const authenticator = await SoftwareAuthenticator.create(origin);
    await registerPasskey(account, authenticator);
    await expireSudo(account);
    const prepared = await data<{ options: { challenge: string } }>(
      await call("/reauth/passkey/options", "POST", account.cookie)
    );
    const confirmed = await call("/reauth", "POST", account.cookie, {
      method: "passkey",
      response: await authenticator.assert(prepared.options.challenge),
    });
    expect(confirmed.status).toBe(200);
    expect((await call("/security/recovery-codes", "POST", account.cookie)).status).toBe(200);
  });

  it("does not accept another account's passkey as a second factor", async () => {
    const owner = await register();
    const intruder = await register();
    await registerPasskey(owner, await SoftwareAuthenticator.create(origin));
    const foreign = await SoftwareAuthenticator.create(origin);
    await registerPasskey(intruder, foreign);
    const challenge = await data<{ mfaToken: string }>(await signIn(owner));
    const prepared = await data<{ options: { challenge: string } }>(
      await call("/login/second-factor/options", "POST", "", { mfaToken: challenge.mfaToken })
    );
    const rejected = await call("/login/second-factor", "POST", "", {
      mfaToken: challenge.mfaToken,
      factor: { method: "passkey", response: await foreign.assert(prepared.options.challenge) },
    });
    expect(rejected.status).toBe(401);
  });
});

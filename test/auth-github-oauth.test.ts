import { afterEach, describe, expect, it, vi } from "vitest";

import { completeGithubOAuth, login, session, startGithubOAuth } from "../workers/auth/src/index";

type OAuthState = {
  code_verifier: string;
  access_level: "identity" | "read";
  return_to: string;
  expires_at: number;
  browser_hash: string;
};

class TestDatabase implements D1Database {
  readonly states = new Map<string, OAuthState>();
  readonly sessions = new Map<string, string>();
  expiredStateCleanupCount = 0;
  sessionRow?: Record<string, unknown>;
  passwordUser?: Record<string, unknown>;
  externalIdentityValues?: readonly unknown[];
  prepare(query: string): D1PreparedStatement {
    return new TestStatement(query, this);
  }
  async batch(_statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
    return [];
  }
}

class TestStatement implements D1PreparedStatement {
  private values: readonly unknown[] = [];
  constructor(
    private readonly query: string,
    private readonly database: TestDatabase
  ) {}
  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    if (this.query.startsWith("INSERT INTO external_identities"))
      this.database.externalIdentityValues = values;
    return this;
  }
  async first<T = unknown>(): Promise<T | null> {
    if (this.query.startsWith("DELETE FROM github_oauth_states")) {
      const state = this.database.states.get(String(this.values[0]));
      if (
        !state ||
        state.expires_at <= Number(this.values[1]) ||
        state.browser_hash !== this.values[2]
      )
        return null;
      this.database.states.delete(String(this.values[0]));
      return {
        code_verifier: state.code_verifier,
        access_level: state.access_level,
        return_to: state.return_to,
      } as T;
    }
    if (this.query.startsWith("SELECT users.id, users.identifier, users.group_key, external"))
      return (this.database.sessionRow ?? null) as T | null;
    if (this.query.startsWith("SELECT id, identifier, group_key, password_salt"))
      return (this.database.passwordUser ?? null) as T | null;
    return null;
  }
  async all<T = unknown>(): Promise<D1Result<T>> {
    return { results: [], meta: { changes: 0 } };
  }
  async run(): Promise<D1Result> {
    if (this.query.startsWith("DELETE FROM github_oauth_states WHERE expires_at")) {
      this.database.expiredStateCleanupCount += 1;
    }
    if (this.query.startsWith("INSERT INTO github_oauth_states")) {
      const access = this.values[2] === "read" ? "read" : "identity";
      this.database.states.set(String(this.values[0]), {
        code_verifier: String(this.values[1]),
        access_level: access,
        return_to: String(this.values[3]),
        expires_at: Number(this.values[4]),
        browser_hash: String(this.values[6]),
      });
    }
    if (this.query.startsWith("INSERT INTO auth_sessions"))
      this.database.sessions.set(String(this.values[0]), String(this.values[1]));
    return { results: [], meta: { changes: 0 } };
  }
}

function testEnv(database: TestDatabase) {
  return {
    DB: database,
    ALLOW_PUBLIC_SIGNUP: "true",
    DEFAULT_USER_GROUP: "free",
    GITHUB_CLIENT_ID: "github-test-client",
    GITHUB_CLIENT_SECRET: "github-test-secret",
    GITHUB_OAUTH_BASE: "https://github.example",
    GITHUB_API_BASE: "https://api.github.example",
    LOG_LEVEL: "error",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHub OAuth", () => {
  it("starts identity OAuth with state and S256 PKCE but no requested scope", async () => {
    const database = new TestDatabase();
    const response = await startGithubOAuth(
      new Request("https://forge.example/github/start?access=identity&returnTo=%2Faccount"),
      testEnv(database)
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://github.example");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("scope")).toBeNull();
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toHaveLength(43);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://forge.example/api/auth/github/callback"
    );
    expect(database.expiredStateCleanupCount).toBe(1);
    expect(database.states.size).toBe(1);
  });

  it("rejects an external return target before persisting OAuth state", async () => {
    const database = new TestDatabase();
    const response = await startGithubOAuth(
      new Request(
        "https://forge.example/github/start?access=read&returnTo=https%3A%2F%2Fevil.example"
      ),
      testEnv(database)
    );
    expect(response.status).toBe(400);
    expect(database.states.size).toBe(0);
  });

  it("consumes state once, verifies the numeric user id, and establishes a session", async () => {
    const database = new TestDatabase();
    const environment = testEnv(database);
    const started = await startGithubOAuth(
      new Request("https://forge.example/github/start?access=identity&returnTo=%2Faccount"),
      environment
    );
    const state = new URL(started.headers.get("Location") ?? "").searchParams.get("state");
    expect(state).toBeTruthy();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.endsWith("/access_token"))
          return Response.json({
            access_token: "transient-token",
            token_type: "bearer",
            scope: "",
          });
        return Response.json(
          {
            id: 42,
            login: "mutable-login",
            avatar_url: "https://avatars.example/42",
            html_url: "https://github.example/mutable-login",
          },
          { headers: { "X-OAuth-Scopes": "" } }
        );
      })
    );
    const unbound = await completeGithubOAuth(
      new Request(
        `https://forge.example/api/auth/github/callback?state=${state}&code=provider-code`
      ),
      environment
    );
    expect(unbound.status).toBe(400);
    expect(database.states.size).toBe(1);
    const completed = await completeGithubOAuth(
      new Request(
        `https://forge.example/api/auth/github/callback?state=${state}&code=provider-code`,
        { headers: { Cookie: started.headers.get("Set-Cookie")?.split(";")[0] ?? "" } }
      ),
      environment
    );
    expect(completed.status).toBe(302);
    expect(completed.headers.get("Location")).toBe("/account");
    expect(completed.headers.get("Set-Cookie")).toContain("gitedge_session=");
    expect(database.states.size).toBe(0);
    expect(database.sessions.size).toBe(1);

    const replay = await completeGithubOAuth(
      new Request(
        `https://forge.example/api/auth/github/callback?state=${state}&code=provider-code`,
        { headers: { Cookie: started.headers.get("Set-Cookie")?.split(";")[0] ?? "" } }
      ),
      environment
    );
    expect(replay.status).toBe(400);
  });

  it("rejects a read grant that includes a broader scope", async () => {
    const database = new TestDatabase();
    const environment = testEnv(database);
    const started = await startGithubOAuth(
      new Request("https://forge.example/github/start?access=read&returnTo=%2Faccount"),
      environment
    );
    const state = new URL(started.headers.get("Location") ?? "").searchParams.get("state");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "transient-token",
          token_type: "bearer",
          scope: "read:user,user:email,read:org,repo",
        })
      )
    );
    const completed = await completeGithubOAuth(
      new Request(
        `https://forge.example/api/auth/github/callback?state=${state}&code=provider-code`,
        { headers: { Cookie: started.headers.get("Set-Cookie")?.split(";")[0] ?? "" } }
      ),
      environment
    );
    expect(completed.status).toBe(302);
    expect(completed.headers.get("Location")).toBe("/account?error=github_oauth_failed");
    expect(database.sessions.size).toBe(0);
  });

  it("stores the verified read snapshot without retaining the OAuth token", async () => {
    const database = new TestDatabase();
    const environment = testEnv(database);
    const started = await startGithubOAuth(
      new Request("https://forge.example/github/start?access=read&returnTo=%2Faccount"),
      environment
    );
    const state = new URL(started.headers.get("Location") ?? "").searchParams.get("state");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.endsWith("/access_token"))
          return Response.json({
            access_token: "transient-token",
            token_type: "bearer",
            scope: "read:user,user:email,read:org",
          });
        if (input.endsWith("/user/emails"))
          return Response.json([{ email: "verified@example.com", verified: true }], {
            headers: { "X-OAuth-Scopes": "read:user,user:email,read:org" },
          });
        if (input.endsWith("/user/orgs"))
          return Response.json(
            [{ id: 9, login: "octo-org", avatar_url: "https://avatars.example/org" }],
            { headers: { "X-OAuth-Scopes": "read:user,user:email,read:org" } }
          );
        return Response.json(
          {
            id: 42,
            login: "octocat",
            avatar_url: "https://avatars.example/octocat",
            html_url: "https://github.example/octocat",
          },
          { headers: { "X-OAuth-Scopes": "read:user,user:email,read:org" } }
        );
      })
    );
    await completeGithubOAuth(
      new Request(
        `https://forge.example/api/auth/github/callback?state=${state}&code=provider-code`,
        { headers: { Cookie: started.headers.get("Set-Cookie")?.split(";")[0] ?? "" } }
      ),
      environment
    );
    expect(database.externalIdentityValues).toContain("octocat");
    expect(database.externalIdentityValues).toContain(JSON.stringify(["verified@example.com"]));
    expect(database.externalIdentityValues).toContain(
      JSON.stringify([{ id: 9, login: "octo-org", avatarUrl: "https://avatars.example/org" }])
    );
    expect(database.externalIdentityValues).not.toContain("transient-token");
  });

  it("returns a defensive external identity summary from session data", async () => {
    const database = new TestDatabase();
    database.sessionRow = {
      id: "user-1",
      identifier: "github-safe",
      group_key: "free",
      provider: "github",
      provider_login: "octocat",
      avatar_url: "https://avatars.example/octocat",
      profile_url: "https://github.example/octocat",
      access_level: "read",
      emails_json: '["octocat@example.com"]',
      organizations_json: '[{"id":7,"login":"octo-org","avatarUrl":"https://avatars.example/org"}]',
    };
    const active = await session(testEnv(database), "session-token");
    expect(active).toMatchObject({
      ok: true,
      data: {
        externalIdentity: {
          provider: "github",
          login: "octocat",
          accessLevel: "read",
          emails: ["octocat@example.com"],
          organizations: [{ id: 7, login: "octo-org" }],
        },
      },
    });
  });

  it("rejects password login before deriving a disabled external credential", async () => {
    const database = new TestDatabase();
    database.passwordUser = {
      id: "user-1",
      identifier: "github-safe",
      group_key: "free",
      password_salt: "",
      password_hash: "",
      password_auth_enabled: 0,
    };
    const result = await login(testEnv(database), {
      identifier: "github-safe",
      password: "a-valid-password",
    });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});

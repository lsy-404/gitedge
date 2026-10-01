import { describe, expect, it } from "vitest";

import { register, session } from "../workers/auth/src/index";

type UserRecord = {
  id: string;
  identifier: string;
  group_key: string;
  password_salt: string;
  password_hash: string;
};

function createDatabase() {
  let user: UserRecord | undefined;
  let sessionTokenHash: string | undefined;
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (sql.startsWith("SELECT id FROM users"))
                return (user ? { id: user.id } : null) as T;
              if (sql.startsWith("SELECT id, identifier, group_key")) return user as T;
              if (sql.startsWith("SELECT users.id")) {
                return user && sessionTokenHash
                  ? ({ id: user.id, identifier: user.identifier, group_key: user.group_key } as T)
                  : null;
              }
              return null;
            },
            async run() {
              if (sql.startsWith("INSERT INTO users")) {
                user = {
                  id: String(values[0]),
                  identifier: String(values[1]),
                  group_key: String(values[2]),
                  password_salt: String(values[3]),
                  password_hash: String(values[4]),
                };
              }
              if (sql.startsWith("INSERT INTO auth_sessions")) sessionTokenHash = String(values[0]);
              return {};
            },
          };
        },
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

const baseEnv = () => ({
  DB: createDatabase() as unknown as D1Database,
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
});

describe("auth registration policy and user groups", () => {
  it("rejects registration before parsing or database access when disabled", async () => {
    const env = {
      ...baseEnv(),
      ALLOW_PUBLIC_SIGNUP: "false",
    };
    const result = await register(env, { identifier: "new-user", password: "a-valid-password" });
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: { code: "forbidden", message: "Public registration is disabled." },
    });
  });

  it("assigns the configured default group and returns it through login and session", async () => {
    const env = baseEnv();
    const created = await register(env, { identifier: "new-user", password: "a-valid-password" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.groupKey).toBe("free");

    const active = await session(env, created.data.sessionToken);
    expect(active).toEqual({
      ok: true,
      data: { id: created.data.id, identifier: "new-user", groupKey: "free" },
    });
  });
});

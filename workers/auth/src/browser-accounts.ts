import {
  BROWSER_ACCOUNT_LIMIT,
  SwitchBrowserAccountSchema,
  SwitchBrowserViewSchema,
  type BrowserAccount,
  type BrowserAccounts,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { createSessionCookie, hashToken, readCookie, SESSION_MAX_AGE_SECONDS } from "./session";

const ACCOUNT_PREFIX = "gitedge_account_";
const ACCOUNT_COOKIE_PATTERN = /^gitedge_account_[0-9a-f-]{36}$/;
const VIEW_COOKIE = "gitedge_view";
const MAX_SAVED_COOKIES = 20;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
interface AccountEnvironment {
  DB: D1Database;
  LOG_LEVEL?: string;
}
interface AccountRow extends BrowserAccount {
  tokenHash: string;
  expiresAt: number;
}
interface SavedAccount extends AccountRow {
  token: string;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function savedCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/api/auth; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
}
function accountCookie(account: SavedAccount): string {
  return savedCookie(ACCOUNT_PREFIX + account.id, account.token, remainingAge(account.expiresAt));
}
function remainingAge(expiresAt: number): number {
  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}
function cookieEntries(request: Request): [string, string][] {
  return (request.headers.get("Cookie") ?? "").split(";").map((part) => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  });
}
export function readBrowserView(request: Request): string | null {
  return cookieEntries(request).find(([name]) => name === VIEW_COOKIE)?.[1] || null;
}
function accountTokens(request: Request): string[] {
  const active = readCookie(request);
  const saved = cookieEntries(request)
    .filter(([name, value]) => ACCOUNT_COOKIE_PATTERN.test(name) && TOKEN_PATTERN.test(value))
    .slice(0, MAX_SAVED_COOKIES)
    .map(([, value]) => value);
  return [...new Set([...(active && TOKEN_PATTERN.test(active) ? [active] : []), ...saved])];
}
async function savedAccounts(request: Request, env: AccountEnvironment): Promise<SavedAccount[]> {
  const tokens = accountTokens(request);
  if (!tokens.length) return [];
  const hashes = await Promise.all(tokens.map(hashToken));
  const rows = await env.DB.prepare(
    `SELECT u.id,u.identifier,COALESCE(p.display_name,u.identifier) AS displayName,s.token_hash AS tokenHash,s.expires_at AS expiresAt FROM auth_sessions s JOIN users u ON u.id=s.user_id LEFT JOIN auth_account_profiles p ON p.user_id=u.id WHERE s.token_hash IN (${hashes.map(() => "?").join(",")}) AND s.expires_at>?`
  )
    .bind(...hashes, Date.now())
    .all<AccountRow>();
  return hashes
    .flatMap((hash, index) => {
      const row = rows.results.find((item) => item.tokenHash === hash);
      return row ? [{ ...row, token: tokens[index] }] : [];
    })
    .filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index);
}
function response(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}
function fail(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
function clearBrowserContext(response: Response): void {
  response.headers.append("Set-Cookie", cookie(VIEW_COOKIE, "", 0));
  response.headers.append(
    "Set-Cookie",
    "gitedge_sso=; Path=/api/auth/sso; Secure; HttpOnly; SameSite=None; Max-Age=0"
  );
  response.headers.append(
    "Set-Cookie",
    "gitedge_github_flow=; Path=/api/auth/github; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

function pruneSavedCookies(request: Request, response: Response, accounts: SavedAccount[]): void {
  for (const [name, value] of cookieEntries(request)
    .filter(([name]) => ACCOUNT_COOKIE_PATTERN.test(name))
    .slice(0, MAX_SAVED_COOKIES)) {
    if (
      !accounts.some((account) => name === ACCOUNT_PREFIX + account.id && value === account.token)
    )
      response.headers.append("Set-Cookie", savedCookie(name, "", 0));
  }
}

export async function rememberBrowserLogin(
  request: Request,
  env: AccountEnvironment,
  userId: string,
  token: string,
  response: Response
): Promise<Response> {
  const accounts = await savedAccounts(request, env);
  const previous = accounts.find((account) => account.id === userId);
  if (!previous && accounts.length >= BROWSER_ACCOUNT_LIMIT) {
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?")
      .bind(await hashToken(token))
      .run();
    return fail(409, "account_limit", "Remove a saved account before adding another.");
  }
  if (previous && previous.token !== token) {
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?")
      .bind(previous.tokenHash)
      .run();
  }
  pruneSavedCookies(request, response, accounts);
  for (const account of accounts) {
    if (account.id !== userId) response.headers.append("Set-Cookie", accountCookie(account));
  }
  response.headers.append(
    "Set-Cookie",
    savedCookie(ACCOUNT_PREFIX + userId, token, SESSION_MAX_AGE_SECONDS)
  );
  response.headers.append("Set-Cookie", createSessionCookie(token, SESSION_MAX_AGE_SECONDS));
  clearBrowserContext(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function browserAccountLogout(
  request: Request,
  env: AccountEnvironment
): Promise<Response> {
  const token = readCookie(request);
  const responseValue = response({ loggedOut: true });
  if (token) {
    const row = await env.DB.prepare(
      "DELETE FROM auth_sessions WHERE token_hash=? RETURNING user_id AS id"
    )
      .bind(await hashToken(token))
      .first<{ id: string }>();
    if (row)
      responseValue.headers.append("Set-Cookie", savedCookie(ACCOUNT_PREFIX + row.id, "", 0));
  }
  responseValue.headers.append("Set-Cookie", createSessionCookie("", 0));
  clearBrowserContext(responseValue);
  return responseValue;
}

export async function handleBrowserAccounts(
  request: Request,
  env: AccountEnvironment
): Promise<Response> {
  if (request.headers.has("Authorization"))
    return fail(403, "forbidden", "Browser accounts require a browser session.");
  const path = new URL(request.url).pathname;
  if (request.method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin)
    return fail(403, "forbidden", "Same-origin account management is required.");
  const expectedView = request.headers.get("X-GitEdge-Expected-View");
  if (expectedView && expectedView !== (readBrowserView(request) ? "guest" : "account"))
    return fail(
      409,
      "account_changed",
      "The active perspective changed. Reload before continuing."
    );
  const accounts = await savedAccounts(request, env);
  const active = accounts.find((account) => account.token === readCookie(request));
  const expected = request.headers.get("X-GitEdge-Expected-User");
  if (expected && expected !== active?.id)
    return fail(409, "account_changed", "The active account changed. Reload before continuing.");
  if (path === "/accounts" && request.method === "GET") {
    const data: BrowserAccounts = {
      accounts: accounts.map(({ id, identifier, displayName }) => ({
        id,
        identifier,
        displayName,
      })),
      activeAccountId: active?.id ?? null,
      view: { kind: readBrowserView(request) ? "guest" : "account" },
      accountLimit: BROWSER_ACCOUNT_LIMIT,
    };
    const result = response(data);
    pruneSavedCookies(request, result, accounts);
    for (const account of accounts) result.headers.append("Set-Cookie", accountCookie(account));
    return result;
  }
  if (path === "/accounts/switch" && request.method === "POST") {
    const parsed = SwitchBrowserAccountSchema.safeParse(await readJsonLimited(request, 1024));
    if (!parsed.success) return fail(400, "bad_request", "Invalid account selection.");
    const selected = accounts.find((account) => account.id === parsed.data.userId);
    if (!selected) return fail(401, "unauthorized", "This account requires sign-in again.");
    const result = response({ switched: true });
    result.headers.append(
      "Set-Cookie",
      createSessionCookie(selected.token, remainingAge(selected.expiresAt))
    );
    clearBrowserContext(result);
    createLogger(env.LOG_LEVEL, { service: "auth" }).info("browser-account-switched", {
      userId: selected.id,
    });
    return result;
  }
  if (path === "/accounts/view" && request.method === "POST") {
    const parsed = SwitchBrowserViewSchema.safeParse(await readJsonLimited(request, 1024));
    if (!parsed.success) return fail(400, "bad_request", "Invalid perspective.");
    const view = parsed.data;
    if (view.kind === "guest" && !active)
      return fail(401, "unauthorized", "Sign in before previewing as a guest.");
    const result = response({ switched: true });
    clearBrowserContext(result);
    result.headers.append(
      "Set-Cookie",
      cookie(
        VIEW_COOKIE,
        view.kind === "guest" ? "guest" : "",
        view.kind === "guest" && active ? remainingAge(active.expiresAt) : 0
      )
    );
    return result;
  }
  if (path === "/accounts/logout-all" && request.method === "POST") {
    const tokens = accountTokens(request);
    if (tokens.length) {
      const hashes = await Promise.all(tokens.map(hashToken));
      await env.DB.prepare(
        `DELETE FROM auth_sessions WHERE token_hash IN (${hashes.map(() => "?").join(",")})`
      )
        .bind(...hashes)
        .run();
    }
    const result = response({ loggedOut: true });
    for (const [name] of cookieEntries(request)
      .filter(([name]) => ACCOUNT_COOKIE_PATTERN.test(name))
      .slice(0, MAX_SAVED_COOKIES))
      result.headers.append("Set-Cookie", savedCookie(name, "", 0));
    result.headers.append("Set-Cookie", createSessionCookie("", 0));
    clearBrowserContext(result);
    return result;
  }
  if (/^\/accounts\/[^/]+$/.test(path) && request.method === "DELETE") {
    const selected = accounts.find((account) => account.id === path.split("/")[2]);
    if (!selected) return fail(404, "not_found", "Account was not found.");
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?")
      .bind(selected.tokenHash)
      .run();
    const isCurrent = selected.id === active?.id;
    const result = response({ removed: true, isCurrent });
    result.headers.append("Set-Cookie", savedCookie(ACCOUNT_PREFIX + selected.id, "", 0));
    if (isCurrent) {
      result.headers.append("Set-Cookie", createSessionCookie("", 0));
      clearBrowserContext(result);
    }
    return result;
  }
  return fail(404, "not_found", "Account endpoint was not found.");
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const origin = process.env.GITEDGE_API ?? "http://localhost:8877";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const cookies = new Map();
const stamp = randomBytes(3).toString("hex");
const accounts = [0, 1].map((index) => ({
  identifier: `account-${stamp}-${index}`,
  password: randomBytes(24).toString("base64url"),
}));
const output = path.resolve(`work/account-perspectives/fixture-${stamp}.json`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ origin, accounts }, null, 2), { mode: 0o600 });
async function api(endpoint, method = "GET", body, expected = 200) {
  const result = await fetch(origin + endpoint, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const item of result.headers.getSetCookie()) {
    const pair = item.split(";", 1)[0],
      index = pair.indexOf("="),
      name = pair.slice(0, index);
    if (item.includes("Max-Age=0")) cookies.delete(name);
    else cookies.set(name, pair.slice(index + 1));
  }
  const text = await result.text();
  assert.equal(result.status, expected, `${method} ${endpoint}: ${text}`);
  return text ? JSON.parse(text).data : undefined;
}
for (const account of accounts)
  account.user = await api("/api/auth/register", "POST", account, 201);
let list = await api("/api/auth/accounts");
assert.equal(list.accounts.length, 2);
assert.equal(list.activeAccountId, accounts[1].user.id);
await api("/api/auth/accounts/switch", "POST", { userId: accounts[0].user.id });
const repository = await api(
  "/api/forge/repositories",
  "POST",
  {
    owner: accounts[0].identifier,
    slug: "perspectives",
    visibility: "private",
    initializeReadme: true,
  },
  201
);
const agent = await api(
  "/api/auth/agents",
  "POST",
  { name: "Workspace Reviewer", handle: "reviewer", description: "Account perspective validation" },
  201
);
const session = await api(
  `/api/auth/agents/${agent.id}/sessions`,
  "POST",
  { repositoryId: repository.id, baseRef: "main", permission: "read", ttlSeconds: 3600 },
  201
);
await api("/api/auth/accounts/view", "POST", { kind: "agent", sessionId: session.id });
assert.equal((await api("/api/auth/session")).agentSession.id, session.id);
assert.ok(
  (await api(`/api/git/repositories/${repository.id}/tree?ref=main&path=`)).entries.some(
    (entry) => entry.path === "README.md" || entry.name === "README.md"
  )
);
await api("/api/auth/profile", "GET", undefined, 403);
await api(
  `/api/forge/repositories/${repository.id}/issues`,
  "POST",
  { title: "Read-only actor", body: "Must fail" },
  403
);
await api("/api/auth/accounts/view", "POST", { kind: "account" });
await api("/api/auth/accounts/switch", "POST", { userId: accounts[1].user.id });
await api(
  `/api/forge/repositories/by-name/${accounts[0].identifier}/perspectives`,
  "GET",
  undefined,
  404
);
await api("/api/auth/accounts/switch", "POST", { userId: accounts[0].user.id });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    { origin, accounts, repository, agent, session: { id: session.id, agentId: agent.id } },
    null,
    2
  ),
  { mode: 0o600 }
);
await api("/api/auth/accounts/logout-all", "POST");
assert.equal((await api("/api/auth/accounts")).accounts.length, 0);
console.log(
  JSON.stringify({
    ok: true,
    accounts: accounts.map(({ identifier }) => identifier),
    repository: repository.id,
    agentSession: session.id,
    fixture: output,
  })
);

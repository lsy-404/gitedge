import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as git from "isomorphic-git";
import { generateKey, readPrivateKey, createMessage, sign } from "openpgp";

const origin = process.env.GITEDGE_API ?? "http://localhost:8899";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const directory = process.env.GITEDGE_FIXTURE;
assert.ok(directory, "Set GITEDGE_FIXTURE to a local api-git acceptance fixture.");
const credentialFile = path.join(directory, "credentials.json");
const credentials = JSON.parse(await readFile(credentialFile, "utf8"));
async function api(endpoint, method = "GET", body, expected = 200, anonymous = false) {
  const response = await fetch(new URL(endpoint, origin), {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(anonymous ? {} : { Cookie: credentials.cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(
    response.status,
    expected,
    `${method} ${endpoint}: expected ${expected}, got ${response.status}`
  );
  return (await response.json()).data;
}
const source = path.join(directory, "source");
const exec = promisify(execFile);
async function gitCommand(args, expectedFailure = false) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credentials.credential.token}`,
  };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE") delete env[key];
  let failed = false;
  let stdout = "";
  try {
    stdout = (await exec("git", args, { cwd: source, env })).stdout.trim();
  } catch {
    failed = true;
  }
  assert.equal(
    failed,
    expectedFailure,
    `Git ${args[0]} ${expectedFailure ? "must reject" : "must succeed"}`
  );
  return stdout;
}
const repository = (await api("/api/forge/repositories")).find(
  (repo) =>
    repo.id === credentials.credential.repositoryId ||
    repo.name === "workspace" ||
    repo.name === "fluent-workspace"
);
assert.ok(repository);
const prefix = `/api/forge/repositories/${repository.id}`;
await api(`/api/git/repositories/${repository.id}/merge`, "POST", {}, 405);
const originalProfile = await api("/api/auth/profile");
const owner = `workspace-${repository.id.slice(0, 8)}`;
await api("/api/auth/profile", "PATCH", { identifier: "settings" }, 409);
const profile = await api("/api/auth/profile", "PATCH", {
  identifier: owner,
  displayName: "Workspace Maintainer",
  bio: "Cloudflare Git workspace",
  preferences: {
    theme: "light",
    locale: "zh-CN",
    density: "comfortable",
    tabSize: 4,
    lineWrap: true,
  },
});
assert.equal(profile.identifier, owner);
assert.equal((await api("/api/auth/session")).identifier, owner);
credentials.identifier = owner;
await writeFile(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
await api(`${prefix}/settings`, "PATCH", {
  name: "fluent-workspace",
  description: "Platform Kit and signed Git workflow",
  requiredApprovals: 1,
  requirePassingChecks: true,
});
assert.equal(
  (await api("/api/forge/repositories")).find((repo) => repo.id === repository.id).owner,
  owner
);
await gitCommand(["remote", "set-url", "origin", `${origin}/${owner}/fluent-workspace.git`]);
await gitCommand(["fetch", "origin"]);
assert.equal(
  (await api(`/api/forge/repositories/by-name/${owner}/fluent-workspace`)).id,
  repository.id
);
if (originalProfile.identifier !== owner) {
  const old = await fetch(
    `${origin}/api/forge/repositories/by-name/${originalProfile.identifier}/${repository.name}`
  );
  assert.equal(old.status, 404);
}
for (const [flag, route] of [
  ["issuesEnabled", "issues"],
  ["pullsEnabled", "pull-requests"],
  ["discussionsEnabled", "discussions"],
  ["wikiEnabled", "wiki"],
]) {
  const previous = await api(`${prefix}/${route}`);
  await api(`${prefix}/settings`, "PATCH", { [flag]: false });
  await api(`${prefix}/${route}`, "GET", undefined, 404);
  await api(`${prefix}/settings`, "PATCH", { [flag]: true });
  assert.deepEqual(await api(`${prefix}/${route}`), previous);
}
await api(`${prefix}/settings`, "PATCH", { defaultBranch: "missing-branch" }, 400);
await api(`${prefix}/settings`, "PATCH", { defaultBranch: "feature/cache-policy" });
assert.equal((await api(`${prefix}/settings`)).defaultBranch, "feature/cache-policy");
assert.ok(
  (await gitCommand(["ls-remote", "origin", "refs/heads/feature/cache-policy"])).includes(
    "refs/heads/feature/cache-policy"
  )
);
await api(`${prefix}/settings`, "PATCH", { defaultBranch: "main", memoryVisibility: "public" });
await api(`${prefix}/settings`, "PATCH", { visibility: "private" });
assert.equal((await api(`${prefix}/settings`)).memoryVisibility, "members");
await api(`${prefix}/issues`, "GET", undefined, 404, true);
await api(`${prefix}/settings`, "PATCH", { visibility: "public" });
await api(`${prefix}/settings`, "PATCH", { archived: true });
await api(`${prefix}/issues`);
await api(`${prefix}/issues`, "POST", { title: "Must reject archived write", body: "" }, 409);
await api(
  "/api/auth/tokens",
  "POST",
  {
    repositoryId: repository.id,
    name: "Must reject archived write",
    permission: "write",
    ttlSeconds: 3600,
  },
  409
);
await gitCommand(["push", "origin", "main"], true);
await api(`${prefix}/settings`, "PATCH", { archived: false });
console.log(
  "Profile rename, persistent preferences, repository flags, branch selection, visibility and archive guards passed"
);

const keys = await generateKey({
  type: "ecc",
  curve: "ed25519Legacy",
  userIDs: [{ name: "Workspace Maintainer", email: "maintainer@example.invalid" }],
  format: "armored",
});
const privateKey = await readPrivateKey({ armoredKey: keys.privateKey });
async function signature(payload) {
  return sign({
    message: await createMessage({ binary: new TextEncoder().encode(payload) }),
    signingKeys: privateKey,
    detached: true,
    format: "armored",
  });
}
const challenge = await api(
  "/api/auth/signing-keys/challenges",
  "POST",
  { title: "Git acceptance key", publicKey: keys.publicKey },
  201
);
const key = await api(
  "/api/auth/signing-keys",
  "POST",
  { challengeId: challenge.id, signature: await signature(challenge.payload) },
  201
);
await gitCommand(["checkout", "main"]);
await writeFile(
  path.join(source, "signature-verification.txt"),
  "An actual signed Git commit, verified against its exact payload.\n"
);
await git.add({ fs, dir: source, filepath: "signature-verification.txt" });
const unsignedOid = await git.commit({
  fs,
  dir: source,
  message: "Verify an unsigned Git commit",
  author: { name: "Workspace Maintainer", email: "maintainer@example.invalid" },
});
const oid = await git.commit({
  fs,
  dir: source,
  message: "Verify a signed Git commit",
  author: { name: "Workspace Maintainer", email: "maintainer@example.invalid" },
  signingKey: keys.privateKey,
  onSign: async ({ payload }) => ({ signature: await signature(payload) }),
});
await gitCommand(["push", "origin", "main"]);
const verified = await api(`/api/git/repositories/${repository.id}/signature?ref=main&oid=${oid}`);
assert.equal(verified.status, "valid");
assert.equal(verified.fingerprint, key.fingerprint);
assert.equal(verified.signer.identifier, owner);
assert.equal(
  (await api(`/api/git/repositories/${repository.id}/signature?ref=main&oid=${unsignedOid}`))
    .status,
  "unsigned"
);
const result = {
  owner,
  repositoryId: repository.id,
  repository: "fluent-workspace",
  oid,
  keyId: key.id,
  fingerprint: key.fingerprint,
  url: `${origin}/${owner}/fluent-workspace/commits?ref=main&oid=${oid}`,
};
await writeFile(path.join(directory, "settings-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ result: "PASS", ...result }, null, 2));

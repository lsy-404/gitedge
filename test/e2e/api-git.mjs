import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const origin = process.env.GITEDGE_API || "http://localhost:8877";
assert.ok(
  ["localhost", "127.0.0.1"].includes(new URL(origin).hostname),
  "Run verification against a loopback Gateway."
);
const identifier = `verify-${randomBytes(4).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const directory = path.resolve("work", identifier);
await mkdir(directory, { recursive: true });
let cookie = "";
const secrets = [password];
const publicResult = {};
function redact(text) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), text);
}
async function api(endpoint, method = "GET", body, token, expectedStatus) {
  const headers = { "Content-Type": "application/json", Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (cookie) headers.Cookie = cookie;
  const response = await fetch(new URL(endpoint, origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  const text = await response.text();
  if (expectedStatus) assert.equal(response.status, expectedStatus, `${endpoint}: ${redact(text)}`);
  else assert.ok(response.ok, `${endpoint}: HTTP ${response.status} ${redact(text)}`);
  return text ? JSON.parse(text).data : undefined;
}
async function git(args, cwd, token) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE") delete env[key];
  try {
    return (await exec("git", args, { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    throw new Error(redact(error.stderr || error.message));
  }
}
async function commit(cwd, message, token) {
  await git(["add", "."], cwd, token);
  await git(
    [
      "-c",
      "user.name=Verification",
      "-c",
      "user.email=verification@gitedge.invalid",
      "commit",
      "-m",
      message,
    ],
    cwd,
    token
  );
  await git(["push", "origin", "main"], cwd, token);
  return git(["rev-parse", "HEAD"], cwd, token);
}
try {
  await api("/api/auth/register", "POST", { identifier, password });
  const repository = await api("/api/forge/repositories", "POST", {
    owner: identifier,
    slug: "workspace",
    visibility: "public",
    description: "Artifacts and agent integration verification",
  });
  publicResult.repository = repository;
  console.log("Account and Artifacts repository created");
  const credential = await api("/api/auth/tokens", "POST", {
    repositoryId: repository.id,
    name: "verification",
    permission: "write",
    ttlSeconds: 3600,
  });
  secrets.push(credential.token);
  const source = path.join(directory, "source");
  await mkdir(source);
  await git(["init", "-b", "main"], source, credential.token);
  const remote = `${origin}/${identifier}/workspace.git`;
  await git(["remote", "add", "origin", remote], source, credential.token);
  await mkdir(path.join(source, "worker"));
  await writeFile(
    path.join(source, "README.md"),
    "# Repository verification\n\nTwo isolated agent workspaces.\n"
  );
  await writeFile(
    path.join(source, "worker", "index.js"),
    "export default { fetch() { return new Response('Verified Worker'); } };\n"
  );
  await writeFile(
    path.join(source, "gitedge.deploy.json"),
    JSON.stringify(
      {
        schema: 1,
        name: "Verification Worker",
        license: { id: "MIT", text: "MIT License" },
        terms: { required: false, text: "" },
        worker: {
          name: "verification-worker",
          entrypoint: "worker/index.js",
          modules: ["worker/index.js"],
          compatibilityDate: "2026-10-01",
          compatibilityFlags: [],
          vars: {},
        },
        resources: { d1: [], r2: [], kv: [] },
      },
      null,
      2
    )
  );
  await commit(source, "Add initial project", credential.token);
  await git(["clone", remote, path.join(directory, "clone")], directory, credential.token);
  assert.equal(
    await readFile(path.join(directory, "clone", "README.md"), "utf8"),
    await readFile(path.join(source, "README.md"), "utf8")
  );
  const tree = await api(`/api/git/repositories/${repository.id}/tree?ref=main`);
  assert.ok(tree.entries.some((entry) => entry.name === "README.md"));
  console.log("Gateway Git push, separate clone and file tree verified");
  const agents = await Promise.all(
    ["builder", "reviewer"].map((name) =>
      api("/api/auth/agents", "POST", { name, description: "Integration verification" })
    )
  );
  const sessions = await Promise.all(
    agents.map((agent) =>
      api(`/api/auth/agents/${agent.id}/sessions`, "POST", {
        repositoryId: repository.id,
        baseRef: "main",
        permission: "write",
        ttlSeconds: 3600,
      })
    )
  );
  assert.notEqual(sessions[0].workspaceName, sessions[1].workspaceName);
  for (const session of sessions) secrets.push(session.token, session.gitToken);
  await writeFile(
    path.join(directory, "credentials.json"),
    JSON.stringify({ identifier, password, cookie, credential, sessions }),
    { mode: 0o600 }
  );
  const heads = await Promise.all(
    sessions.map(async (session, index) => {
      const cwd = path.join(directory, `session-${index}`);
      await git(["clone", session.remote, cwd], directory, session.gitToken);
      await writeFile(
        path.join(cwd, `contribution-${index}.txt`),
        `Contribution from isolated session ${index}.\n`
      );
      return commit(cwd, `Add session contribution ${index}`, session.gitToken);
    })
  );
  console.log("Two authenticated agents pushed concurrently to separate forks");
  const pull = await api(
    `/api/forge/repositories/${repository.id}/pull-requests`,
    "POST",
    {
      title: "Integrate session contribution",
      body: "Verified from an isolated fork.",
      baseRef: "main",
      headRef: "main",
      headSessionId: sessions[0].id,
    },
    sessions[0].token
  );
  let comparison = await api(
    `/api/forge/repositories/${repository.id}/pull-requests/${pull.number}/diff`
  );
  assert.equal(comparison.headOid, heads[0]);
  assert.equal(comparison.files.length, 1);
  const agentComparison = await api(
    `/api/forge/repositories/${repository.id}/pull-requests/${pull.number}/diff`,
    "GET",
    undefined,
    sessions[0].token
  );
  assert.equal(agentComparison.baseOid, comparison.baseOid);
  for (const status of ["queued", "in_progress", "completed"])
    await api(
      `/api/forge/repositories/${repository.id}/pull-requests/${pull.number}/checks`,
      "POST",
      {
        name: "repository verification",
        commitOid: heads[0],
        status,
        conclusion: status === "completed" ? "success" : null,
        summary: "Git push and clone verification completed.",
      },
      sessions[1].token
    );
  const review = await api(
    `/api/forge/repositories/${repository.id}/pull-requests/${pull.number}/reviews`,
    "POST",
    { commitOid: heads[0], state: "approved", body: "Reviewed the isolated contribution." },
    sessions[1].token
  );
  assert.equal(review.actor.kind, "agent");
  assert.equal(review.actor.id, agents[1].id);
  const checks = await api(
    `/api/forge/repositories/${repository.id}/pull-requests/${pull.number}/checks`
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].actor.kind, "agent");
  await api(`/api/forge/repositories/${repository.id}/pull-requests/${pull.number}/merge`, "POST", {
    expectedBaseOid: comparison.baseOid,
    expectedHeadOid: comparison.headOid,
  });
  const second = await api(
    `/api/forge/repositories/${repository.id}/pull-requests`,
    "POST",
    {
      title: "Integrate second session",
      baseRef: "main",
      headRef: "main",
      headSessionId: sessions[1].id,
    },
    sessions[1].token
  );
  comparison = await api(
    `/api/forge/repositories/${repository.id}/pull-requests/${second.number}/diff`
  );
  await api(
    `/api/forge/repositories/${repository.id}/pull-requests/${second.number}/merge`,
    "POST",
    { expectedBaseOid: comparison.baseOid, expectedHeadOid: comparison.headOid }
  );
  await git(["pull", "--ff-only", "origin", "main"], source, credential.token);
  for (const index of [0, 1])
    assert.match(
      await readFile(path.join(source, `contribution-${index}.txt`), "utf8"),
      /Contribution/
    );
  const issue = await api(`/api/forge/repositories/${repository.id}/issues`, "POST", {
    title: "Track verified work",
    labels: ["verification"],
    assignees: [identifier],
  });
  await api(`/api/forge/repositories/${repository.id}/issues/${issue.number}/comments`, "POST", {
    body: "Both session contributions are merged.",
  });
  await api(`/api/forge/repositories/${repository.id}/issues/${issue.number}`, "PATCH", {
    state: "closed",
  });
  const discussion = await api(`/api/forge/repositories/${repository.id}/discussions`, "POST", {
    title: "How are sessions isolated?",
    category: "q-and-a",
    body: "Inspect the fork graph.",
  });
  const answer = await api(
    `/api/forge/repositories/${repository.id}/discussions/${discussion.number}/comments`,
    "POST",
    { body: "Each session owns a separate Artifacts repository." }
  );
  await api(`/api/forge/repositories/${repository.id}/discussions/${discussion.number}`, "PATCH", {
    answerCommentId: answer.id,
  });
  await api(`/api/forge/repositories/${repository.id}/wiki/home`, "PUT", {
    title: "Home",
    content: "First revision",
    expectedRevision: 0,
  });
  await api(`/api/forge/repositories/${repository.id}/wiki/home`, "PUT", {
    title: "Home",
    content: "Verified agent workflow",
    expectedRevision: 1,
  });
  await api(
    `/api/forge/repositories/${repository.id}/wiki/home`,
    "PUT",
    { title: "Home", content: "Stale edit", expectedRevision: 1 },
    undefined,
    409
  );
  assert.equal((await api(`/api/forge/repositories/${repository.id}/wiki/home/history`)).length, 2);
  const plan = await api(`/api/deploy/plan?repositoryId=${repository.id}&ref=main`);
  assert.ok(plan.manifestDigest);
  assert.equal(plan.manifest.name, "Verification Worker");
  const graph = await api(`/api/git/repositories/${repository.id}/graph`);
  assert.equal(graph.sessions.length, 2);
  assert.ok(graph.commits.some((commit) => commit.parents.length === 2));
  await api(`/api/auth/agents/${agents[0].id}/sessions/${sessions[0].id}`, "DELETE");
  await api("/api/auth/session", "GET", undefined, sessions[0].token, 401);
  publicResult.pulls = [pull.number, second.number];
  publicResult.issue = issue.number;
  publicResult.discussion = discussion.number;
  publicResult.graph = graph;
  await writeFile(path.join(directory, "result.json"), JSON.stringify(publicResult, null, 2));
  console.log(
    JSON.stringify({
      outcome: "passed",
      directory,
      repositoryUrl: `${origin}/${identifier}/workspace`,
      pulls: publicResult.pulls,
      commits: graph.commits.length,
      sessions: graph.sessions.length,
    })
  );
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const exec = promisify(execFile);
const origin = process.env.GITEDGE_API ?? "http://localhost:8877";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const identifier = `controls-${randomBytes(3).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const directory = path.resolve("work", identifier);
await mkdir(directory, { recursive: true });
let cookie = "",
  credential;
async function api(endpoint, method = "GET", body, expected = 200) {
  const res = await fetch(origin + endpoint, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const activeCookie = res.headers
    .getSetCookie()
    .find((value) => value.startsWith("gitedge_session="));
  if (activeCookie) cookie = activeCookie.split(";")[0];
  const text = await res.text();
  assert.equal(res.status, expected, `${method} ${endpoint}: ${text}`);
  return text ? JSON.parse(text).data : undefined;
}
async function git(args, cwd = directory) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.token}`,
  };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE") delete env[key];
  try {
    return (await exec("git", args, { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch (e) {
    throw new Error(String(e.stderr ?? e.message).replaceAll(credential.token, "[redacted]"));
  }
}
const flags = {
  issuesEnabled: true,
  pullsEnabled: true,
  discussionsEnabled: true,
  wikiEnabled: true,
  tasksEnabled: true,
  agentsEnabled: true,
  deploymentsEnabled: true,
  graphEnabled: true,
  actionsEnabled: false,
  onlineEditingEnabled: true,
};
const report = { identifier };
try {
  await api("/api/auth/register", "POST", { identifier, password }, 201);
  const ownerCookie = cookie;
  const reviewer = `${identifier}-rv`;
  await api("/api/auth/register", "POST", { identifier: reviewer, password }, 201);
  const reviewerCookie = cookie;
  cookie = ownerCookie;
  const repo = await api(
    "/api/forge/repositories",
    "POST",
    { owner: identifier, slug: "nonempty", visibility: "public", initializeReadme: true },
    201
  );
  report.repositoryId = repo.id;
  const root = `/api/git/repositories/${repo.id}`;
  const forge = `/api/forge/repositories/${repo.id}`;
  const branches = () => api(root + "/branches");
  const tip = async (ref = "main") => (await branches()).find((b) => b.name === ref).oid;
  const edit = (branch, expectedOid, file, content, newBranch) =>
    api(
      root + "/edit",
      "POST",
      { branch, expectedOid, path: file, content, message: `Update ${file}`, newBranch },
      201
    );
  let main = await tip();
  assert.ok((await api(root + "/file?ref=main&path=README.md")).content.includes("nonempty"));
  const first = main;
  main = (await edit("main", main, "docs/start.md", "# Start\n")).oid;
  await api(
    root + "/edit",
    "POST",
    { branch: "main", expectedOid: first, path: "README.md", content: "stale", message: "Stale" },
    409
  );
  const feature = (await edit("main", main, "feature.txt", "feature\n", "feature/ui")).oid;
  const rule = await api(
    forge + "/branch-rules",
    "POST",
    { pattern: "main", requirePassingChecks: true, requiredStatusChecks: ["verify"] },
    201
  );
  await api(
    root + "/edit",
    "POST",
    {
      branch: "main",
      expectedOid: main,
      path: "blocked.txt",
      content: "blocked",
      message: "Blocked",
    },
    403
  );
  await api(forge + "/settings", "PATCH", { deleteBranchOnMerge: true });
  credential = await api(
    "/api/auth/tokens",
    "POST",
    { repositoryId: repo.id, name: "control verification", permission: "write", ttlSeconds: 3600 },
    201
  );
  const clone = path.join(directory, "clone");
  await git(["clone", `${origin}/${identifier}/nonempty.git`, clone]);
  await writeFile(path.join(clone, "blocked.txt"), "blocked\n");
  await git(["add", "."], clone);
  await git(
    [
      "-c",
      "user.name=Verification",
      "-c",
      "user.email=verification@gitedge.invalid",
      "commit",
      "-m",
      "Direct push must fail",
    ],
    clone
  );
  await assert.rejects(git(["push", "origin", "main"], clone), /403|protected/i);
  const pr = await api(
    forge + "/pull-requests",
    "POST",
    { title: "Protected branch validation", baseRef: "main", headRef: "feature/ui" },
    201
  );
  await api(
    forge + `/pull-requests/${pr.number}/merge`,
    "POST",
    { expectedBaseOid: main, expectedHeadOid: feature },
    409
  );
  const verifyCheck = {
    name: "verify",
    commitOid: feature,
    status: "completed",
    conclusion: "success",
    summary: "Exact commit validated",
  };
  await api(forge + `/pull-requests/${pr.number}/checks`, "POST", verifyCheck, 201);
  await api(
    forge + `/pull-requests/${pr.number}/merge`,
    "POST",
    { expectedBaseOid: main, expectedHeadOid: feature },
    409
  );
  await api(forge + "/collaborators", "PUT", { identifier: reviewer, role: "write" });
  cookie = reviewerCookie;
  await api(forge + `/pull-requests/${pr.number}/checks`, "POST", verifyCheck, 201);
  cookie = ownerCookie;
  const merged = await api(forge + `/pull-requests/${pr.number}/merge`, "POST", {
    expectedBaseOid: main,
    expectedHeadOid: feature,
  });
  assert.equal(merged.state, "merged");
  assert.equal(await tip(), feature);
  assert.ok(!(await branches()).some((b) => b.name === "feature/ui"));
  await api(forge + `/branch-rules/${rule.id}`, "DELETE");
  console.log(
    "README, stale edit, multiple branches, native protected push, exact check merge and branch cleanup passed"
  );
  for (const method of ["squash", "rebase"]) {
    main = await tip();
    let head = (await edit("main", main, `${method}.txt`, `${method} one\n`, `feature/${method}`))
      .oid;
    if (method === "rebase")
      head = (await edit(`feature/${method}`, head, "rebase-two.txt", "two\n")).oid;
    main = (await edit("main", main, `base-${method}.txt`, "base advanced\n")).oid;
    const pull = await api(
      forge + "/pull-requests",
      "POST",
      { title: `Validate ${method}`, baseRef: "main", headRef: `feature/${method}` },
      201
    );
    const result = await api(forge + `/pull-requests/${pull.number}/merge`, "POST", {
      method,
      expectedBaseOid: main,
      expectedHeadOid: head,
    });
    assert.equal(result.state, "merged");
    assert.equal(
      (await api(root + `/file?ref=main&path=${method}.txt`)).content,
      `${method} one\n`
    );
    if (method === "rebase")
      assert.equal((await api(root + "/file?ref=main&path=rebase-two.txt")).content, "two\n");
  }
  console.log("Divergent squash and two-commit rebase passed");
  main = await tip();
  const unsigned = (await edit("main", main, "unsigned.txt", "unsigned\n", "feature/unsigned")).oid;
  const signedRule = await api(
    forge + "/branch-rules",
    "POST",
    { pattern: "main", requireSignedCommits: true },
    201
  );
  const signedPr = await api(
    forge + "/pull-requests",
    "POST",
    { title: "Unsigned commit rejection", baseRef: "main", headRef: "feature/unsigned" },
    201
  );
  await api(
    forge + `/pull-requests/${signedPr.number}/merge`,
    "POST",
    { expectedBaseOid: main, expectedHeadOid: unsigned },
    409
  );
  await api(forge + `/branch-rules/${signedRule.id}`, "DELETE");
  await api(forge + "/settings", "PATCH", { name: "validated.repo" });
  const old = await fetch(`${origin}/${identifier}/nonempty/blob/docs/start.md?ref=main`, {
    redirect: "manual",
  });
  assert.equal(old.status, 308);
  assert.equal(
    old.headers.get("location"),
    `${origin}/${identifier}/validated.repo/blob/docs/start.md?ref=main`
  );
  await git([
    "clone",
    `${origin}/${identifier}/nonempty.git`,
    path.join(directory, "redirect-clone"),
  ]);
  assert.equal(
    (await api(`/api/forge/repositories/by-name/${identifier}/nonempty`)).name,
    "validated.repo"
  );
  console.log("Signed-commit enforcement and old browser/Git URL redirects passed");
  const defaults = await api(
    "/api/forge/repositories",
    "POST",
    { owner: identifier, slug: ".github", visibility: "public", initializeReadme: true },
    201
  );
  let defaultTip = (await api(`/api/git/repositories/${defaults.id}/branches`))[0].oid;
  for (const [file, content] of [
    ["CONTRIBUTING.md", "# Shared contributing\n"],
    [".github/ISSUE_TEMPLATE/bug.md", "---\nname: Bug report\ntitle: Bug\n---\n## Reproduce\n"],
  ]) {
    defaultTip = (
      await api(
        `/api/git/repositories/${defaults.id}/edit`,
        "POST",
        {
          branch: "main",
          expectedOid: defaultTip,
          path: file,
          content,
          message: "Add community defaults",
        },
        201
      )
    ).oid;
  }
  main = await tip();
  main = (await edit("main", main, ".github/README.md", "# Preferred README\n")).oid;
  const community = await api(root + "/community?ref=main");
  assert.equal(community.files.find((f) => f.kind === "readme").path, ".github/README.md");
  assert.equal(community.files.find((f) => f.kind === "contributing").inherited, true);
  assert.equal(community.issueTemplates[0].inherited, true);
  const profile = await api(
    "/api/forge/repositories",
    "POST",
    { owner: identifier, slug: identifier, visibility: "public", initializeReadme: true },
    201
  );
  assert.equal((await api(`/api/forge/profiles/${identifier}`)).readme.repositoryId, profile.id);
  await api(
    forge + "/settings",
    "PATCH",
    Object.fromEntries(Object.keys(flags).map((k) => [k, false]))
  );
  await api(root + "/graph", "GET", undefined, 404);
  await api(forge + "/issues", "GET", undefined, 404);
  await api(forge + "/tasks", "GET", undefined, 404);
  assert.ok((await api(root + "/file?ref=main&path=README.md")).content);
  await api(forge + "/settings", "PATCH", flags);
  const activeRule = await api(forge + "/branch-rules", "POST", { pattern: "main" }, 201);
  report.ruleId = activeRule.id;
  report.repositoryPath = `/${identifier}/validated.repo`;
  await writeFile(
    path.join(directory, "ui-fixture.json"),
    JSON.stringify({ origin, identifier, password, ...report }, null, 2),
    { mode: 0o600 }
  );
  console.log("Community inheritance, profile README and independent feature gates passed");
  await writeFile(path.join(directory, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (credential) await api(`/api/auth/tokens/${credential.id}`, "DELETE", undefined, 200);
}

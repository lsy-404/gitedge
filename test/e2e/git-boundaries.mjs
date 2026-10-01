import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const origin = process.env.GITEDGE_API || "http://localhost:8877";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
assert.ok(process.argv[2], "Pass the successful api-git fixture directory.");
const directory = path.resolve(process.argv[2]);
const fixture = JSON.parse(await readFile(path.join(directory, "credentials.json"), "utf8"));
const original = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
const secrets = [
  fixture.password,
  fixture.cookie,
  fixture.credential.token,
  ...fixture.sessions.flatMap((session) => [session.token, session.gitToken]),
];
const redact = (text) =>
  secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
async function api(endpoint, method = "GET", body, options = {}) {
  const headers = { "Content-Type": "application/json", Origin: origin, ...options.headers };
  if (options.agent) headers.Authorization = `Bearer ${options.agent}`;
  else if (!options.anonymous) headers.Cookie = fixture.cookie;
  const response = await fetch(new URL(endpoint, origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, options.status || 200, `${endpoint}: ${redact(text)}`);
  return text ? JSON.parse(text).data : undefined;
}
function basic(token, username = fixture.identifier) {
  const value = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  secrets.push(token, value);
  return value;
}
async function git(args, cwd, authorization) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: authorization ? "1" : "0",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE") delete env[key];
  try {
    return (await exec("git", args, { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    throw new Error(redact(error.stderr || error.message));
  }
}
async function commit(cwd, message) {
  await git(["add", "."], cwd);
  await git(
    [
      "-c",
      "user.name=Verification",
      "-c",
      "user.email=verification@example.test",
      "commit",
      "-m",
      message,
    ],
    cwd
  );
}
try {
  const owner = await api("/api/auth/session");
  const repository = await api(
    "/api/forge/repositories",
    "POST",
    {
      owner: fixture.identifier,
      slug: `private-${randomBytes(3).toString("hex")}`,
      visibility: "private",
    },
    { status: 201 }
  );
  const writer = await api(
    "/api/auth/tokens",
    "POST",
    { repositoryId: repository.id, name: "boundary writer", permission: "write", ttlSeconds: 3600 },
    { status: 201 }
  );
  const reader = await api(
    "/api/auth/tokens",
    "POST",
    { repositoryId: repository.id, name: "boundary reader", permission: "read", ttlSeconds: 3600 },
    { status: 201 }
  );
  const writeAuth = basic(writer.token),
    readAuth = basic(reader.token);
  const remote = `${origin}/${fixture.identifier}/${repository.slug}.git`;
  const source = path.join(directory, repository.slug);
  await mkdir(source);
  await git(["init", "-b", "main"], source);
  await git(["remote", "add", "origin", remote], source);
  const binary = randomBytes(65536);
  await writeFile(path.join(source, "binary.dat"), binary);
  await writeFile(path.join(source, "README.md"), "Private Git verification\n");
  await commit(source, "Add private binary repository");
  await git(["push", "origin", "main"], source, writeAuth);
  await git(["checkout", "-b", "feature/integration"], source);
  await writeFile(path.join(source, "feature.txt"), "Slash branch verification\n");
  await commit(source, "Add slash branch");
  await assert.rejects(git(["push", "origin", "feature/integration"], source, readAuth));
  await git(["push", "origin", "feature/integration"], source, writeAuth);
  await git(
    [
      "-c",
      "user.name=Verification",
      "-c",
      "user.email=verification@example.test",
      "tag",
      "-a",
      "verification/v1",
      "-m",
      "Annotated tag",
    ],
    source
  );
  await git(["push", "origin", "verification/v1"], source, writeAuth);
  const clone = path.join(directory, `${repository.slug}-clone`);
  await git(["clone", remote, clone], directory, readAuth);
  assert.deepEqual(await readFile(path.join(clone, "binary.dat")), binary);
  const refs = await git(["ls-remote", "origin"], clone, readAuth);
  assert.match(refs, /refs\/heads\/feature\/integration/);
  assert.match(refs, /refs\/tags\/verification\/v1\^\{\}/);
  const file = await api(
    `/api/git/repositories/${repository.id}/file?ref=feature%2Fintegration&path=feature.txt`
  );
  assert.equal(file.content, "Slash branch verification\n");
  const tagFile = await api(
    `/api/git/repositories/${repository.id}/file?ref=verification%2Fv1&path=feature.txt`
  );
  assert.equal(tagFile.content, file.content);
  console.log(
    "Basic Git authentication, private clone, binary content, slash branch and annotated tag passed"
  );
  await assert.rejects(git(["ls-remote", remote], directory));
  await assert.rejects(
    git(["ls-remote", remote], directory, basic(writer.token, "wrong-namespace"))
  );
  await api(
    `/api/forge/repositories/by-name/${fixture.identifier}/${repository.slug}`,
    "GET",
    undefined,
    { anonymous: true, status: 404 }
  );
  await api(`/api/git/repositories/${repository.id}/tree`, "GET", undefined, {
    anonymous: true,
    status: 404,
  });
  const spoof = {
    "X-GitEdge-User-Id": owner.id,
    "X-GitEdge-User-Name": fixture.identifier,
    "X-GitEdge-User-Group": "admin",
    "X-GitEdge-Git-Grant": JSON.stringify({ repositoryId: repository.id, permission: "write" }),
  };
  await api(`/api/git/repositories/${repository.id}/tree`, "GET", undefined, {
    anonymous: true,
    headers: spoof,
    status: 404,
  });
  const forged = await fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: spoof });
  assert.equal(forged.status, 404);
  await api(
    `/api/forge/repositories/${repository.id}/issues`,
    "POST",
    { title: "Cross-origin mutation" },
    { headers: { Origin: "https://untrusted.example.test" }, status: 403 }
  );
  await api(`/api/forge/repositories/${repository.id}/issues`, "GET", undefined, {
    agent: fixture.sessions[1].token,
    status: 403,
  });
  const publicGraph = await api(
    `/api/git/repositories/${original.repository.id}/graph`,
    "GET",
    undefined,
    { anonymous: true }
  );
  assert.deepEqual(publicGraph.sessions, []);
  await api(`/api/auth/tokens/${writer.id}`, "DELETE");
  await assert.rejects(git(["ls-remote", remote], directory, writeAuth));
  await api(`/api/auth/tokens/${reader.id}`, "DELETE");
  await assert.rejects(git(["ls-remote", remote], directory, readAuth));
  const result = {
    outcome: "passed",
    repositoryId: repository.id,
    repositoryUrl: `${origin}/${fixture.identifier}/${repository.slug}`,
    checked: [
      "basic-auth",
      "binary-clone",
      "slash-branch",
      "annotated-tag",
      "read-token-push-denied",
      "anonymous-private-denied",
      "forged-trust-denied",
      "cross-origin-write-denied",
      "cross-repository-agent-denied",
      "anonymous-session-metadata-hidden",
      "revoked-token-denied",
    ],
  };
  await writeFile(path.join(directory, "boundaries.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}

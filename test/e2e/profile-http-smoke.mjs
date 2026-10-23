import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = process.env.GITEDGE_API || "http://127.0.0.1:8977";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));

const identifier = `verify-${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const secrets = [password];
let cookie = "";
function redact(value) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), value);
}

async function api(path, method = "GET", body, authenticated = true) {
  const headers = { "Content-Type": "application/json", Origin: origin };
  if (authenticated && cookie) headers.Cookie = cookie;
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("gitedge_session="));
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${redact(text)}`);
  return text ? JSON.parse(text).data : undefined;
}

try {
  const startedAt = Date.now();
  await api("/api/auth/register", "POST", { identifier, password }, false);
  const publicRepo = await api("/api/forge/repositories", "POST", {
    owner: identifier,
    slug: "public-profile-fixture",
    visibility: "public",
    description: "Public profile smoke fixture",
  });
  const privateRepo = await api("/api/forge/repositories", "POST", {
    owner: identifier,
    slug: "private-profile-fixture",
    visibility: "private",
    description: "Private profile smoke fixture",
  });
  await api(`/api/forge/repositories/${encodeURIComponent(publicRepo.id)}/star`, "PUT");
  await api(`/api/forge/repositories/${encodeURIComponent(privateRepo.id)}/star`, "PUT");
  await api(`/api/forge/repositories/${encodeURIComponent(publicRepo.id)}/issues`, "POST", {
    title: "Public profile activity fixture",
    body: "A public activity item for profile verification.",
  });
  await api(`/api/forge/repositories/${encodeURIComponent(privateRepo.id)}/issues`, "POST", {
    title: "Private profile activity fixture",
    body: "This must not appear on the public profile.",
  });

  const edited = await api("/api/auth/profile", "PATCH", {
    displayName: "Profile Smoke Fixture",
    bio: "Disposable profile verification",
    location: "Loopback",
    website: "https://example.invalid/profile-smoke",
  });
  assert.equal(edited.displayName, "Profile Smoke Fixture");

  const profile = await api(`/api/forge/profiles/${encodeURIComponent(identifier)}`, "GET", undefined, false);
  assert.equal(profile.owner, identifier);
  assert.equal(profile.displayName, "Profile Smoke Fixture");
  assert.equal(profile.bio, "Disposable profile verification");
  assert.equal(profile.location, "Loopback");
  assert.equal(profile.website, "https://example.invalid/profile-smoke");
  assert.ok(Number.isFinite(profile.joinedAt) && profile.joinedAt >= startedAt);
  assert.ok(profile.joinedAt < Date.now() + 5_000);
  assert.ok(profile.joinedAt > 1_000_000_000_000, "joinedAt should use milliseconds");
  assert.ok(profile.repositories.some((repository) => repository.id === publicRepo.id));
  assert.ok(profile.repositories.every((repository) => repository.visibility === "public"));
  assert.ok(
    profile.repositories.every((repository) => repository.slug !== "private-profile-fixture")
  );
  assert.ok(
    profile.starredRepositories.some((repository) => repository.id === publicRepo.id),
    "publicly starred repositories should appear"
  );
  assert.ok(
    profile.starredRepositories.every((repository) => repository.visibility === "public"),
    "private starred repositories must remain private"
  );
  assert.ok(
    profile.activity.some((item) => item.title === "Public profile activity fixture"),
    "public activity should appear"
  );
  assert.ok(
    profile.activity.every((item) => item.title !== "Private profile activity fixture"),
    "private activity must remain private"
  );
  console.log(
    `Anonymous profile smoke passed: ${origin}/${encodeURIComponent(identifier)} (public and private repo, star, and activity fixtures).`
  );
} catch (error) {
  throw new Error(redact(error instanceof Error ? error.message : String(error)));
} finally {
  cookie = "";
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";

const exec = promisify(execFile);
const keycloak = process.env.KEYCLOAK_DIR;
const cloudflared = process.env.CLOUDFLARED_PATH;
assert.ok(
  keycloak && cloudflared,
  "Set KEYCLOAK_DIR and CLOUDFLARED_PATH to official distributions."
);
const gateway = process.env.GITEDGE_API || "http://localhost:8877";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(gateway).hostname));
const runId = randomBytes(4).toString("hex");
const realm = `gitedge-verify-${runId}`;
const directory = path.resolve("work/full-verification", realm);
const authVars = path.resolve("workers/auth/.dev.vars");
const previousAuthVars = await readFile(authVars).catch(() => null);
assert.equal(
  previousAuthVars,
  null,
  "Move existing Auth local secrets aside before running this fixture."
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const username = "verification-user";
const password = randomBytes(24).toString("base64url");
const adminPassword = randomBytes(32).toString("base64url");
const clientSecret = randomBytes(32).toString("base64url");
const keycloakPort = Number(process.env.KEYCLOAK_PORT || "9888");
const proxyPort = Number(process.env.KEYCLOAK_PROXY_PORT || "9889");
const children = [];
let writtenAuthVars = null;
let stopping = false;
const proxy = createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (!pathname.startsWith(`/realms/${realm}/`) && !pathname.startsWith("/resources/")) {
    response.writeHead(404).end();
    return;
  }
  const headers = { ...request.headers, "x-forwarded-proto": "https", "x-forwarded-port": "443" };
  headers["x-forwarded-host"] = request.headers.host;
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: keycloakPort,
      path: request.url,
      method: request.method,
      headers,
    },
    (result) => {
      response.writeHead(result.statusCode || 502, result.headers);
      result.pipe(response);
    }
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  proxy.close();
  if (writtenAuthVars !== null) {
    const current = await readFile(authVars, "utf8").catch(() => null);
    if (current === writtenAuthVars) await unlink(authVars);
    else if (current !== null)
      console.warn("Auth local variables changed during verification and were preserved.");
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void stop().then(() => process.exit(0));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const tunnel = spawn(
    cloudflared,
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${proxyPort}`],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(tunnel);
  const tunnelOrigin = await new Promise((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => reject(new Error("Quick Tunnel did not become ready.")), 60_000);
    tunnel.stderr.on("data", (chunk) => {
      received += chunk.toString();
      const match = received.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    tunnel.once("error", reject);
    tunnel.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Quick Tunnel stopped before readiness."));
    });
  });
  const issuer = `${tunnelOrigin}/realms/${realm}`;
  const server = spawn(
    path.join(keycloak, "bin/kc.sh"),
    [
      "start-dev",
      "--http-host=127.0.0.1",
      `--http-port=${keycloakPort}`,
      `--hostname=${tunnelOrigin}`,
      "--proxy-headers=xforwarded",
      "--db=dev-file",
      `--db-url=jdbc:h2:file:${path.join(directory, "database")};NON_KEYWORDS=VALUE`,
    ],
    {
      env: {
        ...process.env,
        KC_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
        KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  children.push(server);
  const serverLog = [];
  const recordLog = (chunk) => {
    serverLog.push(chunk.toString());
    if (serverLog.length > 200) serverLog.shift();
  };
  server.stdout.on("data", recordLog);
  server.stderr.on("data", recordLog);
  let adminToken;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (server.exitCode !== null) {
      const diagnostic = serverLog
        .join("")
        .replaceAll(adminPassword, "[redacted]")
        .replaceAll(password, "[redacted]")
        .replaceAll(clientSecret, "[redacted]");
      await writeFile(path.join(directory, "keycloak.log"), diagnostic, { mode: 0o600 });
      throw new Error(
        `Keycloak exited with status ${server.exitCode}; inspect its private fixture log.`
      );
    }
    const result = await fetch(
      `http://127.0.0.1:${keycloakPort}/realms/master/protocol/openid-connect/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: "fixture-admin",
          password: adminPassword,
        }),
      }
    ).catch(() => null);
    if (result?.ok) {
      adminToken = (await result.json()).access_token;
      break;
    }
    await sleep(1000);
  }
  assert.ok(adminToken, "Keycloak admin initialization timed out.");
  async function admin(endpoint, method = "GET", body, type = "application/json") {
    const response = await fetch(`http://127.0.0.1:${keycloakPort}/admin${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": type },
      body:
        body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
    });
    assert.ok(response.ok, `Keycloak ${method} ${endpoint}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  await admin("/realms", "POST", {
    realm,
    enabled: true,
    registrationAllowed: false,
    resetPasswordAllowed: false,
    sslRequired: "external",
  });
  await admin(`/realms/${realm}/users`, "POST", {
    username,
    enabled: true,
    email: "verification@example.test",
    emailVerified: true,
    firstName: "Verification",
    lastName: "Fixture",
    requiredActions: [],
    credentials: [{ type: "password", value: password, temporary: false }],
  });
  await admin(`/realms/${realm}/clients`, "POST", {
    clientId: "gitedge-verify-oidc",
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    secret: clientSecret,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: [`${gateway}/api/auth/sso/verify-oidc/callback`],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": `${gateway}/api/auth/sso/verify-oidc/logout-callback`,
    },
    defaultClientScopes: ["profile", "email"],
  });
  const metadataResponse = await fetch(`${issuer}/protocol/saml/descriptor`);
  assert.ok(metadataResponse.ok, "SAML metadata must be reachable through the HTTPS tunnel.");
  const metadata = new DOMParser().parseFromString(
    await metadataResponse.text(),
    "application/xml"
  );
  const certificates = Array.from(
    metadata.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "X509Certificate")
  ).map(
    (element) =>
      `-----BEGIN CERTIFICATE-----\n${element.textContent.trim()}\n-----END CERTIFICATE-----`
  );
  assert.ok(certificates.length);
  const privateKeyPath = path.join(directory, "sp-key.pem"),
    certificatePath = path.join(directory, "sp-cert.pem");
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "2",
    "-subj",
    "/CN=GitEdge verification",
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
  ]);
  const privateKey = await readFile(privateKeyPath, "utf8"),
    signingCertificate = await readFile(certificatePath, "utf8");
  const providers = [
    {
      id: "verify-oidc",
      label: "Keycloak OIDC verification",
      protocol: "oidc",
      issuer,
      clientId: "gitedge-verify-oidc",
      tokenAuthMethod: "client_secret_basic",
    },
    {
      id: "verify-saml",
      label: "Keycloak SAML verification",
      protocol: "saml",
      issuer,
      entryPoint: `${issuer}/protocol/saml`,
      logoutUrl: `${issuer}/protocol/saml`,
      certificates,
      signingCertificate,
      signatureValidation: "both",
    },
  ];
  const secrets = { "verify-oidc": { clientSecret }, "verify-saml": { privateKey } };
  writtenAuthVars = `SSO_PROVIDERS_JSON='${JSON.stringify(providers)}'\nSSO_SECRETS_JSON='${JSON.stringify(secrets)}'\n`;
  await writeFile(authVars, writtenAuthVars, { mode: 0o600, flag: "wx" });
  console.log("Fixture providers written; restart the local Gateway to load Auth secrets.");
  let spMetadata;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${gateway}/api/auth/sso/verify-saml/metadata`).catch(() => null);
    if (response?.ok) {
      spMetadata = await response.text();
      break;
    }
    await sleep(1000);
  }
  assert.ok(spMetadata, "The local Gateway did not load the fixture providers.");
  const samlClient = await admin(
    `/realms/${realm}/client-description-converter`,
    "POST",
    spMetadata,
    "application/xml"
  );
  samlClient.attributes = {
    ...samlClient.attributes,
    "saml.server.signature": "true",
    "saml.assertion.signature": "true",
    "saml.signature.algorithm": "RSA_SHA256",
    saml_name_id_format: "persistent",
    saml_force_name_id_format: "true",
    "saml.force.post.binding": "true",
  };
  await admin(`/realms/${realm}/clients`, "POST", samlClient);
  assert.equal(
    (await fetch(`${tunnelOrigin}/admin/`)).status,
    404,
    "The admin service must remain inaccessible through the tunnel."
  );
  const fixture = {
    gateway,
    issuer,
    realm,
    username,
    password,
    providers: providers.map(({ id, label }) => ({ id, label })),
  };
  await writeFile(path.join(directory, "credentials.json"), JSON.stringify(fixture), {
    mode: 0o600,
  });
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      { gateway, issuer, realm, adminPublicStatus: 404, providers: fixture.providers },
      null,
      2
    )
  );
  console.log(`Keycloak fixture ready: ${directory}`);
  console.log("OIDC and SAML providers loaded; admin endpoints remain loopback-only.");
  await new Promise(() => {});
} catch (error) {
  await stop();
  console.error(error instanceof Error ? error.message : "Keycloak fixture failed.");
  process.exitCode = 1;
}

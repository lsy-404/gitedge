import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const origin = "https://gitedge.voidcarve.com";
const receiver = process.env.GITEDGE_WEBHOOK_RECEIVER;
const receiverWorker = process.env.GITEDGE_WEBHOOK_RECEIVER_NAME;
assert.ok(
  receiver && receiverWorker,
  "Configure the owned verification receiver URL and Worker name."
);
const identifier = `actions-check-${randomBytes(3).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const directory = `work/repository-controls/${identifier}`;
await mkdir(directory, { recursive: true });
let cookie = "";
const report = { identifier, runs: [] };
async function api(path, method = "GET", body, expected = 200) {
  const response = await fetch(origin + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const updated = response.headers.get("set-cookie");
  if (updated) cookie = updated.split(";")[0];
  const result = await response.json().catch(() => null);
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${result?.error?.code ?? response.status} ${result?.error?.message ?? ""}`
  );
  return result?.data;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 2000));
async function terminal(id) {
  for (let i = 0; i < 85; i++) {
    const run = await api(`/api/actions/runs/${id}`);
    if (run.status === "completed") return run;
    await pause();
  }
  throw new Error(`Action run exceeded verification timeout: ${id}`);
}
async function putReceiverSecret(secret) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "wrangler",
        "secret",
        "put",
        "WEBHOOK_SECRET",
        "--name",
        receiverWorker,
        "--config",
        "test/production-receiver/wrangler.jsonc",
      ],
      {
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "df4481f3ce1fa0394b4617442a97d147" },
        stdio: ["pipe", "ignore", "pipe"],
      }
    );
    let error = "";
    child.stderr.on("data", (chunk) => (error += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Receiver secret provisioning failed: " + error.replaceAll(secret, "[redacted]")
            )
          )
    );
    child.stdin.end(secret);
  });
}
try {
  await api("/api/auth/register", "POST", { identifier, password }, 201);
  await writeFile(`${directory}/fixture.json`, JSON.stringify({ identifier, password }, null, 2), {
    mode: 0o600,
  });
  const repo = await api(
    "/api/forge/repositories",
    "POST",
    {
      owner: identifier,
      slug: "container-verification",
      visibility: "private",
      initializeReadme: true,
      description: "Production Containers and signed webhook verification",
    },
    201
  );
  report.repositoryId = repo.id;
  report.artifactName = repo.artifactName;
  const git = `/api/git/repositories/${repo.id}`,
    forge = `/api/forge/repositories/${repo.id}`,
    actions = `/api/actions/repositories/${repo.id}`;
  let oid = (await api(git + "/branches"))[0].oid;
  const edit = async (path, content, branch = "main", newBranch) => {
    const result = await api(
      git + "/edit",
      "POST",
      {
        branch,
        newBranch,
        expectedOid: oid,
        path,
        content,
        message: "Prepare production verification",
      },
      201
    );
    oid = result.oid;
    return result;
  };
  const runs = {
    verify: `node -e "const fs=require('fs'); if(!fs.readFileSync('README.md','utf8').includes('#'))process.exit(3); console.log('CONTAINER_VERIFIED '+process.version)"`,
    failure: `echo EXPECTED_FAILURE; exit 7`,
    cancel: `echo READY_TO_CANCEL; sleep 90`,
    logs: `node -e "process.stdout.write('x'.repeat(30000))"`,
  };
  for (const [name, run] of Object.entries(runs))
    await edit(
      `.github/workflows/${name}.yml`,
      `name: ${name}\non:\n  workflow_dispatch:\njobs:\n  verify:\n    steps:\n      - name: ${name}\n        run: |\n          ${run}\n`
    );
  await edit("verification.txt", "Production container validation\n", "main", "verification");
  const headOid = oid;
  await api(forge + "/settings", "PATCH", { actionsEnabled: true });
  const pr = await api(
    forge + "/pull-requests",
    "POST",
    { title: "Container CI acceptance", baseRef: "main", headRef: "verification" },
    201
  );
  report.pullNumber = pr.number;
  const workflows = await api(actions + `/workflows?ref=verification&oid=${headOid}`);
  assert.equal(workflows.workflows.filter((w) => w.supported).length, 4);
  for (const name of ["verify", "failure", "logs", "cancel"]) {
    const queued = await api(
      actions + "/runs",
      "POST",
      { workflowPath: `.github/workflows/${name}.yml`, ref: "verification", expectedOid: headOid },
      202
    );
    report.runs.push({ name, id: queued.id });
    console.log(`Started ${name}: ${queued.id}`);
    if (name === "cancel") {
      let running = false;
      for (let i = 0; i < 60; i++) {
        const status = await api(`/api/actions/runs/${queued.id}`);
        if (status.jobs.some((j) => j.steps.some((s) => s.status === "running"))) {
          running = true;
          break;
        }
        if (status.status === "completed")
          throw new Error("Cancellation run ended before its step: " + JSON.stringify(status));
        await pause();
      }
      assert.ok(running);
      await api(`/api/actions/runs/${queued.id}/cancel`, "POST");
    }
    const finished = await terminal(queued.id);
    await writeFile(`${directory}/${name}.json`, JSON.stringify(finished, null, 2));
    const expected = name === "failure" ? "failure" : name === "cancel" ? "cancelled" : "success";
    assert.equal(finished.conclusion, expected, `${name} result: ${JSON.stringify(finished)}`);
    assert.ok(
      finished.jobs.every(
        (j) => j.status === "completed" && j.steps.every((s) => s.status === "completed")
      )
    );
    if (name === "verify")
      assert.ok(finished.jobs[0].steps[0].log.includes("CONTAINER_VERIFIED v24"));
    if (name === "failure") assert.equal(finished.jobs[0].steps[0].exitCode, 7);
    if (name === "logs") assert.equal(finished.outputTruncated, true);
    console.log(
      `${name}: ${finished.conclusion}${finished.outputTruncated ? " (log limit verified)" : ""}`
    );
  }
  const checks = await api(forge + `/pull-requests/${pr.number}/checks`);
  assert.ok(
    checks.some(
      (c) =>
        c.actor.kind === "ci" &&
        c.name === ".github/workflows/verify.yml" &&
        c.commitOid === headOid &&
        c.conclusion === "success"
    )
  );
  report.ciChecks = checks.map((c) => ({
    name: c.name,
    kind: c.actor.kind,
    commitOid: c.commitOid,
    conclusion: c.conclusion,
  }));
  console.log("System CI identity and exact-commit checks verified");
  const agent = await api(
    "/api/auth/agents",
    "POST",
    { handle: "reviewer", name: "Review runner" },
    201
  );
  report.agentId = agent.id;
  assert.equal(agent.profilePath, `/${identifier}/@reviewer`);
  const webhook = await api(
    `/api/auth/agents/${agent.id}/webhook`,
    "PUT",
    {
      url: receiver,
      events: ["agent.assigned", "agent.mentioned", "pull_request.updated"],
      enabled: true,
    },
    201
  );
  await putReceiverSecret(webhook.secret);
  const probe = await api(`/api/auth/agents/${agent.id}/webhook/test`, "POST");
  assert.equal(probe.responseStatus, 202);
  assert.equal(probe.status, "success");
  const issue = await api(
    forge + "/issues",
    "POST",
    { title: "Webhook assignment acceptance", body: "Verify signed assignment delivery" },
    201
  );
  await api(forge + `/issues/${issue.number}/assignees`, "PUT", {
    role: "assignee",
    assignees: [{ kind: "agent", id: agent.id }],
  });
  let delivery;
  for (let i = 0; i < 90; i++) {
    const entries = await api(`/api/auth/agents/${agent.id}/webhook/deliveries`);
    delivery = entries.find(
      (d) => d.id !== probe.id && d.event === "agent.assigned" && d.status === "success"
    );
    if (delivery) break;
    await pause();
  }
  assert.ok(delivery, "Scheduled signed assignment delivery did not complete");
  assert.equal(delivery.responseStatus, 202);
  report.webhookDelivery = delivery;
  console.log("Real HMAC test and scheduled assignment delivery verified");
  await api(`/api/auth/agents/${agent.id}/webhook`, "PUT", {
    url: receiver,
    events: ["agent.assigned"],
    enabled: false,
  });
  report.ok = true;
  await writeFile(
    `${directory}/fixture.json`,
    JSON.stringify({ identifier, password, repositoryId: repo.id, ...report }, null, 2),
    { mode: 0o600 }
  );
  await writeFile(`${directory}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await api("/api/auth/logout", "POST").catch(() => {});
  await writeFile(`${directory}/result.json`, JSON.stringify(report, null, 2));
}

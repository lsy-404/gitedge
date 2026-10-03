import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const origin = process.env.GITEDGE_API ?? "http://localhost:8898";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const directory = process.env.GITEDGE_FIXTURE;
assert.ok(directory, "Set GITEDGE_FIXTURE to the api-git acceptance directory.");
const credentials = JSON.parse(await readFile(path.join(directory, "credentials.json"), "utf8"));
async function api(endpoint, method = "GET", body) {
  const response = await fetch(new URL(endpoint, origin), {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: credentials.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
  return (await response.json()).data;
}
const repositories = await api("/api/forge/repositories");
const repository = repositories.find((item) => item.name === "workspace");
assert.ok(repository);
const source = path.join(directory, "source");
const exec = promisify(execFile);
async function git(args) {
  try {
    const result = await exec("git", args, {
      cwd: source,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credentials.credential.token}`,
      },
    });
    return result.stdout;
  } catch {
    throw new Error(`Fixture Git command failed: ${args[0]}`);
  }
}
await git(["pull", "--ff-only", "origin", "main"]);
for (const folder of ["docs", "src", "test", ".github"])
  await mkdir(path.join(source, folder), { recursive: true });
await writeFile(
  path.join(source, "README.md"),
  `# Edge Workspace\n\nA small Cloudflare Worker used to verify GitEdge's repository and collaboration interface.\n\n## Getting started\n\nClone this repository, install dependencies, and start the development server.\n\n\`\`\`sh\npnpm install\npnpm run dev\n\`\`\`\n\n## Project structure\n\n| Directory | Contents |\n| --- | --- |\n| src | Worker entrypoint and routing |\n| docs | Setup and deployment guides |\n| test | Request and response checks |\n\n### Collaboration checklist\n\n- [x] Isolated agent workspaces\n- [x] Commit-bound reviews and checks\n- [ ] Review the next release\n\nRead the [getting started guide](docs/getting-started.md) or open an issue to discuss a change.\n\n## Deployment\n\nThe repository includes a declarative deployment manifest. Open **Deployments** to review permissions and publish to your Cloudflare account.\n`
);
await writeFile(
  path.join(source, "src", "index.ts"),
  'export interface Env { ENVIRONMENT: string; }\n\nexport default {\n  async fetch(request: Request, env: Env): Promise<Response> {\n    const url = new URL(request.url);\n    if (url.pathname === "/health") {\n      return Response.json({ status: "ok", environment: env.ENVIRONMENT });\n    }\n    return new Response("Hello from the edge", {\n      headers: { "content-type": "text/plain; charset=utf-8" },\n    });\n  },\n};\n'
);
await writeFile(
  path.join(source, "docs", "getting-started.md"),
  "# Getting started\n\n## Local development\n\n```sh\npnpm install\npnpm run dev\n```\n\n> Keep deployment credentials out of repository files.\n"
);
await writeFile(
  path.join(source, "package.json"),
  JSON.stringify(
    {
      name: "edge-workspace",
      private: true,
      scripts: { dev: "wrangler dev", deploy: "wrangler deploy" },
    },
    null,
    2
  )
);
await writeFile(path.join(source, ".gitignore"), "node_modules/\n.wrangler/\n.dev.vars\n");
await writeFile(
  path.join(source, "LICENSE"),
  "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies.\n"
);
await writeFile(path.join(source, "test", "health.txt"), "GET /health -> 200\n");
await writeFile(
  path.join(source, ".github", "CONTRIBUTING.md"),
  "# Contributing\n\nOpen an issue, propose a focused pull request, and include verification.\n"
);
await git(["add", "."]);
if ((await git(["diff", "--cached", "--name-only"])).trim())
  await git([
    "-c",
    "user.name=Workspace Maintainer",
    "-c",
    "user.email=maintainer@example.invalid",
    "commit",
    "-m",
    "Document the worker and organize project files",
  ]);
await git(["push", "origin", "main"]);
await git(
  (await git(["branch", "--list", "feature/cache-policy"])).trim()
    ? ["checkout", "feature/cache-policy"]
    : ["checkout", "-b", "feature/cache-policy"]
);
await writeFile(
  path.join(source, "src", "cache.ts"),
  "export const cacheControl = 'public, max-age=60';\n"
);
await git(["add", "."]);
if ((await git(["diff", "--cached", "--name-only"])).trim())
  await git([
    "-c",
    "user.name=Workspace Maintainer",
    "-c",
    "user.email=maintainer@example.invalid",
    "commit",
    "-m",
    "Add explicit cache policy",
  ]);
await git(["push", "origin", "feature/cache-policy"]);
await git(["checkout", "main"]);
const pathPrefix = `/api/forge/repositories/${repository.id}`;
const existingIssues = await api(`${pathPrefix}/issues`);
for (const [title, labels, body] of [
  [
    "Preserve the selected branch when opening a file",
    ["bug", "navigation"],
    "## Expected behavior\n\nOpening a file keeps the current branch selected.\n\n### Steps\n1. Select a feature branch.\n2. Open a file.\n3. Return to the repository root.",
  ],
  [
    "Display CI results for the current revision",
    ["enhancement", "checks"],
    "Checks should remain bound to the exact commit under review.\n\n- [x] Include the commit SHA\n- [ ] Review the compact checks list",
  ],
  [
    "Improve keyboard navigation in the file browser",
    ["accessibility"],
    "Support predictable focus when changing branches and navigating directories.",
  ],
  [
    "Document repository deployment permissions",
    ["documentation"],
    "List required Cloudflare permissions in the deployment guide before entering credentials.",
  ],
])
  if (!existingIssues.some((issue) => issue.title === title))
    await api(`${pathPrefix}/issues`, "POST", { title, labels, body });
const existingPulls = await api(`${pathPrefix}/pull-requests`);
const pull =
  existingPulls.find((pull) => pull.headRef === "feature/cache-policy") ??
  (await api(`${pathPrefix}/pull-requests`, "POST", {
    title: "Add an explicit cache policy for public responses",
    body: "## Changes\n\nAdds a small, explicit cache policy module.\n\n## Verification\n\n- [x] Reviewed the response headers\n- [x] Confirmed the change remains isolated to this branch",
    baseRef: "main",
    headRef: "feature/cache-policy",
  }));
await api(`${pathPrefix}/pull-requests/${pull.number}/comments`, "POST", {
  body: "The policy is easy to review. Please keep private responses out of shared caches.",
});
await api(`${pathPrefix}/wiki/getting-started`, "PUT", {
  title: "Getting started",
  content:
    "# Getting started\n\n## Clone and run\n\n```sh\npnpm install\npnpm run dev\n```\n\n## Working together\n\nUse Issues for tasks and Pull Requests for reviewed changes.",
});
await api(`${pathPrefix}/discussions`, "POST", {
  title: "How should we organize preview environments?",
  body: "Let's compare a preview per branch with a preview per pull request.\n\nWhat should the default retention period be?",
  category: "q-and-a",
});
const empty =
  repositories.find((repo) => repo.name === "new-project") ??
  (await api("/api/forge/repositories", "POST", {
    owner: credentials.identifier,
    slug: "new-project",
    description: "Empty-repository onboarding verification",
    visibility: "private",
  }));
await writeFile(
  path.join(directory, "ui-result.json"),
  JSON.stringify(
    {
      repository,
      emptyRepository: empty,
      pullNumber: pull.number,
      repositoryUrl: `${origin}/${repository.owner}/${repository.name}`,
    },
    null,
    2
  ),
  { mode: 0o600 }
);
console.log(
  JSON.stringify({
    repositoryUrl: `${origin}/${repository.owner}/${repository.name}`,
    pullNumber: pull.number,
    emptyRepository: empty.name,
  })
);

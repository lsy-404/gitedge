# GitEdge Actions

GitEdge runs a deliberately small workflow language in a per-run Cloudflare Container. Workflows can use `.gitedge/workflows/*.yml` for GitEdge-native files or `.github/workflows/*.yml` for the supported GitHub syntax subset. If a commit contains any native files, GitEdge selects that directory and ignores `.github/workflows` for the same commit.

The parser accepts `name`, `on`, `jobs`, a top-level `cache`, job `name`, `steps`, job `artifacts`, and step `name`, `run`, `shell`, `working-directory`, and literal `env`. Supported triggers are `push`, `workflow_dispatch`, `pull_request`, and `merge_group`. `push` and `pull_request` accept `branches` and `branches-ignore` filters. It does not implement arbitrary GitHub Actions, `uses`, `${{ }}` expressions, conditions, matrices, dependent jobs, composite actions, secrets contexts, or the wider GitHub workflow schema. Unsupported syntax appears with an explanation and the run is refused.

```yaml
name: Verify
on:
  push:
    branches: [main]
  workflow_dispatch:
cache:
  keyFiles: [pnpm-lock.yaml]
  paths: [.pnpm-store]
jobs:
  test:
    steps:
      - name: Install
        run: pnpm install --frozen-lockfile
        env:
          npm_config_store_dir: .pnpm-store
      - name: Test
        run: pnpm run test
    artifacts:
      - name: web-dist
        paths: [dist]
```

Copyable starter templates are in the Actions page: GitEdge self-check, Node and pnpm, Python, and static site validation. Copy a template into `.gitedge/workflows/<name>.yml` and commit it. The self-check checks the container runtimes, migration numbering, and the Actions image definition without installing the full monorepo's dependencies.

The deployed image is built from [`workers/actions/Dockerfile`](../workers/actions/Dockerfile). Cloudflare documents its managed `cloudflare/debian-trixie` image as Node.js 24.20 on Debian Trixie; this project builds a named image from the Node 24.20 Trixie image and installs pnpm 10.34.6, Python 3, Git, Bash, and tar explicitly. Jobs run as an unprivileged user. Network access stays disabled unless a repository administrator enables it. Package installation templates need that repository setting enabled.

Each run receives only regular files from the selected commit. Symbolic links, gitlinks, invalid paths, and duplicate paths are refused. The snapshot is limited to 2,048 files and 24 MiB; workflows are limited to 64 KiB, three jobs, and ten steps per job. A run has ten minutes and six-run-per-repository-per-hour limits. Logs are capped at 16 KiB per run.

The top-level `cache` declares lockfiles and workspace paths. Cache identity includes repository, trigger partition, exact source ref, workflow path, and SHA-256 hashes of the declared lockfiles. Pull-request and merge-group cache partitions do not share entries with branch runs. Entries are tar archives capped at 24 MiB; paths with symlinks are rejected on save and restore. Five cache entries are retained per repository, evicting the least recently used. Missing lockfiles skip cache use.

Job `artifacts` are tar.gz downloads. Each declaration has a unique name and one or more relative workspace paths. Symlinks and non-regular files are rejected; combined archived output is capped at 24 MiB and 2,048 files. The Actions Worker streams archives through bounded Durable Object chunks to the existing `gitedge-release-assets` bucket under `actions/` prefixes. Downloads require repository read access. Repository purge removes those cache and artifact objects.

GitEdge Pages publishes static files directly from a public repository branch and folder. It does not provision Cloudflare Pages projects or require Cloudflare Pages credentials. The Pages settings show whether the selected branch is available, the current source commit, the last recorded push, and the site link. Use a static-site template to validate a folder, then configure Pages to serve that committed folder.

export const ACTION_WORKFLOW_TEMPLATES = {
  nodePnpm: `name: Node and pnpm
on:
  push:
  workflow_dispatch:
cache:
  keyFiles:
    - pnpm-lock.yaml
  paths:
    - .pnpm-store
jobs:
  verify:
    name: Install and verify
    steps:
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
        env:
          npm_config_store_dir: .pnpm-store
      - name: Run checks
        run: pnpm run test
`,
  python: `name: Python verification
on:
  push:
  workflow_dispatch:
cache:
  keyFiles:
    - requirements.txt
  paths:
    - .cache/pip
jobs:
  verify:
    steps:
      - name: Install dependencies
        run: python3 -m venv .venv && .venv/bin/pip install --cache-dir .cache/pip -r requirements.txt
      - name: Run tests
        run: .venv/bin/python -m pytest
`,
  staticSite: `name: Static site validation
on:
  push:
  workflow_dispatch:
jobs:
  validate:
    steps:
      - name: Check site entry point
        run: test -f public/index.html
      - name: Check static assets
        run: find public -type f -print
    artifacts:
      - name: static-site
        paths:
          - public
`,
  gitedgeSelfValidation: `name: GitEdge verification
on:
  push:
  pull_request:
  merge_group:
  workflow_dispatch:
cache:
  keyFiles:
    - pnpm-lock.yaml
    - apps/web/pnpm-lock.yaml
  paths:
    - .pnpm-store
jobs:
  verify:
    steps:
      - name: Install dependencies
        run: pnpm --store-dir /workspace/.pnpm-store install --frozen-lockfile && pnpm --dir apps/web --store-dir /workspace/.pnpm-store install --frozen-lockfile
      - name: Check migrations
        run: pnpm run check:migrations
      - name: Check types
        run: pnpm run typecheck
      - name: Unit tests
        run: pnpm run test
      - name: Worker tests
        run: pnpm run test:workers
      - name: Web tests
        run: pnpm run test:web
      - name: Build web application
        run: pnpm run build:web
      - name: Check formatting
        run: pnpm run format:check
    artifacts:
      - name: web-build
        paths:
          - apps/web/dist
`,
} as const;

export type ActionWorkflowTemplate = keyof typeof ACTION_WORKFLOW_TEMPLATES;

# Runner service entry

## Scope
Add the account Runner repository entry to the existing account Runners view, preserving the runner machine overview. The view provisions one private account Runner through Forge and links to code, workflow editing, Actions and repository settings. Runner repository identity and metadata remain locked in the UI while normal Git content stays editable.

## Constraints
- Forge owns `GET /api/forge/account-runner` (`data.repository: Repository | null`) and `POST /api/forge/account-runner` (`data: Repository`). The repository may expose `systemKind: "account_runner"`.
- Keep English and Chinese strings, Fluent controls, and existing repository file and Actions routes.
- Do not imply always-on daemons or completed signing migration.
- Do not edit `agents/project.md` or `agents/tasks.md`.

## Validation approach
Exercise the real clickable path through the existing API and repository routes in UI tests, including provisioning, returning-owner state and loading/error states. Run targeted UI tests and web typecheck if available.

## Findings and constraints
- Runner configuration uses existing `.github/workflows` editing and the repository Actions page for manual dispatch and results. The task scope is on-demand workflow services.
- Keep the existing machine overview intact and distinguish it from the account's private workflow repository.
- Repository settings checks `systemKind`; the special settings view locks repository metadata and links back to editable code/workflows and Actions.
- Account Runner native self-hosted workflows can declare up to five five-field UTC cron schedules. Actions shows the expressions, default-branch behavior and queued-run coalescing. The manual dispatch and results panel remains the existing repository Actions page.
- [Initial test command] -> root Vitest config excludes browser UI tests -> ran the same files through `apps/web/vitest.config.ts`.
- [Post-create navigation assertion] -> test router harness retained its synthetic route after a real route push -> assert the requested canonical Actions URL through the router call instead.

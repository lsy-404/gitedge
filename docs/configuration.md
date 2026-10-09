# Configuration

Each Worker reads its settings from `workers/<worker>/wrangler.jsonc` (variables) and Wrangler secrets. For local development, put secrets in that Worker's ignored `.dev.vars` file. Set a production secret with:

```sh
pnpm exec wrangler secret put <NAME> --config workers/<worker>/wrangler.jsonc
```

## Auth

| Name                     | Kind    | Default                  | Purpose                                                                                                                  |
| ------------------------ | ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_CLIENT_ID`       | secret  | none                     | GitHub OAuth application client ID. GitHub sign-in is unavailable without it.                                            |
| `GITHUB_CLIENT_SECRET`   | secret  | none                     | GitHub OAuth application client secret.                                                                                  |
| `WEBHOOK_ENCRYPTION_KEY` | secret  | none                     | Base64-encoded 32-byte key that encrypts agent webhook signing secrets.                                                  |
| `SSO_SECRETS_JSON`       | secret  | none                     | Client secrets for configured SSO providers. See [SSO configuration](sso.md).                                            |
| `GITHUB_OAUTH_BASE`      | var     | `https://github.com`     | GitHub OAuth origin; override only for GitHub Enterprise or test doubles.                                                |
| `GITHUB_API_BASE`        | var     | `https://api.github.com` | GitHub API origin; override only for GitHub Enterprise or test doubles.                                                  |
| `ALLOW_PUBLIC_SIGNUP`    | var     | none (`true` shipped)    | Public registration is open only when the value is exactly `true`.                                                       |
| `DEFAULT_USER_GROUP`     | var     | none (`free` shipped)    | Required. User group for new accounts; SSO identity creation alone falls back to `free`.                                 |
| `TOTP_ENCRYPTION_KEY`    | secret  | none                     | Base64-encoded 32-byte key that encrypts authenticator-app secrets. Authenticator apps are unavailable without it.       |
| `PUBLIC_ORIGIN`          | var     | the request origin       | Public origin used in emailed links and as the passkey relying party (`https://git.example.com`).                        |
| `EMAIL_FROM`             | var     | none                     | Sender address on a domain onboarded to Cloudflare Email Service. Required with the `EMAIL` binding.                     |
| `EMAIL`                  | binding | none                     | Optional `send_email` binding. Enables email verification and emailed password reset; both are hidden when it is absent. |
| `LOG_LEVEL`              | var     | logger default           | Minimum structured log level.                                                                                            |
| `SSO_PROVIDERS_JSON`     | var     | none                     | Provider list. See [SSO configuration](sso.md).                                                                          |
| `SITE_ADMINS`            | var     | empty                    | Comma-separated usernames that are always site administrators. See [Site administration](#site-administration).          |
| `USER_GROUP_LIMITS_JSON` | var     | built-in groups          | Same value as on the Gateway and Forge; the groups an administrator can assign.                                          |

Generate the webhook key with `openssl rand -base64 32`. Agent webhooks return an error while it is missing.

### Account security

Generate the authenticator key with `openssl rand -base64 32` and store it with `wrangler secret put TOTP_ENCRYPTION_KEY`. Keep the key stable: enrolled authenticator secrets are encrypted with it, so replacing or removing it makes every enrolled authenticator code fail until the original key is restored. Set `PUBLIC_ORIGIN` when the public hostname differs from the Worker's request host, because the WebAuthn relying party ID is that hostname. Changing that hostname invalidates registered passkeys.

Email is optional and ships disabled. To enable it, onboard a sending domain (`pnpm exec wrangler email sending enable <domain>`), then add the binding to `workers/auth/wrangler.jsonc` and `EMAIL_FROM` to its existing `vars` object:

```jsonc
"send_email": [{ "name": "EMAIL" }],
"vars": { /* existing vars */ "EMAIL_FROM": "no-reply@<domain>" }
```

See the [Email Service Workers binding](https://developers.cloudflare.com/email-service/) documentation. See [account security](account-security.md) for behavior.

### Site administration

`SITE_ADMINS` lists the usernames that can open `/admin` and call `/api/auth/admin/*` (for example `"alice, bob"`). It is the way to appoint the first administrator; administrators can then grant or revoke the stored administrator flag for other users from the Users tab, and administrators named in `SITE_ADMINS` cannot be demoted there. Group assignment accepts the keys of `USER_GROUP_LIMITS_JSON` (the built-in `free`, `team` and `admin` plus your overrides), so set it on Auth to the same value as on the Gateway and Forge when you define custom groups. Administrator mutations require a password or second-factor confirmation from the last 10 minutes. Site administrators cannot be disabled until their administrator access is removed. Disabling a user revokes their browser and agent sessions and makes their tokens and Git credentials fail validation until the account is enabled again.

### GitHub OAuth

Create a GitHub OAuth application and register the callback URL `https://<gateway-host>/api/auth/github/callback`, where `<gateway-host>` is the public Gateway origin. Store the client ID and secret with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. GitHub is used for identity only; repository access is never requested.

## Deploy

| Name                 | Kind   | Default            | Purpose                                                                                            |
| -------------------- | ------ | ------------------ | -------------------------------------------------------------------------------------------------- |
| `DEPLOY_SESSION_KEY` | secret | none               | Random value of at least 32 characters that encrypts the short-lived Cloudflare credential cookie. |
| `DEPLOY_ORIGIN`      | var    | the request origin | Origin that browser writes to Deploy must come from; set it when the public origin differs.        |

## Gateway

| Name                          | Kind | Default                        | Purpose                                                                                                                        |
| ----------------------------- | ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `IP_RPM_LIMIT`                | var  | `300`                          | Requests per minute per client address (IPv6 clients are keyed by /64 prefix).                                                 |
| `PRIVATE_REPOSITORY_RESPONSE` | var  | `not_found`                    | `not_found` or `forbidden`; see the README.                                                                                    |
| `USER_GROUP_LIMITS_JSON`      | var  | built-in `free`/`team`/`admin` | Optional per-group overrides. Set the same value on Forge, because Gateway enforces `rpm` and Forge enforces the other limits. |

## Forge

| Name                     | Kind       | Default                         | Purpose                                                                                                                                                                                                   |
| ------------------------ | ---------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USER_GROUP_LIMITS_JSON` | var        | built-in `free`/`team`/`admin`  | Same value as on the Gateway; see the Gateway table.                                                                                                                                                      |
| `RELEASE_ASSETS`         | R2 binding | bucket `gitedge-release-assets` | Stores release assets under `<repositoryId>/<assetId>`. `pnpm run deploy` creates the bucket when it is missing; create it manually before a manual `wrangler deploy`. Local `wrangler dev` simulates it. |
| `WEBHOOK_ENCRYPTION_KEY` | secret     | none                            | Same key as on Auth; encrypts repository webhook secrets. Webhooks need it.                                                                                                                               |
| `LOG_LEVEL`              | var        | logger default                  | Minimum structured log level.                                                                                                                                                                             |

Forge runs two cron triggers: every 15 minutes for repository purges and retention, and every minute to retry webhook deliveries. Use the same `WEBHOOK_ENCRYPTION_KEY` on Auth and Forge; replacing it makes existing webhook secrets undecryptable until they are rotated. Forge sets `global_fetch_strictly_public` so webhook requests can never reach private addresses.

## Git

| Name        | Kind | Default | Purpose                       |
| ----------- | ---- | ------- | ----------------------------- |
| `LOG_LEVEL` | var  | `info`  | Minimum structured log level. |

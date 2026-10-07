# Configuration

Each Worker reads its settings from `workers/<worker>/wrangler.jsonc` (variables) and Wrangler secrets. For local development, put secrets in that Worker's ignored `.dev.vars` file. Set a production secret with:

```sh
pnpm exec wrangler secret put <NAME> --config workers/<worker>/wrangler.jsonc
```

## Auth

| Name                     | Kind   | Default                  | Purpose                                                                                  |
| ------------------------ | ------ | ------------------------ | ---------------------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`       | secret | none                     | GitHub OAuth application client ID. GitHub sign-in is unavailable without it.            |
| `GITHUB_CLIENT_SECRET`   | secret | none                     | GitHub OAuth application client secret.                                                  |
| `WEBHOOK_ENCRYPTION_KEY` | secret | none                     | Base64-encoded 32-byte key that encrypts agent webhook signing secrets.                  |
| `SSO_SECRETS_JSON`       | secret | none                     | Client secrets for configured SSO providers. See [SSO configuration](sso.md).            |
| `GITHUB_OAUTH_BASE`      | var    | `https://github.com`     | GitHub OAuth origin; override only for GitHub Enterprise or test doubles.                |
| `GITHUB_API_BASE`        | var    | `https://api.github.com` | GitHub API origin; override only for GitHub Enterprise or test doubles.                  |
| `ALLOW_PUBLIC_SIGNUP`    | var    | none (`true` shipped)    | Public registration is open only when the value is exactly `true`.                       |
| `DEFAULT_USER_GROUP`     | var    | none (`free` shipped)    | Required. User group for new accounts; SSO identity creation alone falls back to `free`. |
| `LOG_LEVEL`              | var    | logger default           | Minimum structured log level.                                                            |
| `SSO_PROVIDERS_JSON`     | var    | none                     | Provider list. See [SSO configuration](sso.md).                                          |

Generate the webhook key with `openssl rand -base64 32`. Agent webhooks return an error while it is missing.

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

| Name                     | Kind | Default                        | Purpose                                              |
| ------------------------ | ---- | ------------------------------ | ---------------------------------------------------- |
| `USER_GROUP_LIMITS_JSON` | var  | built-in `free`/`team`/`admin` | Same value as on the Gateway; see the Gateway table. |

## Git

| Name        | Kind | Default | Purpose                       |
| ----------- | ---- | ------- | ----------------------------- |
| `LOG_LEVEL` | var  | `info`  | Minimum structured log level. |

# Account security

Auth owns recovery, second factors and re-authentication. All state is in D1 (`migrations/0023_account_security.sql`).

## Recovery codes

Ten single-use codes (`xxxxx-xxxxx`). Only SHA-256 hashes bound to the user are stored; plaintext is shown once, when the first second factor is enabled or when codes are regenerated. Regeneration replaces every earlier code. A code is spent atomically, so a replay fails.

"Forgot password" accepts a username and an unused code, sets the new password and revokes every session. Wrong usernames and wrong codes return the same response, and attempts are rate limited per account and per client address. Accounts without a password (SSO or GitHub only) cannot use it.

## Email

An account may add one email. A verification link (24 hours, single use, hashed at rest) must be opened before the address counts. Addresses verified by another account get no email and the same response. When the optional `EMAIL` binding is configured (see [configuration](configuration.md#account-security)), "Forgot password" also offers an emailed reset link: 30 minutes, single use, hashed at rest. The request always answers 202 whether or not an account matches. Without the binding the UI hides email features and the endpoints answer 503. If the account has two-step verification, the reset also requires an authenticator or recovery code.

## Two-step verification

Authenticator apps use RFC 6238 (SHA-1, 6 digits, 30 s, plus or minus one step) through `otpauth`; the matched time step is stored so a code, or any earlier one, cannot be reused. Secrets are AES-GCM encrypted with `TOTP_ENCRYPTION_KEY`. Enrollment shows a QR code and confirms with a code. Disabling needs the account password and a current code.

Passkeys use `@simplewebauthn/server`; the relying party ID is the hostname of `PUBLIC_ORIGIN` (or the request origin). They work for passwordless sign-in (user verification required) and as a second factor after the password. Credentials can be renamed and removed.

Two-step verification is on when an authenticator app or any passkey exists. Password sign-in then returns an `mfaToken` valid for five minutes and five attempts; it is spent on success. Accepted factors are an authenticator code, a passkey assertion or a recovery code.

GitHub and SSO sign-ins are not challenged by GitEdge; their identity provider enforces multi-factor policy (see [SSO](sso.md#account-and-verification-behavior)).

## Re-authentication

Each session stores `recent_auth_at`, set at sign-in and refreshed by `POST /api/auth/reauth` with a password, authenticator code, recovery code or passkey. For 10 minutes (`RECENT_AUTH_WINDOW_MS`) the session may change the password, email, authenticator app, passkeys and recovery codes. Otherwise those routes answer 403 `reauth_required`. Changing the password keeps only the current session.

### Using the claim from other services

Auth's `/session` returns `recentAuthAt` and the Gateway forwards it as the trusted header `X-GitEdge-Recent-Auth` (stripped from inbound requests). Services read it with `readTrustedUser(request).recentAuthAt` and gate sensitive actions with `hasRecentAuth(user.recentAuthAt)` from `packages/contracts`; agent sessions never carry it. To let a user satisfy a failed check, respond 403 with code `reauth_required`; the web client then offers the confirmation form.

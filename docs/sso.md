# Single sign-on

GitEdge supports multiple OIDC and SAML 2.0 identity providers alongside password login and identity-only GitHub OAuth login. GitHub requests no scopes and stores only the numeric account ID, login, avatar and profile URL. Configure providers on the Auth Worker; accounts can link and unlink identities in Account settings. Provider configuration is operator-managed, so a browser cannot supply an arbitrary issuer or signing key.

## Configuration

Set `SSO_PROVIDERS_JSON` to a JSON array in the Auth Worker's variables. Put credentials in a separate `SSO_SECRETS_JSON` Worker secret keyed by provider ID:

```sh
pnpm exec wrangler secret put SSO_SECRETS_JSON --config workers/auth/wrangler.jsonc
```

For local development, put these values in ignored `workers/auth/.dev.vars`. Keep secrets out of `wrangler.jsonc`, Git remotes, source and logs. Use the canonical public Gateway origin when registering callback URLs at the provider. Issuers and provider endpoints require HTTPS; OIDC callback URLs also allow HTTP loopback for local development.

Example provider configuration:

```json
[
  {
    "id": "workforce",
    "label": "Company account",
    "protocol": "oidc",
    "issuer": "https://identity.example.com/realms/company",
    "clientId": "gitedge",
    "scopes": ["openid", "profile", "email"],
    "tokenAuthMethod": "client_secret_basic",
    "allowSignup": true
  }
]
```

The corresponding secret is an object such as `{"workforce":{"clientSecret":"<provider-issued-secret>"}}`. `allowSignup: false` permits established identities and explicit account linking while rejecting automatic creation of new accounts.

`ALLOW_PUBLIC_SIGNUP=false` also blocks automatic account creation through GitHub sign-in; identities that are already linked can still sign in.

Provider IDs must remain stable. Changing an issuer does not silently transfer an existing identity to the replacement provider. GitEdge identifies accounts by provider ID, issuer and subject, never by matching email addresses. Linking requires both an existing GitEdge session and successful authentication with the new provider.

## Voidcarve Access

The `https://id.voidcarve.com` OIDC issuer is configured as an ordinary provider. In the Auth Worker variable `SSO_PROVIDERS_JSON` add:

```json
{
  "id": "voidcarve",
  "label": "Voidcarve Access",
  "protocol": "oidc",
  "issuer": "https://id.voidcarve.com",
  "clientId": "<client-id-registered-at-the-issuer>",
  "scopes": ["openid", "profile", "email"],
  "tokenAuthMethod": "client_secret_basic",
  "allowSignup": true
}
```

Store the client secret in `SSO_SECRETS_JSON` as `{"voidcarve":{"clientSecret":"<secret>"}}` with `wrangler secret put SSO_SECRETS_JSON --config workers/auth/wrangler.jsonc`. At id.voidcarve.com register the redirect URI `https://gitedge.voidcarve.com/api/auth/sso/voidcarve/callback`. Client authentication defaults to `client_secret_basic`; the issuer advertises RS256 ID tokens, S256 PKCE and the `iss` response parameter, all of which are enforced by the standard code-flow library. Request `openid profile email` (not `offline_access`); the email claim is stored with the identity and is never used to match accounts. No picture claim is provided. Sign-in starts at `/api/auth/sso/voidcarve/start`. New accounts get an `sso-` identifier unrelated to profile claims; the issuer subject is the only identity key.

## OIDC

Register these URLs, replacing the host and provider ID:

- Login callback: `https://git.example.com/api/auth/sso/workforce/callback`
- Post-logout callback: `https://git.example.com/api/auth/sso/workforce/logout-callback`

Use Authorization Code flow. GitEdge sends S256 PKCE, state and nonce, and validates ID token signatures through the issuer's JWKS together with issuer, audience, expiry and nonce. Query and `form_post` callbacks are supported. Client authentication supports `client_secret_basic`, `client_secret_post` and public clients (`none`). Access and refresh tokens are not persisted.

Keycloak, Authentik, Microsoft Entra ID and other standards-compliant providers use their advertised issuer discovery URL. For Microsoft, use the intended tenant's issuer rather than a multi-tenant alias whose returned issuer differs. Google can use its OIDC issuer. Each provider still needs an application registration with the matching client ID, authentication method and callback URLs.

Single sign-out uses the discovered `end_session_endpoint` with `client_id`, state and a registered post-logout redirect. GitEdge does not retain an ID token hint, so a provider may show its own logout confirmation. Providers without that endpoint receive a local GitEdge logout only.

## SAML 2.0

A SAML provider entry uses these fields:

```json
{
  "id": "enterprise",
  "label": "Enterprise SSO",
  "protocol": "saml",
  "issuer": "https://identity.example.com/saml/entity",
  "entryPoint": "https://identity.example.com/saml/sso",
  "entityId": "https://git.example.com/api/auth/sso/enterprise/callback",
  "certificates": ["<PEM IdP signing certificate>"],
  "signatureValidation": "both",
  "allowSignup": true
}
```

Import the SP metadata from `https://git.example.com/api/auth/sso/enterprise/metadata` into the IdP. The ACS URL is `https://git.example.com/api/auth/sso/enterprise/callback`; the default SP entity ID is that ACS URL unless `entityId` is specified. Configure a stable NameID, such as a persistent identifier. Transient NameIDs are rejected.

GitEdge initiates login with the HTTP-Redirect binding and receives assertions through HTTP-POST. Responses must match the one-time request, issuer, audience, destination, bearer recipient and validity window. `signatureValidation` can be `both`, `assertion` or `response`; the default requires signatures on both. SHA-1 signatures and unsigned authentication are rejected. The `certificates` array permits up to five trusted IdP signing certificates for rotation.

To sign SP requests, set public `signingCertificate` and secret `privateKey` together. For encrypted assertions, set public `decryptionCertificate` and secret `decryptionKey` together. The secret values live under the provider ID in `SSO_SECRETS_JSON`, alongside any OIDC client credentials. Encrypted assertions support AES and RSA-OAEP, including its standard default OAEP digest; message signatures still require SHA-256 or SHA-512. RSA v1.5 key transport is rejected.

To enable SP-initiated Single Logout, configure the IdP's `logoutUrl` and the SP signing key/certificate pair. The SP logout callback is `https://git.example.com/api/auth/sso/enterprise/logout-callback` and appears in SP metadata. Logout responses must be signed and match the issued request. Local sessions are ended before redirecting to the provider.

## Account and verification behavior

The callback is bound to a short-lived HttpOnly browser cookie and a single-use D1 record. SAML POST callbacks use a Secure, SameSite=None flow cookie. An expired, replayed or mismatched callback cannot create a session. If the browser blocks that cookie, start the flow again in the same browser context.

The last configured login method cannot be unlinked. Existing repositories, namespace ownership and agent accounts remain attached to the same local account when an identity is explicitly linked. SAML emails are treated as profile data, not as verified account-linking evidence.

Signed SAML logout requests from the IdP are accepted through POST and Redirect bindings at the logout callback. They invalidate only sessions matching the configured provider, subject and supplied SessionIndexes, consume the request once, and return a signed response to the configured IdP logout endpoint. Unrelated account sessions and pending login/logout browser flows remain intact.

Identity-provider-initiated SAML login, OIDC back-channel logout notifications, SCIM provisioning and group-to-repository permission mapping are not implemented. Identity authentication does not grant organization membership or administrative access. Use explicit GitEdge memberships and account groups.

Protocol tests use real signed JWT/XML fixtures inside Node and Cloudflare Workers, with D1 coverage for identity binding, browser proof, replay, expiry and concurrent unlinking. A production IdP still requires tenant configuration and a live login/logout acceptance test before being enabled for users.

## Live acceptance with Keycloak

Use an isolated Keycloak distribution and the official `cloudflared` binary to exercise both protocols against a real IdP. The fixture only exposes its synthetic test realm and static login resources through a temporary HTTPS tunnel; administrative endpoints remain on loopback. It writes temporary Auth configuration only when `workers/auth/.dev.vars` does not already exist.

```sh
KEYCLOAK_DIR=/absolute/path/to/keycloak CLOUDFLARED_PATH=/absolute/path/to/cloudflared node test/e2e/keycloak-fixture.mjs
```

After the fixture reports that provider configuration was written, start or restart `pnpm run dev` in a second terminal. Wait for fixture readiness, then use the generated private `credentials.json` under ignored `work/full-verification/` to test account linking, both login methods and both single sign-out methods. Test an OIDC logout after using the SAML client in the same IdP session to exercise the signed logout notification. Stop the fixture with Ctrl+C after acceptance; this removes its temporary Auth variables and stops its IdP and tunnel. The fixture creates only synthetic accounts; never reuse production passwords or realm data.

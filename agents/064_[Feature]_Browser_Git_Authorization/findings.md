# Findings

GCM 2.6.1 sends S256 PKCE and uses a loopback redirect. The OAuth server library checks PKCE, grant semantics, and prevents refresh scope expansion before consuming the refresh token. D1 conditional mutation prevents concurrent use of the same authorization code or refresh token.

Deleting the old refresh before saving the new token temporarily hid expired access records from quota counting. A consumed marker keeps the authorization counted during rotation; the successful replacement insert and old-row deletion share a D1 batch. Failed rotation keeps the consumed record until expiry or explicit authorization revocation.

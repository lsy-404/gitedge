# Findings

- The machine route rebuilds the trusted signing context from the current runner lease row for each operation. It checks `grant.expiresAt <= context.leaseExpiresAt`, but the authorize response omits that context snapshot.
- The SDK separately tracks `currentLeaseExpiresAt` from SDK heartbeat responses. The parent broker renews the same runner lease independently, so the SDK's last heartbeat snapshot can lag the lease used by the authorize route.
- A grant valid under the authoritative route snapshot can therefore be rejected locally as `INVALID_RESPONSE`; the Mac credential release boundary reports the wrapped failure as `SIGNING_FAILED`.
- Preserve server-side expiry bounds. Return the exact authorize route snapshot and compare against that value in the SDK; no heartbeat behavior or credential scope changes are needed.
# Findings

- The server constructs signing machine context from the current persisted lease, and caps each request-scoped credential grant to that lease. The SDK previously compared the grant against its own heartbeat snapshot, which can lag when the parent broker renews independently.
- Returning the authoritative lease snapshot alongside the credential grant lets the SDK enforce the same server-side cap without weakening grant lifetime checks. Missing or malformed snapshots remain invalid responses.

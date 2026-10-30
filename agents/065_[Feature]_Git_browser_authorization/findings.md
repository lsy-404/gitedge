# Findings
- Existing router preserves protected routes through the login redirect.
- Authorization uses standard snake_case parameters and the existing recent-auth flow.
- GCM generic OAuth accepts host-relative endpoints and defaults to a loopback redirect. Double-quoted commands work in Windows and POSIX shells.
- Existing account-settings test navigation fails on Windows because Vitest resolves /logo.svg to an invalid file URL; the focused authorization tests pass.
- Browser authorization may retain a usable refresh grant after its access token expires, so expired unrevoked entries must remain revocable.

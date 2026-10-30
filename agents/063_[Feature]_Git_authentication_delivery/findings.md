# Findings
- Browser login question -> inspected existing Auth/Gateway and GCM 2.6.1 documentation -> GCM supports configured Generic OAuth, while GitEdge currently lacks an authorization-server interface.
- Existing original checkout -> inspected status/worktrees -> unrelated runner changes are present; use clean isolated worktrees.
- Main protection -> GitHub branch API -> protected=false; main and origin/main start at the same commit.
- Refresh quota -> concurrent review found a delete-before-insert count gap -> consumed refresh records retain quota until their replacement is inserted; concurrent tests pass.
- Real GCM -> ran test/e2e/auth-http-host.mjs and test/e2e/git-oauth-gcm.mjs -> browser authorization, PKCE and refresh passed with a synthetic account.
- Full stack build -> pnpm run build -> unchanged Actions container requires unavailable Docker CLI; current Auth/Gateway dry runs and Web build pass.
- UI suite -> existing sign-out test fails resolving file:///logo.svg on Windows -> identical failure reproduced in baseline 135fef7; new OAuth/PAT behavior passes.

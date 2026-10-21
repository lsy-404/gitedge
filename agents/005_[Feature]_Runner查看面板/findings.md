# Findings

- Overview/history handlers are implemented in a separate module. Route wiring and shared contracts belong to the scheduler integration.
- API accepts only trusted human admins; job identities, agent sessions, and non-admin PATs are rejected. Rows and job details are scoped to owned/administered repositories.
- Limits are 100 runners, 50 GitHub connections, 50 queue rows, and 96 quarter-hour samples per runner. SQL uses JSON table-valued parameters to remain below D1's bind-parameter limit.
- History uses a deterministic composite cursor across both job tables so equal timestamps are not dropped.
- Peer-preferred deferrals are read in one bounded query and shown only for visible runners when the saved reason and job are fresh and the live fit check has no blocker.
- The baseline UI suite reproduces a Windows Vitest `createRequire` failure for `file:///logo.svg` on commit `e6a6957`; this is outside the dashboard changes.

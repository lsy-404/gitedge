# Findings

- Overview/history handlers are implemented in a separate module. Backend agent owns route wiring plus runners.ts and shared contracts.
- API accepts only trusted human admins; job identities, agent sessions, and non-admin PATs are rejected. Rows and job details are scoped to owned/administered repositories.
- Limits are 100 runners, 50 GitHub connections, 50 queue rows, and 96 quarter-hour samples per runner. SQL uses JSON table-valued parameters to remain below D1's bind-parameter limit.
- History uses a deterministic composite cursor across both job tables so equal timestamps are not dropped.
- Worker/D1 tests require migration 0047 from the backend branch before they can run.

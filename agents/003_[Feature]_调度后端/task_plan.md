# Runner scheduler backend

- [x] Read the approved scheduling design and inspect existing contracts, queues, D1 schema, and broker protocol.
- [x] Add shared job-claim parsing, matching, scoring, and typed request/response contracts; commit for peer reuse.
- [x] Add D1 scheduling schema and integrate capacity, budget, combined FIFO queue ordering, peer deferral, and quarantine.
- [x] Add bounded sample/deferral cleanup to the Actions cron path. Dashboard overview/history route wiring is being completed by the integration owner.
- [x] Add focused unit and D1 tests and verify the backend slice.
- [x] Commit the backend implementation and regression coverage; report commit hashes and verification.

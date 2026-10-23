# Task plan

- [x] Inspect the current runner registration, GitHub bridge, scheduler, and account runner UI.
- [x] Confirm GitHub custom-label matching semantics from official documentation.
- [x] Define which existing runner labels are system-owned and which may be edited.
- [x] Add owner-authorized custom-label update API and admin UI.
- [x] Add focused API, scheduling, and UI tests under `/test`.
- [x] Run affected tests and type checks, review the diff, and commit the task branch.
- [x] Return mandatory authoritative registration labels in every runner claim response and bind claim to the scheduled snapshot.
- [x] Apply the snapshot to native, GitHub, and ordinary GitEdge broker execution while validating actual host platform labels.
- [x] Cover stale local labels, newly added server tags, unmatched tags, and concurrent label edits.
- [x] Run affected worker/broker tests, typecheck, formatting, and diff checks.
- [x] Idle-update all five active brokers to the authoritative-label client and verify actual processes and heartbeats.
- [x] Publish the account labels editor after client acceptance.
- [x] Dispatch a fixed Windows job with an absent temporary tag, confirm it remains unassigned, then add the tag to one runner and verify that same job succeeds there without restart.
- [x] Remove the temporary tag and one-off workflow after acceptance.

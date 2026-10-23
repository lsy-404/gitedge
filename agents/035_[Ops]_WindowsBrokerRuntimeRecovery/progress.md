# Progress

- Prepared and validated the reviewed idle-safe Windows stage helper and fixed stage payload.
- Stage workflow `eb832f09-fdfb-450e-ac19-1aea69361bd7` completed successfully for target SHA `4c94799660f698dc5a65ae933ded9ffda5c4cd79`.
- Reworked the fixed readback to emit separate flat JSON lines and corrected exact process/lock PID matching. PowerShell parsing and the controller contract test passed.
- Pushed controller revision `b4bcdafd7360bda6bd96465c289f3a03407c7918` on the maintenance branch. Controller run `39879853070` committed GitEdge readback workflow revision `417992bc16d2b77f934d3c046dab73ed489de346` and dispatched readback `2ad69462-a100-4f37-bb53-006537fd8fcb`.
- Readback verified both broker receipts, current processes, scheduled tasks, and state locks. D1 then showed fresh heartbeats/capacity reports for both Windows runner registrations.
- Kept the exact helper scheduled tasks for cleanup after the signing canaries. No broker stop/restart or lock mutation was performed after the successful stage.
- Updated both Windows broker roots to `bfe613abb3c4a6bac6cdf160338eacbbc5dceb10`. Stage run `4e9f1436-f2fb-4d90-9082-c8cc505b9f9c` and readback run `3f157c2b-4fc2-46c0-bdcf-ff6cc7994114` succeeded; receipts, fresh process identities, task/lock ownership, and post-receipt heartbeats were verified.
- Kept both exact helper tasks pending platform signing verification; their expected current action wrappers use the `bfe613abb3c4` revision. Cleanup has not run.

# Findings

- Native signing queue rows already carry the approved profile timeout, but the persisted `need-time-*m` label still came from the readiness workflow. Scheduler claim minutes therefore remained at the shorter readiness value.
- Broker signing execution also parsed the raw approved workflow's time label. The appended SDK timeout alone could not extend the broker CLI deadline or runner registration labels. Registration also needs the complete queue requirement set, including broker-added node/Python needs.
- The fix must stay native-signing-only: replace valid time resource labels in queued demand and the trusted generated workflow with the approved profile budget, preserve all other labels and the stored workflow source, and leave general GitEdge and GitHub execution semantics unchanged.
- Malformed or out-of-range time labels remain present for the existing claim parser to reject; normalization does not make an invalid request valid.

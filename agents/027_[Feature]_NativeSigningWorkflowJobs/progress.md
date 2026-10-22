# Progress

- Added a short-lived job token to native signing claims through the existing AUTH job-token route.
- Changed the broker to run the pinned one-job source workflow with Runner.Server and a trusted SDK step appended to that same job.
- Added a one-time SDK success receipt and stopped native lease heartbeat after the receipt appears.
- Updated profile approval validation and tests for static one-job scope, setup-step ordering, claim-token issuance, preparation rejection, and missing receipts.
- Focused unit tests: 25 passed. Signing runner worker tests: 3 passed. Actions worker typecheck and JavaScript syntax checks passed.

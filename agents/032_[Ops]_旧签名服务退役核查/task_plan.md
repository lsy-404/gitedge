# Legacy signing retirement audit

## Goal

Verify current legacy-signing callers, related GitHub Actions runs, old IRIS cleanup state, and a read-only retirement sequence. Preserve old-service Durable Object state, R2 credential objects, and history. This task performs no retirement or production changes.

## Steps

- [x] Check repository state and related active workflow runs.
- [x] Check whether current IRIS main calls the legacy signing interface and distinguish other IRIS-Build dependencies.
- [x] Review old Worker bindings, Durable Object, R2 objects, and cron.
- [x] Record the IRIS run cleanup state and safe retirement ordering.
- [x] Commit the audit record locally.

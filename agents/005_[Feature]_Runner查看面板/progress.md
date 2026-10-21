# Progress

- Read AGENTS.md, PRODUCT.md, complete docs/runner-scheduling.md, and required skills before implementation.
- Added overview/history handlers with human-admin authorization, owned-repository scoping, bounded queries, fit reasons, usage summaries, aggregated samples, and composite pagination.
- Added account settings runner dashboard, API client methods, navigation, and matching English/Chinese copy. Refresh polling is visible-page-only and aborted requests cannot overwrite newer state.
- Added Worker/D1 tests for authorization, row visibility, tied-timestamp paging, query bounds, and queue visibility without runners; added UI tests for state/claim rendering and empty state.
- D1 tests exposed missing stats-query bindings; fixed them, and subsequent tests verified both job types are included in minute-based usage and `need-*` labels are interpreted as claims.
- Added bounded/fresh peer-preferred rendering and regressions; removed unchecked DOM casts and completed dynamic i18n key registration.
- Reproduced existing Windows Vitest `file:///logo.svg` failure on detached baseline `e6a6957` with `usage-feedback.test.ts` (7 failed, 2 passed).
- Actions and Vue typechecks pass; 7 Worker D1 tests and 9 targeted UI/i18n tests pass.
- Dashboard commits: `090be52` and `02ac84e`; final review fixes are being committed separately.

# Findings
- Existing expiry column is non-null; zero represents no expiry internally, with null in the API and account export.
- The first worker test attempt could not resolve croner from the original checkout dependencies; reused the complete runner-scheduling dependency tree instead.
- Full account-settings UI suite had an unrelated Windows Vitest logo URL routing error; the targeted token UI test passes.

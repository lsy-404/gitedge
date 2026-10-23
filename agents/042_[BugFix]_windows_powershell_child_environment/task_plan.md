# Task plan

- [x] Inspect both Windows PowerShell child-process call sites and the existing ACL regression harness.
- [x] Add a child-only environment builder that removes `PSModulePath` case-insensitively and use it at both call sites.
- [x] Extend the Windows PowerShell 5.1 harness to exercise the actual Node-to-PowerShell ACL/context path with inherited module-path pollution and ACL rejection controls.
- [x] Run focused checks and prepare a local review commit.

# Findings

- Both Windows ACL helpers are launched from Node via `powershell.exe`; inherited `PSModulePath` can make the child fail to load built-in ACL commands. Removing it only from each child environment is sufficient and preserves the parent process and all other inherited variables.
- Root confirmed an A/B probe using the same synthetic context and ACL policy: the inherited environment failed, while a child-only environment without `PSModulePath` passed both helper invocations and context parsing.
- Existing Windows PowerShell 5.1 tests exercise valid protected-current-SID ACLs and reject inherited and extra-SID ACLs. Extend this real harness through Node so it covers the actual environment boundary.
- The local Windows account cannot run the ACL-mutating `secure-runner-context.ps1` helper because `Set-Acl` requires `SeSecurityPrivilege`. The regression therefore exercises the production context-reader/checker subprocess chain with a valid pre-protected fixture and the production checker’s inherited/extra-SID rejection paths; broker uses the same shared environment builder.
- In Windows PowerShell 5.1, removing the inherited variable from the child environment lets PowerShell initialize its normal module search path. The test verifies the injected synthetic path is absent, a separate marker variable remains, and `Get-Acl` resolves successfully.

# Progress

- Reproduced the parser failure using Windows PowerShell 5.1 `Parser.ParseFile` against the current ACL checker.
- Moved the `-or` operators to the ends of continued lines without changing the ACL predicate.
- Added a Windows PowerShell 5.1 harness that parses the real checker and verifies current-SID-only protected ACLs pass, while inherited ACLs and an additional SID fail with their existing exit codes.
- `client-error-output.test.ts` now verifies the three fixed context error codes survive and a mutated unknown code is suppressed.
- Windows PowerShell 5.1 harness passed; focused formatter suite passed 12/12; `node --check` and `git diff --check` passed.
- Restricted the ACL harness to Windows PowerShell 5.1 and committed the implementation locally for review.
- Root integrated the fix and idle-updated both Windows brokers. The accepted real Windows signing requestc4f4c716-247b-4724-ba04-580dc927f8bf and independent Authenticode/publisher/timestamp job120227210455 passed before legacy retirement.

# Findings

- Windows PowerShell 5.1 rejects the `if` condition when `-or` begins the following line. The context reader invokes this script with `powershell.exe`, so parsing fails before the ACL checks run.
- The ACL predicate must continue rejecting inherited rules, non-Allow rules, and every SID except the current service identity; owner and protected-DACL checks remain unchanged.
- `readSigningContext` throws `SigningContextError` with fixed codes, but the CLI formatter currently maps it to `SIGNING_FAILED`. Only the class's explicit context-code allowlist should be printed.

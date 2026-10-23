$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'This ACL regression test requires Windows PowerShell 5.1.'
}

$checker = (Resolve-Path (Join-Path $PSScriptRoot '../../scripts/signing/check-context-acl.ps1')).Path
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($checker, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -ne 0) {
  throw "Context ACL checker has $($parseErrors.Count) PowerShell parse error(s)."
}

$directory = Join-Path ([System.IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $currentSid = $identity.User
  $otherSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  if ($otherSid.Value -eq $currentSid.Value) { throw 'Test requires a distinct additional SID.' }

  function Set-TestAcl([string]$Path, [bool]$Protected, [bool]$AddOtherSid) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($Protected, $false)
    if ($Protected) {
      foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($existing) }
    }
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $currentRule = [System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, $rights, $allow)
    [void]$acl.AddAccessRule($currentRule)
    if ($AddOtherSid) {
      $otherRule = [System.Security.AccessControl.FileSystemAccessRule]::new($otherSid, $rights, $allow)
      [void]$acl.AddAccessRule($otherRule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
  }

  function Get-CheckerExitCode([string]$Path) {
    & powershell.exe -NoLogo -NoProfile -NonInteractive -File $checker -Path $Path
    return $LASTEXITCODE
  }

  $valid = Join-Path $directory 'valid.json'
  $context = @{
    schemaVersion = 1
    baseUrl = 'https://gitedge.example/api/actions'
    ownerId = '11111111-1111-4111-8111-111111111111'
    repositoryId = '22222222-2222-4222-8222-222222222222'
    runnerId = '33333333-3333-4333-8333-333333333333'
    runId = '44444444-4444-4444-8444-444444444444'
    requestId = '55555555-5555-4555-8555-555555555555'
    platform = 'windows'
    workflowOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    profileRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    generation = 1
    nonce = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    leaseToken = ('c' * 64)
    leaseExpiresAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 60000
    jobToken = ('ge_job_' + ('d' * 64))
  }
  Set-Content -LiteralPath $valid -Value ($context | ConvertTo-Json -Compress) -NoNewline
  Set-TestAcl -Path $valid -Protected $true -AddOtherSid $false
  if ((Get-CheckerExitCode $valid) -ne 0) { throw 'Current-user protected ACL was rejected.' }

  $env:PSModulePath = 'C:\synthetic\invalid-module-path'
  $env:GE_CHILD_MARKER = 'preserved'
  $checkerScript = (Resolve-Path (Join-Path $PSScriptRoot '../../scripts/signing/check-context-acl.ps1')).Path
  $inherited = Join-Path $directory 'inherited.json'
  Set-Content -LiteralPath $inherited -Value '{}' -NoNewline
  Set-TestAcl -Path $inherited -Protected $false -AddOtherSid $false
  if ((Get-CheckerExitCode $inherited) -ne 3) { throw 'An inheriting ACL was not rejected.' }

  $extraSid = Join-Path $directory 'extra-sid.json'
  Set-Content -LiteralPath $extraSid -Value '{}' -NoNewline
  Set-TestAcl -Path $extraSid -Protected $true -AddOtherSid $true
  if ((Get-CheckerExitCode $extraSid) -ne 6) { throw 'An ACL containing another SID was not rejected.' }

  $nodeHarness = (Resolve-Path (Join-Path $PSScriptRoot 'windows-context-environment.mjs')).Path
  & node $nodeHarness $valid $checkerScript
  if ($LASTEXITCODE -ne 0) { throw 'Node-to-PowerShell child environment regression failed.' }

  Write-Output 'Windows PowerShell 5.1 parser and signing context ACL checks passed.'
} finally {
  Remove-Item -LiteralPath $directory -Force -Recurse
}

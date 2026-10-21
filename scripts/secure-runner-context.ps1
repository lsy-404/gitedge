param([Parameter(Mandatory = $true)][string]$Path, [switch]$Directory)
$ErrorActionPreference = 'Stop'

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl = Get-Acl -LiteralPath $Path
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($identity.User)
foreach ($rule in @($acl.Access)) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$rule = if ($Directory) {
  [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity.User, $rights,
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
} else {
  [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity.User, $rights, [System.Security.AccessControl.AccessControlType]::Allow
  )
}
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Path -AclObject $acl

$verified = Get-Acl -LiteralPath $Path
if (-not $verified.AreAccessRulesProtected -or
    $verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) {
  throw 'Signing context ACL is not restricted to the current service identity.'
}
$rules = $verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($rules.Count -lt 1) { throw 'Signing context ACL is empty.' }
foreach ($verifiedRule in $rules) {
  if ($verifiedRule.IsInherited -or
      $verifiedRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $verifiedRule.IdentityReference.Value -ne $identity.User.Value) {
    throw 'Signing context ACL is not restricted to the current service identity.'
  }
}

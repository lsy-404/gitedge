$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
. (Join-Path $PSScriptRoot 'seed-iso.ps1')

$script:reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8, $false, 4096, $true)
$script:pendingLine = $null
$script:session = $null
$script:config = $null
$script:context = $null
$script:vmName = $null
$script:runDirectory = $null
$script:vmDirectory = $null
$script:markerPath = $null
$script:job = $null
$script:guestControlDirectory = $null
$script:createdRunDirectory = $false
$script:guestNetwork = $null
$script:hostIPv4Addresses = @()
$script:networkPolicyVersion = 1
$script:deniedIPv4Cidrs = @(
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '168.63.129.16/32'
)
$script:networkAclDenyWeight = 30000
$script:networkAclAllowWeight = 20000
$script:networkAclDefaultWeight = 1

function Write-Protocol([object]$Message) {
  $json = ConvertTo-Json -InputObject $Message -Depth 30 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Start-ProtocolRead {
  $script:pendingLine = $script:reader.ReadLineAsync()
}

function Read-ProtocolLine {
  while (-not $script:pendingLine.IsCompleted) {
    Start-Sleep -Milliseconds 20
  }
  $line = $script:pendingLine.GetAwaiter().GetResult()
  Start-ProtocolRead
  return $line
}

function Test-ProtocolLine {
  return $null -ne $script:pendingLine -and $script:pendingLine.IsCompleted
}

function Assert-LocalPath([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f<>"|?*]' -or
      $Value -notmatch '^[a-zA-Z]:[\\/]') {
    throw "$Label is not an absolute local path."
  }
  if ($Value.StartsWith('\\?\') -or $Value.StartsWith('\\.\') -or
      $Value -match '(^|[\\/])\.\.([\\/]|$)' -or $Value.Substring(2).Contains(':')) {
    throw "$Label contains a prohibited path component."
  }
  return [System.IO.Path]::GetFullPath($Value)
}

function Assert-GuestPath([string]$Value, [string]$Label) {
  if ([string]$script:machine.guestPlatform -eq 'windows') { return Assert-LocalPath $Value $Label }
  if (-not $Value.StartsWith('/') -or $Value -eq '/' -or $Value -match '[\x00-\x1f]' -or $Value.Split('/').Contains('..')) {
    throw "$Label must be an absolute Linux guest path."
  }
  return $Value
}

function ConvertTo-IPv4Integer([string]$Value, [string]$Label) {
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed) -or
      $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
      $parsed.ToString() -cne $Value) {
    throw "$Label must be a canonical IPv4 address."
  }
  $bytes = $parsed.GetAddressBytes()
  return [long]$bytes[0] * 16777216 + [long]$bytes[1] * 65536 + [long]$bytes[2] * 256 + $bytes[3]
}

function Get-IPv4NetworkInteger([string]$Address, [int]$PrefixLength) {
  $blockSize = [long][Math]::Pow(2, 32 - $PrefixLength)
  $number = ConvertTo-IPv4Integer $Address 'IPv4 address'
  return [long]([Math]::Floor($number / $blockSize) * $blockSize)
}

function ConvertFrom-IPv4Integer([long]$Value) {
  $bytes = [byte[]]@(
    [byte][Math]::Floor($Value / 16777216),
    [byte][Math]::Floor(($Value % 16777216) / 65536),
    [byte][Math]::Floor(($Value % 65536) / 256),
    [byte]($Value % 256)
  )
  return ([System.Net.IPAddress]::new($bytes)).ToString()
}

function Test-IPv4InCidr([string]$Address, [string]$Cidr) {
  $parts = $Cidr.Split('/')
  $prefixLength = [int]$parts[1]
  return (Get-IPv4NetworkInteger $Address $prefixLength) -eq
    (Get-IPv4NetworkInteger $parts[0] $prefixLength)
}

function Assert-GuestNetwork([object]$Network) {
  $required = @('address', 'dns', 'gateway', 'prefixLength')
  if ($null -eq $Network -or @($Network.PSObject.Properties).Count -ne $required.Count) {
    throw 'machine.guestNetwork must contain address, prefixLength, gateway, and dns.'
  }
  foreach ($name in $required) {
    if ($null -eq $Network.PSObject.Properties[$name]) {
      throw 'machine.guestNetwork must contain address, prefixLength, gateway, and dns.'
    }
  }
  if (($Network.prefixLength -isnot [int]) -and ($Network.prefixLength -isnot [long])) {
    throw 'machine.guestNetwork.prefixLength must be an integer.'
  }
  $prefixLength = [int]$Network.prefixLength
  if ($prefixLength -lt 1 -or $prefixLength -gt 30 -or $Network.dns -isnot [System.Array] -or
      $Network.dns.Count -lt 1 -or $Network.dns.Count -gt 4) {
    throw 'machine.guestNetwork has an invalid prefixLength or DNS list.'
  }
  if ($Network.address -isnot [string] -or $Network.gateway -isnot [string]) {
    throw 'machine.guestNetwork.address and gateway must be IPv4 strings.'
  }
  $addressNumber = ConvertTo-IPv4Integer $Network.address 'machine.guestNetwork.address'
  $gatewayNumber = ConvertTo-IPv4Integer $Network.gateway 'machine.guestNetwork.gateway'
  $privateRanges = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
  $privateRange = $null
  foreach ($cidr in $privateRanges) {
    if ((Test-IPv4InCidr $Network.address $cidr) -and (Test-IPv4InCidr $Network.gateway $cidr)) {
      $privateRange = $cidr
      break
    }
  }
  $addressNetwork = Get-IPv4NetworkInteger $Network.address $prefixLength
  $gatewayNetwork = Get-IPv4NetworkInteger $Network.gateway $prefixLength
  $broadcast = $addressNetwork + [long][Math]::Pow(2, 32 - $prefixLength) - 1
  if (-not $privateRange -or $prefixLength -lt [int]$privateRange.Split('/')[1] -or
      $addressNetwork -ne $gatewayNetwork -or
      $addressNumber -eq $gatewayNumber -or $addressNumber -eq $addressNetwork -or
      $addressNumber -eq $broadcast -or $gatewayNumber -eq $addressNetwork -or $gatewayNumber -eq $broadcast) {
    throw 'machine.guestNetwork.address and gateway must be distinct hosts in the same RFC1918 subnet.'
  }
  $dns = @()
  foreach ($server in $Network.dns) {
    if ($server -isnot [string]) { throw 'machine.guestNetwork.dns entries must be public IPv4 strings.' }
    $null = ConvertTo-IPv4Integer $server 'machine.guestNetwork.dns entry'
    if (@($script:deniedIPv4Cidrs | Where-Object { Test-IPv4InCidr $server $_ }).Count -gt 0) {
      throw 'machine.guestNetwork.dns entries must be public IPv4 addresses.'
    }
    if ($server -in $dns) { throw 'machine.guestNetwork.dns entries must be unique.' }
    $dns += $server
  }
  return [pscustomobject][ordered]@{
    address = [string]$Network.address
    prefixLength = $prefixLength
    gateway = [string]$Network.gateway
    dns = [string[]]$dns
  }
}

function Test-SameGuestNetwork([object]$Left, [object]$Right) {
  $leftNetwork = Assert-GuestNetwork $Left
  $rightNetwork = Assert-GuestNetwork $Right
  return $leftNetwork.address -ceq $rightNetwork.address -and
    [int]$leftNetwork.prefixLength -eq [int]$rightNetwork.prefixLength -and
    $leftNetwork.gateway -ceq $rightNetwork.gateway -and
    (@($leftNetwork.dns) -join ',') -ceq (@($rightNetwork.dns) -join ',')
}

function Add-NetworkAclRule([object]$Rules, [hashtable]$Seen, [string]$Action, [string]$Direction,
  [string]$LocalIPAddress, [string]$RemoteIPAddress, [int]$Weight, [bool]$Stateful) {
  $key = @($Action, $Direction, $LocalIPAddress, $RemoteIPAddress, $Weight, $Stateful) -join "`0"
  if (-not $Seen.ContainsKey($key)) {
    $Seen[$key] = $true
    $Rules.Add([pscustomobject][ordered]@{
      Action = $Action
      Direction = $Direction
      LocalIPAddress = $LocalIPAddress
      RemoteIPAddress = $RemoteIPAddress
      LocalPort = 'ANY'
      RemotePort = 'ANY'
      Protocol = 'ANY'
      Weight = $Weight
      Stateful = $Stateful
    })
  }
}

function Get-ExpectedNetworkAclRules([string[]]$HostAddresses) {
  $rules = [System.Collections.Generic.List[object]]::new()
  $seen = @{}
  if ($null -ne $script:machine.egressProxyPort) {
    $port = $script:machine.egressProxyPort
    if (($port -isnot [int] -and $port -isnot [long]) -or $port -lt 1 -or $port -gt 65535) {
      throw 'machine.egressProxyPort must be a TCP port.'
    }
    $rules.Add(@{ Action = 'Allow'; Direction = 'Outbound'; LocalIPAddress = "$($script:guestNetwork.address)/32";
      RemoteIPAddress = "$($script:guestNetwork.gateway)/32"; LocalPort = 'ANY'; RemotePort = [string]$port;
      Protocol = 'TCP'; Weight = 45000; Stateful = $true })
  }
  if ([string]$script:machine.guestPlatform -eq 'linux') {
    $rules.Add(@{ Action = 'Allow'; Direction = 'Inbound'; LocalIPAddress = "$($script:guestNetwork.address)/32";
      RemoteIPAddress = "$($script:guestNetwork.gateway)/32"; LocalPort = '22'; RemotePort = 'ANY';
      Protocol = 'TCP'; Weight = 40000; Stateful = $true })
  }
  foreach ($direction in @('Inbound', 'Outbound')) {
    $weight = $script:networkAclDefaultWeight + [int]($direction -eq 'Outbound')
    Add-NetworkAclRule $rules $seen 'Deny' $direction '' 'ANY' $weight $false
  }
  $denyWeight = $script:networkAclDenyWeight
  foreach ($direction in @('Inbound', 'Outbound')) {
    foreach ($cidr in $script:deniedIPv4Cidrs) {
      Add-NetworkAclRule $rules $seen 'Deny' $direction '' $cidr $denyWeight $false
      $denyWeight--
    }
    foreach ($hostAddress in $HostAddresses) {
      Add-NetworkAclRule $rules $seen 'Deny' $direction '' "$hostAddress/32" $denyWeight $false
      $denyWeight--
    }
  }
  $allowWeight = $script:networkAclAllowWeight
  foreach ($protocol in @('TCP', 'UDP')) {
    $rules.Add(@{ Action = 'Allow'; Direction = 'Outbound'; LocalIPAddress = "$($script:guestNetwork.address)/32";
      RemoteIPAddress = '0.0.0.0/0'; LocalPort = 'ANY'; RemotePort = 'ANY'; Protocol = $protocol;
      Weight = $allowWeight; Stateful = $true })
    $allowWeight--
  }
  return $rules.ToArray()
}

function Normalize-AclFilter([object]$Value, [bool]$IPAddress = $false) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value) -or [string]$Value -eq '*') {
    if ($IPAddress) { return 'ANY' }
    return ''
  }
  $normalized = ([string]$Value).Trim()
  if ($IPAddress -and ($normalized -ieq 'ANY' -or $normalized -match '^0\.0\.0\.0/0[, ]+::/0$')) { return 'ANY' }
  return $normalized
}

function Normalize-AclAny([object]$Value) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value) -or
      [string]$Value -eq '*' -or [string]$Value -ieq 'ANY') {
    return 'ANY'
  }
  return ([string]$Value).Trim()
}

function Test-SameNetworkAclRule([object]$Actual, [object]$Expected) {
  return [string]$Actual.Action -ieq [string]$Expected.Action -and
    [string]$Actual.Direction -ieq [string]$Expected.Direction -and
    (Normalize-AclFilter $Actual.LocalIPAddress $true) -ieq
      (Normalize-AclFilter $Expected.LocalIPAddress $true) -and
    (Normalize-AclFilter $Actual.RemoteIPAddress $true) -ieq
      (Normalize-AclFilter $Expected.RemoteIPAddress $true) -and
    (Normalize-AclAny $Actual.LocalPort) -ieq (Normalize-AclAny $Expected.LocalPort) -and
    (Normalize-AclAny $Actual.RemotePort) -ieq (Normalize-AclAny $Expected.RemotePort) -and
    (Normalize-AclAny $Actual.Protocol) -ieq (Normalize-AclAny $Expected.Protocol) -and
    [int]$Actual.Weight -eq [int]$Expected.Weight -and
    [bool]$Actual.Stateful -eq [bool]$Expected.Stateful
}

function Add-ExpectedNetworkAclRules([object]$Adapter, [object[]]$Rules) {
  foreach ($rule in $Rules) {
    $parameters = @{
      VMNetworkAdapter = $Adapter
      Action = [string]$rule.Action
      Direction = [string]$rule.Direction
      Weight = [int]$rule.Weight
      Stateful = [bool]$rule.Stateful
      ErrorAction = 'Stop'
    }
    if (-not [string]::IsNullOrEmpty([string]$rule.LocalIPAddress)) {
      $parameters.LocalIPAddress = [string]$rule.LocalIPAddress
    }
    $parameters.RemoteIPAddress = [string]$rule.RemoteIPAddress
    foreach ($field in @('LocalPort', 'RemotePort', 'Protocol')) {
      if ([string]$rule.$field -ne 'ANY') { $parameters[$field] = [string]$rule.$field }
    }
    $null = Add-VMNetworkAdapterExtendedAcl @parameters
  }
}

function Assert-NetworkAclRules([object]$Adapter, [object[]]$ExpectedRules) {
  $actualRules = @(Get-VMNetworkAdapterExtendedAcl -VMNetworkAdapter $Adapter -ErrorAction Stop)
  if ($actualRules.Count -ne $ExpectedRules.Count) {
    throw 'The Hyper-V adapter ACL did not contain the complete expected policy.'
  }
  foreach ($expected in $ExpectedRules) {
    $matches = @($actualRules | Where-Object { Test-SameNetworkAclRule $_ $expected })
    if ($matches.Count -ne 1) { throw 'The Hyper-V adapter ACL did not match the expected policy.' }
  }
}

function Get-PrecreatedNetwork([object]$Switch) {
  if ([string]$Switch.SwitchType -ine 'Internal') {
    throw 'The configured switch must be an existing Internal switch.'
  }
  $hostAdapterName = "vEthernet ($([string]$Switch.Name))"
  $hostAdapters = @(Get-NetAdapter -ErrorAction Stop | Where-Object { [string]$_.Name -ceq $hostAdapterName })
  if ($hostAdapters.Count -ne 1 -or [string]$hostAdapters[0].Status -ine 'Up') {
    throw 'The configured switch must have one active host vEthernet adapter.'
  }
  $hostAdapterAddresses = @(Get-NetIPAddress -InterfaceIndex $hostAdapters[0].ifIndex -AddressFamily IPv4 -ErrorAction Stop)
  $preferredAddresses = @($hostAdapterAddresses | Where-Object { [string]$_.AddressState -eq 'Preferred' })
  $gatewayAddresses = @($preferredAddresses | Where-Object {
    [string]$_.IPAddress -ceq [string]$script:guestNetwork.gateway -and
    [int]$_.PrefixLength -eq [int]$script:guestNetwork.prefixLength
  })
  if ($preferredAddresses.Count -ne 1 -or $gatewayAddresses.Count -ne 1) {
    throw 'The host vEthernet address and prefix do not match machine.guestNetwork.'
  }

  $networkBase = ConvertFrom-IPv4Integer (Get-IPv4NetworkInteger $script:guestNetwork.address $script:guestNetwork.prefixLength)
  $expectedNatPrefix = "$networkBase/$($script:guestNetwork.prefixLength)"
  $natObjects = @(Get-NetNat -ErrorAction Stop)
  if ($natObjects.Count -ne 1 -or [string]$natObjects[0].InternalIPInterfaceAddressPrefix -cne $expectedNatPrefix) {
    throw 'The host must have exactly one NetNat matching the configured internal subnet.'
  }

  $hostAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -IncludeAllCompartments -ErrorAction Stop |
    ForEach-Object {
      $address = [string]$_.IPAddress
      $null = ConvertTo-IPv4Integer $address 'host IPv4 address'
      $address
    } | Sort-Object -Unique)
  if ($hostAddresses.Count -lt 1 -or $script:guestNetwork.address -in $hostAddresses) {
    throw 'The guest IPv4 address conflicts with a current host IPv4 address.'
  }
  foreach ($existingVm in @(Get-VM -ErrorAction Stop | Where-Object { [string]$_.Name -like 'ge-*' })) {
    foreach ($adapter in @(Get-VMNetworkAdapter -VM $existingVm -ErrorAction Stop |
        Where-Object { [string]$_.SwitchName -ieq [string]$Switch.Name })) {
      if ($script:guestNetwork.address -in @($adapter.IPAddresses)) {
        throw 'The guest IPv4 address is already active on another GitEdge VM.'
      }
      foreach ($rule in @(Get-VMNetworkAdapterExtendedAcl -VMNetworkAdapter $adapter -ErrorAction Stop)) {
        if ([string]$rule.LocalIPAddress -in @($script:guestNetwork.address, "$($script:guestNetwork.address)/32")) {
          throw 'The guest IPv4 address is already reserved by another GitEdge VM ACL.'
        }
      }
    }
  }
  return [string[]]$hostAddresses
}

function Assert-NoHostReparsePoints([string]$Path) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $current = [System.IO.Path]::GetPathRoot($fullPath)
  foreach ($part in $fullPath.Substring($current.Length).Split('\')) {
    if (-not $part) { continue }
    $current = Join-Path $current $part
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'Host paths may not contain reparse points.'
      }
    }
  }
}

function Assert-PrivateDirectory([string]$Directory) {
  Assert-NoHostReparsePoints $Directory
  $item = Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The host run directory must be a real directory.'
  }
  $acl = Get-Acl -LiteralPath $Directory -ErrorAction Stop
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trustedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -notin $trustedSids) {
    throw 'The host run directory ACL is not private.'
  }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($rules.Count -lt 1) { throw 'The host run directory ACL is empty.' }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -notin $trustedSids) {
      throw 'The host run directory ACL grants access to an untrusted principal.'
    }
  }
}

function Assert-PrivateFile([string]$File) {
  $acl = Get-Acl -LiteralPath $File -ErrorAction Stop
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trustedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -notin $trustedSids) {
    throw 'The DPAPI credential file ACL is not private.'
  }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($rules.Count -lt 1) { throw 'The DPAPI credential file ACL is empty.' }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -notin $trustedSids) {
      throw 'The DPAPI credential file ACL grants access to an untrusted principal.'
    }
  }
}

function Assert-MainMetadata([object]$Machine) {
  $id = [string]$script:context.id
  $directory = [System.IO.Path]::GetFullPath([string]$script:context.directory).TrimEnd('\')
  $script:context.directory = $directory
  if ([System.IO.Path]::GetFileName($directory) -ine $id -or
      [System.IO.Path]::GetFileName([System.IO.Path]::GetDirectoryName($directory)) -ine 'runs') {
    throw 'The private run directory does not match its UUID path.'
  }
  $metadataPath = Join-Path $directory '.runner-vm.json'
  $item = Get-Item -LiteralPath $metadataPath -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      $item.Length -gt 65536) {
    throw 'The private runner VM metadata is invalid.'
  }
  Assert-PrivateFile $metadataPath
  $metadata = Get-Content -LiteralPath $metadataPath -Raw -ErrorAction Stop | ConvertFrom-Json
  if ([int]$metadata.version -ne 1 -or [string]$metadata.driver -cne 'hyperv' -or
      [string]$metadata.id -cne $id -or $null -eq $metadata.machine -or
      [long]$metadata.hostPid -lt 1) {
    throw 'The private runner VM metadata does not match this provider.'
  }
  $vmRoot = Assert-LocalPath ([string]$metadata.machine.vmRoot) 'vmRoot'
  $expectedDirectory = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $vmRoot 'runs') $id))
  if ($expectedDirectory -ine $directory) {
    throw 'The private runner VM metadata points to a different run directory.'
  }
  $script:guestNetwork = Assert-GuestNetwork $metadata.machine.guestNetwork
  if ($Machine) {
    foreach ($name in @('vmRoot', 'baseImage', 'cpus', 'memoryMiB', 'switchName', 'guestRoot', 'guestNode', 'arch', 'guestPlatform', 'guestNetwork')) {
      $expected = $metadata.machine.PSObject.Properties[$name]
      $actual = $Machine.PSObject.Properties[$name]
      if ($null -ne $expected -and $null -ne $actual) {
        if ($name -in @('guestRoot', 'guestNode')) {
          if ([string]$expected.Value -cne [string]$actual.Value) { throw 'The recovery guest path differs from its metadata.' }
        } elseif ($name -in @('vmRoot', 'baseImage')) {
          $expectedPath = Assert-LocalPath ([string]$expected.Value) $name
          $actualPath = Assert-LocalPath ([string]$actual.Value) $name
          if ($expectedPath -ine $actualPath) { throw 'The recovery machine does not match its metadata.' }
        } elseif ($name -eq 'guestNetwork') {
          if (-not (Test-SameGuestNetwork $expected.Value $actual.Value)) {
            throw 'The recovery machine does not match its metadata.'
          }
        } elseif ([string]$expected.Value -cne [string]$actual.Value) {
          throw 'The recovery machine does not match its metadata.'
        }
      } elseif ($null -ne $expected -or $null -ne $actual) {
        throw 'The recovery machine fields do not match its metadata.'
      }
    }
  }
  $script:machine = $metadata.machine
  return $metadata
}

function Assert-NoResourceReparsePoints([string]$Directory) {
  $pending = New-Object System.Collections.Stack
  $pending.Push($Directory)
  while ($pending.Count -gt 0) {
    $currentDirectory = [string]$pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $currentDirectory -Force -ErrorAction Stop) {
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'VM resource directories may not contain reparse points.'
      }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
}

function Assert-Config {
  $id = [string]$script:context.id
  if ($id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'The job identifier is invalid.'
  }
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The Hyper-V provider requires a Windows host.'
  }
  if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue) -or
      -not (Get-Command New-VHD -ErrorAction SilentlyContinue) -or
      -not (Get-Command New-PSSession -ErrorAction SilentlyContinue) -or
      -not (Get-Command Get-VMSwitch -ErrorAction SilentlyContinue) -or
      -not (Get-Command Set-VMNetworkAdapter -ErrorAction SilentlyContinue) -or
      -not (Get-Command Add-VMNetworkAdapterExtendedAcl -ErrorAction SilentlyContinue) -or
      -not (Get-Command Get-VMNetworkAdapterExtendedAcl -ErrorAction SilentlyContinue) -or
      -not (Get-Command Get-NetAdapter -ErrorAction SilentlyContinue) -or
      -not (Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) -or
      -not (Get-Command Get-NetNat -ErrorAction SilentlyContinue)) {
    throw 'Hyper-V, NetNat, host network inspection, or PowerShell Direct is unavailable.'
  }
  $script:guestNetwork = Assert-GuestNetwork $script:machine.guestNetwork
  $script:config.baseImage = Assert-LocalPath ([string]$script:config.baseImage) 'baseImage'
  if ([string]$script:machine.guestPlatform -notin @('windows','linux')) { throw 'Unsupported guest platform.' }
  $script:context.directory = Assert-LocalPath ([string]$script:context.directory) 'run directory'
  $script:config.guestRoot = Assert-GuestPath ([string]$script:config.guestRoot) 'guestRoot'
  $script:config.guestNode = Assert-GuestPath ([string]$script:config.guestNode) 'guestNode'
  if ([System.IO.Path]::GetExtension($script:config.baseImage) -ine '.vhdx') { throw 'The image must be a VHDX.' }
  if ([string]$script:config.cpus -notmatch '^\d+$' -or [int]$script:config.cpus -lt 1 -or
      [int]$script:config.cpus -gt 512 -or [string]$script:config.memoryMiB -notmatch '^\d+$' -or
      [long]$script:config.memoryMiB -lt 1) {
    throw 'The requested VM resources are invalid.'
  }
  if ($script:context.directory -ieq [System.IO.Path]::GetPathRoot($script:context.directory) -or
      $script:config.guestRoot -ieq [System.IO.Path]::GetPathRoot($script:config.guestRoot)) {
    throw 'Run and guest roots must be directories below a drive root.'
  }
  if ([string]::IsNullOrWhiteSpace([string]$script:config.switchName) -or
      ([string]$script:config.switchName).Length -gt 100 -or
      ([string]$script:config.switchName) -match '[*?\[\]]' -or
      ([string]$script:config.switchName).Contains([char]0)) {
    throw 'The virtual switch name is invalid.'
  }

  Assert-PrivateDirectory $script:context.directory
  $image = Get-Item -LiteralPath $script:config.baseImage -Force -ErrorAction Stop
  Assert-NoHostReparsePoints $script:config.baseImage
  if ($image.PSIsContainer -or ($image.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      -not ($image.Attributes -band [System.IO.FileAttributes]::ReadOnly)) {
    throw 'The base VHDX must be a read-only regular file.'
  }
  $disk = Get-VHD -Path $script:config.baseImage -ErrorAction Stop
  if ($disk.VhdFormat -ne 'VHDX' -or $disk.VhdType -notin @('Dynamic','Fixed') -or $disk.ParentPath) {
    throw 'The base image must be an independent VHDX.'
  }
  if ([string]$script:machine.diskMiB -notmatch '^\d+$' -or
      [long]$disk.Size -gt [long]$script:machine.diskMiB * 1MB) {
    throw 'The base image virtual size exceeds its configured disk budget.'
  }
  $script:vmName = "ge-$id"
  $script:runDirectory = [System.IO.Path]::GetFullPath((Join-Path $script:context.directory $script:vmName))
  $script:vmDirectory = Join-Path $script:runDirectory 'vm'
  $script:markerPath = Join-Path $script:runDirectory 'owner.json'
  if ([string]$script:machine.guestPlatform -eq 'windows') {
    $script:guestControlDirectory = [System.IO.Path]::Combine($script:config.guestRoot, ".ge-$id")
  }

  if (Test-Path -LiteralPath $script:runDirectory) {
    throw 'The job resource directory already exists.'
  }
  if (Get-VM -Name $script:vmName -ErrorAction SilentlyContinue) {
    throw 'A VM with this job name already exists.'
  }
  $switch = @(Get-VMSwitch -Name ([string]$script:config.switchName) -ErrorAction Stop)
  if ($switch.Count -ne 1 -or $switch[0].Name -ine [string]$script:config.switchName) {
    throw 'The configured virtual switch was not found exactly once.'
  }
  $script:hostIPv4Addresses = Get-PrecreatedNetwork $switch[0]
  if ([string]$script:machine.guestPlatform -eq 'linux') {
    $key = Assert-LocalPath ([string]$script:config.sshKeyPath) 'sshKeyPath'
    Assert-NoHostReparsePoints $key
    Assert-PrivateFile $key
    if ([string]$script:config.sshUser -cnotmatch '^[a-z_][a-z0-9_-]{0,31}$' -or
        [string]$script:config.sshAuthorizedKey -cnotmatch '^ssh-ed25519 [A-Za-z0-9+/=]+$') { throw 'Invalid SSH guest identity.' }
    return $id
  }
  $script:config.credentialPath = Assert-LocalPath ([string]$script:config.credentialPath) 'credentialPath'
  Assert-NoHostReparsePoints $script:config.credentialPath
  $credentialItem = Get-Item -LiteralPath $script:config.credentialPath -Force
  if ($credentialItem.Length -gt 1048576) {
    throw 'The DPAPI credential export is unexpectedly large.'
  }
  Assert-PrivateFile $script:config.credentialPath
  $credential = Get-Content -LiteralPath $script:config.credentialPath -Raw | ConvertFrom-Json
  if ($credential.version -ne 1 -or $credential.protection -cne 'LocalMachine' -or $credential.username -cne 'Administrator') { throw 'Invalid machine-protected guest credential.' }
  Add-Type -AssemblyName System.Security
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($credential.password), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  try { $secure = ConvertTo-SecureString ([Text.Encoding]::UTF8.GetString($bytes)) -AsPlainText -Force }
  finally { [Array]::Clear($bytes, 0, $bytes.Length) }
  $script:credential = [Management.Automation.PSCredential]::new($credential.username, $secure)
  return $id
}

function Test-RunMarker {
  if (-not $script:runDirectory -or -not (Test-Path -LiteralPath $script:runDirectory)) {
    return $false
  }
  $null = Assert-MainMetadata $script:machine
  Assert-PrivateDirectory $script:context.directory
  Assert-PrivateDirectory $script:runDirectory
  $runItem = Get-Item -LiteralPath $script:runDirectory -Force -ErrorAction Stop
  if (-not $runItem.PSIsContainer -or ($runItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The VM resource directory is not owned by this provider.'
  }
  Assert-NoResourceReparsePoints $script:runDirectory
  if (-not (Test-Path -LiteralPath $script:markerPath -PathType Leaf)) {
    return $false
  }
  $markerItem = Get-Item -LiteralPath $script:markerPath -Force -ErrorAction Stop
  if ($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint -or $markerItem.Length -gt 16384) {
    throw 'The provider ownership marker is invalid.'
  }
  Assert-PrivateFile $script:markerPath
  $marker = Get-Content -LiteralPath $script:markerPath -Raw -ErrorAction Stop | ConvertFrom-Json
  $expectedResource = [System.IO.Path]::GetFullPath($script:runDirectory)
  $expectedVm = [System.IO.Path]::GetFullPath((Join-Path $expectedResource 'vm'))
  $expectedDisk = [System.IO.Path]::GetFullPath((Join-Path $expectedVm 'disk.vhdx'))
  $expectedBase = [System.IO.Path]::GetFullPath([string]$script:machine.baseImage)
  $expectedNotes = "GitEdge disposable runner $($script:context.id)"
  if ([int]$marker.version -ne 2 -or [string]$marker.driver -cne 'hyperv' -or
      [string]$marker.id -cne [string]$script:context.id -or [string]$marker.name -cne [string]$script:vmName -or
      [System.IO.Path]::GetFullPath([string]$marker.resourceDirectory) -ine $expectedResource -or
      [System.IO.Path]::GetFullPath([string]$marker.vmDirectory) -ine $expectedVm -or
      [System.IO.Path]::GetFullPath([string]$marker.diskPath) -ine $expectedDisk -or
      [System.IO.Path]::GetFullPath([string]$marker.baseImage) -ine $expectedBase -or
      [string]$marker.notes -cne $expectedNotes -or
      [string]$marker.switchName -cne [string]$script:machine.switchName -or
      [int]$marker.networkPolicyVersion -ne $script:networkPolicyVersion -or
      -not (Test-SameGuestNetwork $marker.guestNetwork $script:machine.guestNetwork) -or
      $marker.hostIPv4Addresses -isnot [System.Array] -or $marker.hostIPv4Addresses.Count -lt 1 -or
      $marker.hostIPv4Addresses.Count -gt 256) {
    throw 'The provider ownership marker does not match this VM resource path.'
  }
  $storedHostAddresses = @()
  foreach ($address in $marker.hostIPv4Addresses) {
    $null = ConvertTo-IPv4Integer ([string]$address) 'owner marker host IPv4 address'
    if ([string]$address -in $storedHostAddresses -or [string]$address -eq [string]$marker.guestNetwork.address) {
      throw 'The provider ownership marker has invalid network addresses.'
    }
    $storedHostAddresses += [string]$address
  }
  if ([string]$script:guestNetwork.gateway -notin $storedHostAddresses) {
    throw 'The provider ownership marker does not include the configured host gateway.'
  }
  $script:ownerMarker = $marker
  return $true
}

function Remove-OwnedResources {
  $hasMarker = Test-RunMarker
  $vm = Get-VM -Name $script:vmName -ErrorAction SilentlyContinue
  if (-not $hasMarker) {
    if ($vm) { throw 'A VM name collision has no matching ownership marker.' }
    if (Test-Path -LiteralPath $script:runDirectory) {
      if ($script:createdRunDirectory) {
        Remove-Item -LiteralPath $script:runDirectory -Recurse -Force -ErrorAction Stop
        $script:createdRunDirectory = $false
        return
      }
      $entries = @(Get-ChildItem -LiteralPath $script:runDirectory -Force -ErrorAction Stop)
      if ($entries.Count -gt 0) { throw 'The unmarked VM resource directory is not empty.' }
      Remove-Item -LiteralPath $script:runDirectory -Force -ErrorAction Stop
    }
    return
  }
  if ($vm) {
    $vmAdapters = @(Get-VMNetworkAdapter -VMName $script:vmName -ErrorAction Stop)
    if ($vmAdapters.Count -gt 1 -or ($vmAdapters.Count -eq 1 -and
        [string]$vmAdapters[0].SwitchName -ine [string]$script:ownerMarker.switchName)) {
      throw 'The VM network adapter does not match the provider ownership marker.'
    }
    if (-not [string]::IsNullOrEmpty([string]$vm.Notes) -and
        [string]$vm.Notes -cne [string]$script:ownerMarker.notes) {
      throw 'The VM notes do not match the provider ownership marker.'
    }
    $vmPath = [System.IO.Path]::GetFullPath([string]$vm.Path).TrimEnd('\')
    $vmDirectory = [System.IO.Path]::GetFullPath([string]$script:ownerMarker.vmDirectory).TrimEnd('\')
    $vmPrefix = $vmDirectory + '\'
    if ($vmPath -ine $vmDirectory -and -not $vmPath.StartsWith($vmPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'The VM path does not match the owned resource directory.'
    }
    $drives = @(Get-VMHardDiskDrive -VMName $script:vmName -ErrorAction Stop)
    if ($drives.Count -ne 1 -or [System.IO.Path]::GetFullPath([string]$drives[0].Path) -ine
        [System.IO.Path]::GetFullPath([string]$script:ownerMarker.diskPath)) {
      throw 'The VM disk path does not match the provider ownership marker.'
    }
    if (Test-Path -LiteralPath ([string]$script:ownerMarker.diskPath) -PathType Leaf) {
      $vhd = Get-VHD -Path ([string]$script:ownerMarker.diskPath) -ErrorAction Stop
      if ($vhd.VhdType -ne 'Differencing' -or
          [System.IO.Path]::GetFullPath([string]$vhd.ParentPath) -ine
            [System.IO.Path]::GetFullPath([string]$script:ownerMarker.baseImage)) {
        throw 'The VM differencing disk parent does not match the provider ownership marker.'
      }
    }
  }
  if ($script:session) {
    try {
      $null = Invoke-Command -Session $script:session -ScriptBlock {
        param($ControlDirectory)
        if (Test-Path -LiteralPath $ControlDirectory) {
          Remove-Item -LiteralPath $ControlDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
      } -ArgumentList $script:guestControlDirectory -ErrorAction SilentlyContinue
    } catch {}
    try { Remove-PSSession -Session $script:session -ErrorAction SilentlyContinue } catch {}
    $script:session = $null
  }
  if ($vm) {
    if ($vm.State -ne 'Off') {
      $null = Stop-VM -Name $script:vmName -TurnOff -Force -Confirm:$false -ErrorAction Stop
    }
    $null = Remove-VM -Name $script:vmName -Force -Confirm:$false -ErrorAction Stop
  }
  Remove-Item -LiteralPath $script:runDirectory -Recurse -Force -ErrorAction Stop
  $script:createdRunDirectory = $false
  if ((Get-VM -Name $script:vmName -ErrorAction SilentlyContinue) -or
      (Test-Path -LiteralPath $script:runDirectory)) {
    throw 'The owned VM resources remain after cleanup.'
  }
}

function Get-GuestPath([string]$Path, [bool]$AllowRoot = $false) {
  $fullRoot = [System.IO.Path]::GetFullPath([string]$script:config.guestRoot).TrimEnd('\')
  $fullPath = Assert-LocalPath $Path 'guest path'
  if ($AllowRoot -and $fullPath.TrimEnd('\') -ieq $fullRoot) { return $fullPath }
  $prefix = $fullRoot + '\'
  if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Guest paths must remain within guestRoot.'
  }
  return $fullPath
}

function Invoke-GuestPathOperation([string]$Path, [string]$Operation, [string]$Data, [int]$MaxBytes) {
  $fullPath = Get-GuestPath $Path
  $result = Invoke-Command -Session $script:session -ArgumentList @(
    [string]$script:config.guestRoot, $fullPath, $Operation, $Data, $MaxBytes
  ) -ScriptBlock {
    param($Root, $Candidate, $OperationName, $EncodedData, $Limit)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $pathFull = [System.IO.Path]::GetFullPath($Candidate)
    $prefix = $rootFull + '\'
    if (-not $pathFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Path escaped the guest root.'
    }
    $rootCurrent = [System.IO.Path]::GetPathRoot($rootFull)
    foreach ($rootPart in $rootFull.Substring($rootCurrent.Length).Split('\')) {
      if (-not $rootPart) { continue }
      $rootCurrent = Join-Path $rootCurrent $rootPart
      if (Test-Path -LiteralPath $rootCurrent) {
        $rootItem = Get-Item -LiteralPath $rootCurrent -Force
        if ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
          throw 'Guest root contains a reparse point.'
        }
      }
    }
    $relative = $pathFull.Substring($prefix.Length)
    $current = $rootFull
    foreach ($part in $relative.Split('\')) {
      $current = Join-Path $current $part
      if (Test-Path -LiteralPath $current) {
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
          throw 'Reparse points are not allowed in guest paths.'
        }
      }
    }
    switch ($OperationName) {
      'mkdir' {
        $null = [System.IO.Directory]::CreateDirectory($pathFull)
        return @{ ok = $true }
      }
      'writeFile' {
        $bytes = [System.Convert]::FromBase64String($EncodedData)
        $parent = [System.IO.Path]::GetDirectoryName($pathFull)
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
          throw 'The guest parent directory does not exist.'
        }
        [System.IO.File]::WriteAllBytes($pathFull, $bytes)
        return @{ ok = $true }
      }
      'readFile' {
        if (-not (Test-Path -LiteralPath $pathFull -PathType Leaf)) {
          throw 'The guest file does not exist.'
        }
        $info = Get-Item -LiteralPath $pathFull -Force
        if ($info.Length -gt $Limit) { throw 'The guest file exceeds maxBytes.' }
        $stream = [System.IO.File]::OpenRead($pathFull)
        try {
          $bytes = New-Object byte[] ($Limit + 1)
          $length = 0
          do {
            $read = $stream.Read($bytes, $length, $bytes.Length - $length)
            $length += $read
            if ($length -gt $Limit) { throw 'The guest file exceeds maxBytes.' }
          } while ($read -gt 0)
          return @{ data = [System.Convert]::ToBase64String($bytes, 0, $length) }
        } finally {
          $stream.Dispose()
        }
      }
      default { throw 'Unknown guest path operation.' }
    }
  } -ErrorAction Stop
  return $result
}

function Quote-WindowsArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = New-Object System.Text.StringBuilder
  $quote = [char]34
  $slash = [string][char]92
  $null = $builder.Append($quote)
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $slashes++
    } elseif ($character -eq $quote) {
      $escaped = $slash * (2 * $slashes + 1)
      $null = $builder.Append($escaped).Append($quote)
      $slashes = 0
    } else {
      if ($slashes -gt 0) { $null = $builder.Append($slash * $slashes); $slashes = 0 }
      $null = $builder.Append($character)
    }
  }
  if ($slashes -gt 0) { $null = $builder.Append($slash * (2 * $slashes)) }
  $null = $builder.Append($quote)
  return $builder.ToString()
}

function Wait-ForGuestSession {
  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $deadline) {
    if (Test-ProtocolLine) {
      $line = Read-ProtocolLine
      if ($null -eq $line) { throw 'The controller disconnected during guest startup.' }
      $message = ConvertFrom-Json -InputObject $line
      if ([string]$message.op -eq 'cancel' -or [string]$message.op -eq 'dispose') {
        throw 'Guest startup was cancelled.'
      }
    }
    try {
      $script:session = New-PSSession -VMName $script:vmName -Credential $script:credential `
        -ConfigurationName Microsoft.PowerShell -ErrorAction Stop
      $null = Invoke-Command -Session $script:session -ScriptBlock { [Environment]::MachineName } -ErrorAction Stop
      return
    } catch {
      if ($script:session) {
        try { Remove-PSSession -Session $script:session -ErrorAction SilentlyContinue } catch {}
        $script:session = $null
      }
      Start-Sleep -Seconds 1
    }
  }
  throw 'PowerShell Direct guest readiness timed out.'
}

function Configure-GuestNetwork {
  $networkJson = ConvertTo-Json -InputObject $script:guestNetwork -Depth 4 -Compress
  $null = Invoke-Command -Session $script:session -ArgumentList $networkJson -ScriptBlock {
    param($NetworkJson)
    $network = ConvertFrom-Json -InputObject $NetworkJson
    $adapters = @(Get-NetAdapter -ErrorAction Stop | Where-Object {
      [string]$_.InterfaceDescription -like 'Microsoft Hyper-V Network Adapter*'
    })
    if ($adapters.Count -ne 1 -or [string]$adapters[0].Status -ine 'Up') {
      throw 'The guest must have exactly one active Hyper-V network adapter.'
    }
    $interfaceIndex = [int]$adapters[0].ifIndex
    $null = Set-NetIPInterface -InterfaceIndex $interfaceIndex -AddressFamily IPv4 -Dhcp Disabled -ErrorAction Stop
    $oldAddresses = @(Get-NetIPAddress -InterfaceIndex $interfaceIndex -AddressFamily IPv4 -ErrorAction Stop)
    if ($oldAddresses.Count -gt 0) {
      $null = $oldAddresses | Remove-NetIPAddress -Confirm:$false -ErrorAction Stop
    }
    $null = New-NetIPAddress -InterfaceIndex $interfaceIndex -AddressFamily IPv4 -IPAddress ([string]$network.address) `
      -PrefixLength ([int]$network.prefixLength) -DefaultGateway ([string]$network.gateway) -ErrorAction Stop
    $null = Set-DnsClientServerAddress -InterfaceIndex $interfaceIndex -ResetServerAddresses -ErrorAction Stop
    $null = Set-DnsClientServerAddress -InterfaceIndex $interfaceIndex -ServerAddresses ([string[]]$network.dns) -ErrorAction Stop

    $deadline = (Get-Date).AddSeconds(30)
    $assigned = @()
    do {
      $assigned = @(Get-NetIPAddress -InterfaceIndex $interfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { [string]$_.IPAddress -ceq [string]$network.address })
      if ($assigned.Count -eq 1 -and [string]$assigned[0].AddressState -eq 'Duplicate') {
        throw 'The guest IPv4 address failed duplicate address detection.'
      }
      if ($assigned.Count -eq 1 -and [string]$assigned[0].AddressState -eq 'Preferred') { break }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if ($assigned.Count -ne 1 -or [string]$assigned[0].AddressState -ne 'Preferred' -or
        [int]$assigned[0].PrefixLength -ne [int]$network.prefixLength) {
      throw 'The guest static IPv4 configuration did not become preferred.'
    }
    $defaultRoutes = @(Get-NetRoute -InterfaceIndex $interfaceIndex -AddressFamily IPv4 `
      -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)
    if ($defaultRoutes.Count -ne 1 -or [string]$defaultRoutes[0].NextHop -cne [string]$network.gateway) {
      throw 'The guest IPv4 default route does not match the configured gateway.'
    }
    $dns4 = @(Get-DnsClientServerAddress -InterfaceIndex $interfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
      Select-Object -ExpandProperty ServerAddresses)
    $dns6 = @(Get-DnsClientServerAddress -InterfaceIndex $interfaceIndex -AddressFamily IPv6 -ErrorAction Stop |
      Select-Object -ExpandProperty ServerAddresses)
    if (($dns4 -join ',') -cne (@($network.dns) -join ',') -or $dns6.Count -gt 0) {
      throw 'The guest interface DNS servers do not match the public IPv4 configuration.'
    }
    return @{ address = [string]$network.address; gateway = [string]$network.gateway }
  } -ErrorAction Stop
}

function Initialize-Guest([string]$GuestAgent) {
  $root = [string]$script:config.guestRoot
  $node = [string]$script:config.guestNode
  $agentPath = [System.IO.Path]::Combine($root, 'agent.mjs')
  $control = $script:guestControlDirectory
  $null = Invoke-Command -Session $script:session -ArgumentList @($root, $node, $agentPath, $control, $GuestAgent) -ScriptBlock {
    param($GuestRoot, $GuestNode, $AgentPath, $ControlDirectory, $AgentSource)
    $rootFull = [System.IO.Path]::GetFullPath($GuestRoot).TrimEnd('\')
    $nodeFull = [System.IO.Path]::GetFullPath($GuestNode)
    $agentFull = [System.IO.Path]::GetFullPath($AgentPath)
    $controlFull = [System.IO.Path]::GetFullPath($ControlDirectory)
    if (-not $nodeFull.StartsWith(([System.IO.Path]::GetPathRoot($nodeFull)), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Invalid guest Node path.'
    }
    foreach ($candidate in @($rootFull, $nodeFull, $agentFull, $controlFull)) {
      if ($candidate.StartsWith('\\?\') -or $candidate.StartsWith('\\.\') -or $candidate -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'Invalid guest path.'
      }
    }
    $rootPrefix = $rootFull + '\'
    if (-not $agentFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $controlFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Guest support files must remain inside guestRoot.'
    }
    foreach ($pathToCheck in @($rootFull, $nodeFull)) {
      $current = [System.IO.Path]::GetPathRoot($pathToCheck)
      foreach ($part in $pathToCheck.Substring($current.Length).Split('\')) {
        if (-not $part) { continue }
        $current = Join-Path $current $part
        if (Test-Path -LiteralPath $current) {
          $item = Get-Item -LiteralPath $current -Force
          if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'Guest paths may not contain reparse points.'
          }
        }
      }
    }
    if (-not (Test-Path -LiteralPath $nodeFull -PathType Leaf)) {
      throw 'The configured guest Node executable is missing.'
    }
    $nodeItem = Get-Item -LiteralPath $nodeFull -Force
    if ($nodeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw 'The configured guest Node executable is a reparse point.'
    }
    if (Test-Path -LiteralPath $agentFull) { throw 'The guest agent path already exists.' }
    if (Test-Path -LiteralPath $controlFull) { throw 'The guest control path already exists.' }
    $null = [System.IO.Directory]::CreateDirectory($rootFull)
    [System.IO.File]::WriteAllText($agentFull, $AgentSource, [System.Text.UTF8Encoding]::new($false))
    $null = [System.IO.Directory]::CreateDirectory($controlFull)
  } -ErrorAction Stop
}

function Start-GuestJob([object]$Request) {
  if ($script:job) { throw 'This VM already has a job process.' }
  $command = Assert-LocalPath ([string]$Request.command) 'command'
  $cwd = Get-GuestPath ([string]$Request.cwd) $true
  if (($null -ne $Request.args -and $Request.args -isnot [System.Array]) -or
      @($Request.args | Where-Object { $_ -isnot [string] -or $_.Contains([char]0) }).Count -gt 0) {
    throw 'Job arguments are invalid.'
  }
  $inputBase64 = [string]$Request.input
  $null = [System.Convert]::FromBase64String($inputBase64)
  $envMap = @{}
  if ($Request.env) {
    foreach ($property in $Request.env.PSObject.Properties) {
      if (-not $property.Name -or $property.Name.Contains('=') -or $property.Name.Contains([char]0) -or
          $property.Value -isnot [string] -or $property.Value.Contains([char]0)) {
        throw 'Job environment is invalid.'
      }
      $envMap[$property.Name] = $property.Value
    }
  }
  $jobId = [Guid]::NewGuid().ToString('N')
  $jobDirectory = [System.IO.Path]::Combine($script:guestControlDirectory, $jobId)
  $inputPath = [System.IO.Path]::Combine($jobDirectory, 'request.json')
  $stdoutPath = [System.IO.Path]::Combine($jobDirectory, 'stdout.bin')
  $stderrPath = [System.IO.Path]::Combine($jobDirectory, 'stderr.bin')
  $hostOutputDirectory = Join-Path $script:runDirectory 'output'
  $hostStdout = Join-Path $hostOutputDirectory 'stdout.bin'
  $hostStderr = Join-Path $hostOutputDirectory 'stderr.bin'
  $agentPath = [System.IO.Path]::Combine($script:config.guestRoot, 'agent.mjs')
  $nodePath = [string]$script:config.guestNode
  $agentArguments = Quote-WindowsArgument $agentPath
  $jobPayload = [ordered]@{
    op = 'exec'
    command = $command
    args = @($Request.args)
    cwd = $cwd
    env = $envMap
    input = $inputBase64
  }
  $jobJson = ConvertTo-Json -InputObject $jobPayload -Depth 20 -Compress

  $null = Invoke-Command -Session $script:session -ArgumentList @(
    $jobDirectory, $inputPath, $stdoutPath, $stderrPath, $jobJson
  ) -ScriptBlock {
    param($JobDirectory, $InputFile, $StdoutFile, $StderrFile, $Json)
    $null = [System.IO.Directory]::CreateDirectory($JobDirectory)
    [System.IO.File]::WriteAllText($InputFile, $Json, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllBytes($StdoutFile, [byte[]]@())
    [System.IO.File]::WriteAllBytes($StderrFile, [byte[]]@())
  } -ErrorAction Stop
  $null = [System.IO.Directory]::CreateDirectory($hostOutputDirectory)
  $process = Invoke-Command -Session $script:session -ArgumentList @(
    $nodePath, $agentArguments, $inputPath, $stdoutPath, $stderrPath
  ) -ScriptBlock {
    param($Node, $Arguments, $InputFile, $StdoutFile, $StderrFile)
    $info = [System.Diagnostics.ProcessStartInfo]::new($Node, $Arguments)
    $info.WorkingDirectory = [System.IO.Path]::GetDirectoryName($InputFile)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $encoding = [System.Text.UTF8Encoding]::new($false)
    $info.StandardOutputEncoding = $encoding
    $info.StandardErrorEncoding = $encoding
    $started = [System.Diagnostics.Process]::Start($info)
    $global:GitEdgeHypervJobProcess = $started
    $global:GitEdgeHypervJobStdout = $started.StandardOutput.ReadToEndAsync()
    $global:GitEdgeHypervJobStderr = $started.StandardError.ReadToEndAsync()
    $global:GitEdgeHypervJobStdoutPath = $StdoutFile
    $global:GitEdgeHypervJobStderrPath = $StderrFile
    $inputBytes = $encoding.GetBytes([System.IO.File]::ReadAllText($InputFile))
    $started.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $started.StandardInput.Close()
    return [int]$started.Id
  } -ErrorAction Stop
  $script:job = @{
    id = $jobId
    processId = [int]$process
    guestDirectory = $jobDirectory
    inputPath = $inputPath
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    hostStdout = $hostStdout
    hostStderr = $hostStderr
  }
  return @{ jobId = $jobId }
}

function Poll-GuestJob([string]$JobId) {
  if (-not $script:job -or $script:job.id -cne $JobId) { throw 'Unknown job process.' }
  $state = Invoke-Command -Session $script:session -ArgumentList $script:job.processId -ScriptBlock {
    param($ProcessId)
    $process = $global:GitEdgeHypervJobProcess
    if (-not $process -or [int]$process.Id -ne [int]$ProcessId) {
      return @{ running = $false; code = 125 }
    }
    if (-not $process.HasExited) { return @{ running = $true } }
    $process.WaitForExit()
    $exitCode = [int]$process.ExitCode
    [System.IO.File]::WriteAllText($global:GitEdgeHypervJobStdoutPath,
      $global:GitEdgeHypervJobStdout.GetAwaiter().GetResult(), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($global:GitEdgeHypervJobStderrPath,
      $global:GitEdgeHypervJobStderr.GetAwaiter().GetResult(), [System.Text.UTF8Encoding]::new($false))
    $global:GitEdgeHypervJobProcess.Dispose()
    $global:GitEdgeHypervJobProcess = $null
    $global:GitEdgeHypervJobStdout = $null
    $global:GitEdgeHypervJobStderr = $null
    return @{ running = $false; code = $exitCode }
  } -ErrorAction Stop
  if ($state.running) { return @{ running = $true } }

  $sizes = Invoke-Command -Session $script:session -ArgumentList @($script:job.stdoutPath, $script:job.stderrPath) -ScriptBlock {
    param($StdoutFile, $StderrFile)
    return @{
      stdout = [long](Get-Item -LiteralPath $StdoutFile -ErrorAction Stop).Length
      stderr = [long](Get-Item -LiteralPath $StderrFile -ErrorAction Stop).Length
    }
  } -ErrorAction Stop
  if ($sizes.stdout -gt 65536 -or $sizes.stderr -gt 65536) {
    throw 'The guest job output exceeded its size limit.'
  }

  $null = Copy-Item -FromSession $script:session -LiteralPath $script:job.stdoutPath -Destination $script:job.hostStdout -ErrorAction Stop
  $null = Copy-Item -FromSession $script:session -LiteralPath $script:job.stderrPath -Destination $script:job.hostStderr -ErrorAction Stop
  $script:job.processId = 0
  return @{ running = $false; code = [int]$state.code }
}

function Complete-GuestJob([string]$JobId) {
  if (-not $script:job -or $script:job.id -cne $JobId -or $script:job.processId -ne 0) {
    throw 'The guest job is not complete.'
  }
  $null = Invoke-Command -Session $script:session -ArgumentList $script:job.guestDirectory -ScriptBlock {
    param($Directory)
    if (Test-Path -LiteralPath $Directory) {
      Remove-Item -LiteralPath $Directory -Recurse -Force -ErrorAction Stop
    }
  } -ErrorAction Stop
  $script:job = $null
}

function Invoke-Create([object]$Request) {
  $script:config = $Request.config
  $script:context = $Request.context
  $script:machine = $Request.machine
  if ($null -eq $script:config -or $null -eq $script:context) { throw 'Initial configuration is missing.' }
  if ($null -eq $script:machine) { throw 'Machine metadata is missing.' }
  $null = Assert-Config
  if ([System.IO.Path]::GetFullPath([string]$script:config.baseImage) -ine
        [System.IO.Path]::GetFullPath([string]$script:machine.baseImage) -or
      [string]$script:config.guestRoot -cne [string]$script:machine.guestRoot -or
      [string]$script:config.guestNode -cne [string]$script:machine.guestNode -or
      [int]$script:config.cpus -ne [int]$script:machine.cpus -or
      [long]$script:config.memoryMiB -ne [long]$script:machine.memoryMiB -or
      [string]$script:config.switchName -ine [string]$script:machine.switchName) {
    throw 'The create config does not match the private machine metadata.'
  }
  $null = Assert-MainMetadata $script:machine

  $null = [System.IO.Directory]::CreateDirectory($script:runDirectory)
  $script:createdRunDirectory = $true
  Assert-PrivateDirectory $script:runDirectory
  $null = [System.IO.Directory]::CreateDirectory($script:vmDirectory)
  $diskPath = Join-Path $script:vmDirectory 'disk.vhdx'
  $note = "GitEdge disposable runner $($script:context.id)"
  $owner = @{
    version = 2
    driver = 'hyperv'
    id = $script:context.id
    name = $script:vmName
    resourceDirectory = $script:runDirectory
    vmDirectory = $script:vmDirectory
    diskPath = $diskPath
    baseImage = $script:config.baseImage
    notes = $note
    switchName = [string]$script:machine.switchName
    networkPolicyVersion = $script:networkPolicyVersion
    guestNetwork = $script:guestNetwork
    hostIPv4Addresses = [string[]]$script:hostIPv4Addresses
  }
  $null = [System.IO.File]::WriteAllText($script:markerPath, (ConvertTo-Json -InputObject $owner -Depth 8 -Compress), $utf8)
  $null = New-VHD -Path $diskPath -ParentPath $script:config.baseImage -Differencing -ErrorAction Stop
  $basePath = [System.IO.Path]::GetFullPath($script:config.baseImage)
  $differencingDisk = Get-VHD -Path $diskPath -ErrorAction Stop
  if ($differencingDisk.VhdType -ne 'Differencing' -or
      [System.IO.Path]::GetFullPath([string]$differencingDisk.ParentPath) -ine $basePath) {
    throw 'The VM disk is not a differencing child of the configured base image.'
  }
  $startupBytes = [uint64]$script:config.memoryMiB * [uint64]1MB
  $null = New-VM -Name $script:vmName -Generation 2 -MemoryStartupBytes $startupBytes -VHDPath $diskPath `
    -Path $script:vmDirectory -SwitchName ([string]$script:config.switchName) -ErrorAction Stop
  $null = Set-VM -Name $script:vmName -AutomaticCheckpointsEnabled $false -CheckpointType Disabled `
    -Notes $note -ErrorAction Stop
  $null = Set-VMProcessor -VMName $script:vmName -Count ([int]$script:config.cpus) -ErrorAction Stop
  $null = Set-VMMemory -VMName $script:vmName -DynamicMemoryEnabled $false -ErrorAction Stop
  $vmAdapters = @(Get-VMNetworkAdapter -VMName $script:vmName -ErrorAction Stop)
  if ($vmAdapters.Count -ne 1 -or [string]$vmAdapters[0].SwitchName -ine [string]$script:config.switchName) {
    throw 'The new VM must have exactly one adapter on the configured Internal switch.'
  }
  $adapter = $vmAdapters[0]
  $null = Set-VMNetworkAdapter -VMNetworkAdapter $adapter -MacAddressSpoofing Off -DhcpGuard On -RouterGuard On -ErrorAction Stop
  $vmAdapters = @(Get-VMNetworkAdapter -VMName $script:vmName -ErrorAction Stop)
  if ($vmAdapters.Count -ne 1 -or [string]$vmAdapters[0].SwitchName -ine [string]$script:config.switchName -or
      [string]$vmAdapters[0].MacAddressSpoofing -ine 'Off' -or
      [string]$vmAdapters[0].DhcpGuard -ine 'On' -or [string]$vmAdapters[0].RouterGuard -ine 'On') {
    throw 'The new VM network adapter protections were not applied.'
  }
  $adapter = $vmAdapters[0]
  $expectedAclRules = @(Get-ExpectedNetworkAclRules $script:hostIPv4Addresses)
  Add-ExpectedNetworkAclRules $adapter $expectedAclRules
  Assert-NetworkAclRules $adapter $expectedAclRules
  if ([string]$script:machine.guestPlatform -eq 'linux') {
    $iso = Join-Path $script:runDirectory 'seed.iso'
    New-NoCloudIso $script:runDirectory $iso $script:guestNetwork ([string]$script:context.id) ([string]$script:config.sshUser) ([string]$script:config.sshAuthorizedKey)
    Add-VMDvdDrive -VMName $script:vmName -Path $iso -ErrorAction Stop | Out-Null
    Set-VMFirmware -VMName $script:vmName -SecureBootTemplate MicrosoftUEFICertificateAuthority -ErrorAction Stop | Out-Null
    Start-VM -Name $script:vmName -ErrorAction Stop | Out-Null
    return
  }
  $null = Start-VM -Name $script:vmName -ErrorAction Stop
  Wait-ForGuestSession
  Configure-GuestNetwork
  if ($null -eq $Request.guestAgent -or [string]::IsNullOrWhiteSpace([string]$Request.guestAgent)) {
    throw 'The guest Node agent source is invalid.'
  }
  Initialize-Guest ([string]$Request.guestAgent)
}

function Invoke-CleanupRequest([object]$Request) {
  $script:config = $null
  $script:machine = $Request.machine
  $script:context = $Request.context
  if ($null -eq $script:context -or $null -eq $script:machine) { throw 'Cleanup context is missing.' }
  $id = [string]$script:context.id
  if ($id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'The job identifier is invalid.'
  }
  $script:context.directory = Assert-LocalPath ([string]$script:context.directory) 'run directory'
  Assert-PrivateDirectory $script:context.directory
  $null = Assert-MainMetadata $script:machine
  $script:vmName = "ge-$id"
  $script:runDirectory = [System.IO.Path]::GetFullPath((Join-Path $script:context.directory $script:vmName))
  $script:vmDirectory = Join-Path $script:runDirectory 'vm'
  $script:markerPath = Join-Path $script:runDirectory 'owner.json'
  if ($script:machine -and $script:machine.guestRoot) {
    $script:guestControlDirectory = [System.IO.Path]::Combine([string]$script:machine.guestRoot, ".ge-$id")
  } else {
    $script:guestControlDirectory = $null
  }
  Remove-OwnedResources
}

function Invoke-RecoveryRequest([object]$Request) {
  $script:config = $null
  $script:session = $null
  $script:machine = $Request.machine
  $script:context = $Request.context
  if ($null -eq $script:context -or $null -eq $script:machine) {
    throw 'Recovery context is missing.'
  }
  $id = [string]$script:context.id
  if ($id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'The job identifier is invalid.'
  }
  $script:context.directory = Assert-LocalPath ([string]$script:context.directory) 'run directory'
  Assert-PrivateDirectory $script:context.directory
  $null = Assert-MainMetadata $script:machine
  $script:vmName = "ge-$id"
  $script:runDirectory = [System.IO.Path]::GetFullPath((Join-Path $script:context.directory $script:vmName))
  $script:vmDirectory = Join-Path $script:runDirectory 'vm'
  $script:markerPath = Join-Path $script:runDirectory 'owner.json'
  $script:guestControlDirectory = [System.IO.Path]::Combine([string]$script:machine.guestRoot, ".ge-$id")
  $script:createdRunDirectory = $false

  if (-not (Get-VM -Name $script:vmName -ErrorAction SilentlyContinue) -and
      -not (Test-Path -LiteralPath $script:runDirectory)) {
    return
  }
  Remove-OwnedResources
  if ((Get-VM -Name $script:vmName -ErrorAction SilentlyContinue) -or
      (Test-Path -LiteralPath $script:runDirectory)) {
    throw 'The residual Hyper-V VM resources remain after recovery.'
  }
}

function Process-Request([object]$Request) {
  $id = [long]$Request.id
  try {
    switch ([string]$Request.op) {
      'mkdir' {
        $null = Invoke-GuestPathOperation ([string]$Request.path) 'mkdir' '' 0
        Write-Protocol @{ id = $id; ok = $true; result = @{} }
      }
      'writeFile' {
        if ([string]$Request.data -notmatch '^[A-Za-z0-9+/]*={0,2}$') { throw 'File data is invalid.' }
        $null = Invoke-GuestPathOperation ([string]$Request.path) 'writeFile' ([string]$Request.data) 0
        Write-Protocol @{ id = $id; ok = $true; result = @{} }
      }
      'readFile' {
        $max = [int]$Request.maxBytes
        if ($max -lt 0 -or $max -gt 16777216) { throw 'maxBytes is invalid.' }
        $data = Invoke-GuestPathOperation ([string]$Request.path) 'readFile' '' $max
        Write-Protocol @{ id = $id; ok = $true; result = @{ data = [string]$data.data } }
      }
      'start' {
        $result = Start-GuestJob $Request
        Write-Protocol @{ id = $id; ok = $true; result = $result }
      }
      'poll' {
        $result = Poll-GuestJob ([string]$Request.jobId)
        if (-not $result.running) { $script:completedCode = [int]$result.code }
        Write-Protocol @{ id = $id; ok = $true; result = $result }
      }
      'complete' {
        Complete-GuestJob ([string]$Request.jobId)
        Write-Protocol @{ id = $id; ok = $true; result = @{} }
      }
      'dispose' {
        Remove-OwnedResources
        Write-Protocol @{ id = $id; ok = $true; result = @{} }
        $script:finished = $true
      }
      'cancel' {
        Remove-OwnedResources
        Write-Protocol @{ id = $id; ok = $true; result = @{} }
        $script:finished = $true
      }
      default { throw 'Unknown Hyper-V operation.' }
    }
  } catch {
    Write-Protocol @{ id = $id; ok = $false; error = 'The Hyper-V operation failed.' }
  }
}

try {
  $initialLine = $script:reader.ReadLine()
  if ($null -eq $initialLine) { exit 2 }
  $initial = ConvertFrom-Json -InputObject $initialLine
  if ([string]$initial.op -eq 'cleanup') {
    Invoke-CleanupRequest $initial
    Write-Protocol @{ type = 'cleaned' }
    exit 0
  }
  if ([string]$initial.op -eq 'recover') {
    Invoke-RecoveryRequest $initial
    Write-Protocol @{ type = 'recovered' }
    exit 0
  }
  if ([string]$initial.op -ne 'create') { throw 'Unknown initialization operation.' }
  Start-ProtocolRead
  Invoke-Create $initial
  Write-Protocol @{ type = 'ready' }
  $script:finished = $false
  while (-not $script:finished) {
    $line = Read-ProtocolLine
    if ($null -eq $line) { break }
    Process-Request (ConvertFrom-Json -InputObject $line)
  }
  if (-not $script:finished) { Remove-OwnedResources }
} catch {
  if ($script:runDirectory -and $script:context -and $script:vmName) {
    try { Remove-OwnedResources } catch {}
  }
  try { Write-Protocol @{ type = 'fatal'; error = ('Hyper-V guest setup failed: ' + $_.Exception.Message).Substring(0, [Math]::Min(400, ('Hyper-V guest setup failed: ' + $_.Exception.Message).Length)) } } catch {}
  exit 1
} finally {
  if ($script:session) {
    try { Remove-PSSession -Session $script:session -ErrorAction SilentlyContinue } catch {}
  }
}

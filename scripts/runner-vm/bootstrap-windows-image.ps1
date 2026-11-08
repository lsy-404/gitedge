[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$BrokerArchive,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$BrokerArchiveSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^24\.\d+\.\d+$')][string]$NodeVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$NodeSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+\.windows\.\d+$')][string]$PortableGitVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$PortableGitSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$PowerShellVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$PowerShellSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ActionsRunnerVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$ActionsRunnerSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$PnpmSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$PythonSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$RustToolchainVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$RustupSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('(?i)^[0-9a-f]{64}$')][string]$BuildToolsSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+(\.\d+){2,3}$')][string]$BuildToolsBootstrapperFileVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+(\.\d+){2,3}$')][string]$BuildToolsProductVersion,
  [string]$ArtifactDirectory,
  [switch]$ApplyImageBootstrap,
  [switch]$AcceptBuildToolsLicense
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-LocalPath([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f<>"|?*]' -or
      $Value -notmatch '^[a-zA-Z]:[\\/]' -or $Value.StartsWith('\\?\') -or
      $Value.StartsWith('\\.\') -or $Value -match '(^|[\\/])\.\.([\\/]|$)' -or
      $Value.Substring(2).Contains(':')) {
    throw "$Label must be an absolute local Windows path without traversal or special characters."
  }
  return [System.IO.Path]::GetFullPath($Value)
}

function Assert-NoReparsePath([string]$Path) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $current = [System.IO.Path]::GetPathRoot($fullPath)
  foreach ($part in $fullPath.Substring($current.Length).Split('\')) {
    if (-not $part) { continue }
    $current = Join-Path $current $part
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'Guest install paths may not contain reparse points.'
      }
    }
  }
}

function Assert-NoReparseTree([string]$Path) {
  Assert-NoReparsePath $Path
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $root = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $root.PSIsContainer) { return }
  $pending = New-Object System.Collections.Stack
  $pending.Push($root.FullName)
  while ($pending.Count -gt 0) {
    $directory = [string]$pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'Bootstrap staging paths may not contain reparse points.'
      }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
}

function Assert-GuestIdentity {
  $computer = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
  if ([string]$computer.Model -ine 'Virtual Machine') {
    throw 'Image bootstrap is restricted to a Hyper-V virtual machine.'
  }
  $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
  if ([string]$operatingSystem.Caption -notmatch 'Windows Server 2022') {
    throw 'Image bootstrap requires Windows Server 2022.'
  }
  $setup = Get-ItemProperty 'HKLM:\SYSTEM\Setup'
  if ($setup.OOBEInProgress -eq 1 -or $setup.SystemSetupInProgress -eq 1) {
    throw 'Wait for Windows setup and first logon to complete before installing image tools.'
  }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($identity.User.Value -notmatch '-500$') {
    throw 'Run image bootstrap under the guest built-in Administrator account.'
  }
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run image bootstrap from an elevated guest Administrator session.'
  }
  $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if ([string]::IsNullOrWhiteSpace($profile) -or -not (Test-Path -LiteralPath $profile -PathType Container)) {
    throw 'The guest Administrator profile is not available.'
  }
  return [System.IO.Path]::GetFullPath($profile)
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
  $actual = Get-Sha256 $Path
  if ($actual -cne $Expected.ToLowerInvariant()) {
    throw "$Label SHA256 did not match the supplied value."
  }
}

function Get-VerifiedDownload([string]$Uri, [string]$FileName, [string]$Sha256, [string]$Directory, [string]$ArtifactDirectory) {
  $destination = Join-Path $Directory $FileName
  if (Test-Path -LiteralPath $destination) {
    Assert-NoReparsePath $destination
    Assert-Sha256 $destination $Sha256 $FileName
    return $destination
  }
  $temporary = Join-Path $Directory ('.download-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    if ($ArtifactDirectory) {
      $source = Join-Path $ArtifactDirectory $FileName
      if (Test-Path -LiteralPath $source) {
        Assert-NoReparsePath $source
        $sourceItem = Get-Item -LiteralPath $source -Force -ErrorAction Stop
        if ($sourceItem.PSIsContainer) { throw "Pre-staged artifact is not a regular file: $FileName" }
        Assert-Sha256 $source $Sha256 $FileName
        Copy-Item -LiteralPath $source -Destination $temporary -ErrorAction Stop
        Assert-Sha256 $temporary $Sha256 "Copied $FileName"
        Move-Item -LiteralPath $temporary -Destination $destination -ErrorAction Stop
        return $destination
      }
    }
    & curl.exe --fail --location --proto '=https' --proto-redir '=https' --retry 2 `
      --connect-timeout 15 --max-time 1800 --output $temporary $Uri
    if ($LASTEXITCODE -ne 0) { throw "Download failed for $FileName." }
    Assert-Sha256 $temporary $Sha256 $FileName
    Move-Item -LiteralPath $temporary -Destination $destination -ErrorAction Stop
    return $destination
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-VerifiedBrokerArchive([string]$Source, [string]$Sha256, [string]$Directory) {
  $fullSource = Assert-LocalPath $Source 'BrokerArchive'
  Assert-NoReparsePath $fullSource
  $sourceItem = Get-Item -LiteralPath $fullSource -Force -ErrorAction Stop
  if ($sourceItem.PSIsContainer) { throw 'BrokerArchive must be a regular archive file.' }
  Assert-Sha256 $fullSource $Sha256 'BrokerArchive'
  $extension = if ($fullSource -match '(?i)\.tar\.gz$') { '.tar.gz' } else { [System.IO.Path]::GetExtension($fullSource) }
  if ($extension -notin @('.zip', '.tar', '.tar.gz', '.tgz')) { throw 'BrokerArchive must be a zip or tar archive.' }
  $destination = Join-Path $Directory ("broker-source$extension")
  if (Test-Path -LiteralPath $destination) {
    Assert-NoReparsePath $destination
    Assert-Sha256 $destination $Sha256 'Staged BrokerArchive'
  } else {
    Copy-Item -LiteralPath $fullSource -Destination $destination -ErrorAction Stop
    Assert-Sha256 $destination $Sha256 'Staged BrokerArchive'
  }
  return $destination
}

function Assert-ArchiveEntries([string]$Archive, [string]$Extension) {
  if ($Extension -eq '.zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    try {
      foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ($name.StartsWith('/') -or $name -match '^[a-zA-Z]:' -or
            $name.Split('/').Contains('..')) {
          throw 'BrokerArchive contains an unsafe path.'
        }
        $unixMode = ([int]$entry.ExternalAttributes -shr 16) -band 0xF000
        if ($unixMode -eq 0xA000) { throw 'BrokerArchive may not contain symbolic links.' }
      }
    } finally {
      $zip.Dispose()
    }
    return
  }

  $names = @(& tar.exe -tf $Archive)
  if ($LASTEXITCODE -ne 0) { throw 'BrokerArchive could not be listed.' }
  foreach ($name in $names) {
    $normalized = ([string]$name).Replace('\', '/')
    if ($normalized.StartsWith('/') -or $normalized -match '^[a-zA-Z]:' -or
        $normalized.Split('/').Contains('..')) {
      throw 'BrokerArchive contains an unsafe path.'
    }
  }
  $details = @(& tar.exe -tvf $Archive)
  if ($LASTEXITCODE -ne 0) { throw 'BrokerArchive link entries could not be inspected.' }
  foreach ($line in $details) {
    if ([string]$line -match '^[lh]') { throw 'BrokerArchive may not contain links.' }
  }
}

function Expand-BrokerArchive([string]$Archive, [string]$Extension, [string]$Destination) {
  Assert-ArchiveEntries $Archive $Extension
  $null = New-Item -ItemType Directory -Path $Destination -ErrorAction Stop
  if ($Extension -eq '.zip') {
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -ErrorAction Stop
  } else {
    & tar.exe -xf $Archive -C $Destination
    if ($LASTEXITCODE -ne 0) { throw 'BrokerArchive extraction failed.' }
  }
  $pending = New-Object System.Collections.Stack
  $pending.Push($Destination)
  while ($pending.Count -gt 0) {
    $directory = [string]$pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'BrokerArchive extraction produced a reparse point.'
      }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
}

function Get-BrokerSourceRoot([string]$ExtractedRoot) {
  $rootPackage = Join-Path $ExtractedRoot 'package.json'
  if (Test-Path -LiteralPath $rootPackage -PathType Leaf) { return $ExtractedRoot }
  $candidates = @(Get-ChildItem -LiteralPath $ExtractedRoot -Directory -Force |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') -PathType Leaf })
  if ($candidates.Count -ne 1) { throw 'BrokerArchive must contain one package root.' }
  return $candidates[0].FullName
}

function Add-MachinePath([string[]]$Directories) {
  $oldPath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $parts = @($Directories) + @(([string]$oldPath -split ';'))
  $seen = @{}
  $combined = New-Object System.Collections.Generic.List[string]
  foreach ($part in $parts) {
    if ([string]::IsNullOrWhiteSpace([string]$part)) { continue }
    $value = ([string]$part).Trim().TrimEnd('\')
    if (-not $seen.ContainsKey($value)) {
      $seen[$value] = $true
      $combined.Add($value)
    }
  }
  $newPath = $combined -join ';'
  if ($newPath.Length -gt 30000) { throw 'The machine PATH would exceed the supported length.' }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'Machine')
  $env:PATH = $newPath
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$Label) {
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Executable @Arguments 2>&1 | ForEach-Object { Write-Output ([string]$_) }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

if ($AcceptBuildToolsLicense -and -not $ApplyImageBootstrap) {
  throw '-AcceptBuildToolsLicense requires -ApplyImageBootstrap.'
}
if (-not $ApplyImageBootstrap) {
  throw 'No changes were made. Pass -ApplyImageBootstrap to stage and install the guest image.'
}

$profilePath = Assert-GuestIdentity
$InstallRoot = Assert-LocalPath $InstallRoot 'InstallRoot'
if ([System.IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\') -ieq $InstallRoot.TrimEnd('\')) {
  throw 'InstallRoot must be a directory below the guest drive root.'
}
if ($InstallRoot -match '[^a-zA-Z0-9_ .\\:-]' -or $InstallRoot -match '(^|\\)[ .]+(\\|$)' -or
    $InstallRoot -match '[ .](?:\\|$)') {
  throw 'InstallRoot must use a short ASCII path without command-shell metacharacters.'
}
Assert-NoReparsePath $InstallRoot
$BrokerArchive = Assert-LocalPath $BrokerArchive 'BrokerArchive'
if ($ArtifactDirectory) {
  $ArtifactDirectory = Assert-LocalPath $ArtifactDirectory 'ArtifactDirectory'
  if (-not (Test-Path -LiteralPath $ArtifactDirectory -PathType Container)) { throw 'ArtifactDirectory must be an existing directory.' }
  Assert-NoReparsePath $ArtifactDirectory
}
foreach ($hash in @($BrokerArchiveSha256, $NodeSha256, $PortableGitSha256, $PowerShellSha256,
      $ActionsRunnerSha256, $PnpmSha256, $PythonSha256, $RustupSha256, $BuildToolsSha256)) {
  if ($hash -notmatch '(?i)^[0-9a-f]{64}$') { throw 'Every supplied SHA256 must contain 64 hexadecimal characters.' }
}

$stage = Join-Path $InstallRoot '.image-bootstrap-stage'
if (Test-Path -LiteralPath $InstallRoot) {
  $rootItem = Get-Item -LiteralPath $InstallRoot -Force
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'InstallRoot must be a real directory.'
  }
  $otherEntries = @(Get-ChildItem -LiteralPath $InstallRoot -Force | Where-Object { $_.FullName -ine $stage })
  if ($otherEntries.Count -gt 0) {
    throw 'InstallRoot is not clean; discard this guest and use a fresh image.'
  }
} else {
  $null = New-Item -ItemType Directory -Path $InstallRoot -ErrorAction Stop
}
if (-not (Test-Path -LiteralPath $stage)) {
  $null = New-Item -ItemType Directory -Path $stage -ErrorAction Stop
}
Assert-NoReparseTree $stage
$downloads = Join-Path $stage 'downloads'
$sourceExtract = Join-Path $stage 'broker-source'
if (Test-Path -LiteralPath $downloads) {
  Assert-NoReparseTree $downloads
  if (-not (Get-Item -LiteralPath $downloads -Force).PSIsContainer) { throw 'The download staging path is not a directory.' }
} else {
  $null = New-Item -ItemType Directory -Path $downloads -ErrorAction Stop
}

$brokerStaged = Get-VerifiedBrokerArchive $BrokerArchive $BrokerArchiveSha256 $downloads
$brokerExtension = if ($brokerStaged -match '(?i)\.tar\.gz$') { '.tar.gz' } else { [System.IO.Path]::GetExtension($brokerStaged) }
if (Test-Path -LiteralPath $sourceExtract) {
  Assert-NoReparseTree $sourceExtract
  Remove-Item -LiteralPath $sourceExtract -Recurse -Force -ErrorAction Stop
}
Expand-BrokerArchive $brokerStaged $brokerExtension $sourceExtract
$brokerSourceRoot = Get-BrokerSourceRoot $sourceExtract
$package = Get-Content -LiteralPath (Join-Path $brokerSourceRoot 'package.json') -Raw | ConvertFrom-Json
$packageManagerMatch = [regex]::Match([string]$package.packageManager, '^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$')
if ([string]$package.name -cne 'gitedge' -or -not $packageManagerMatch.Success) {
  throw 'The broker source package name or packageManager field is invalid.'
}
$pnpmVersion = $packageManagerMatch.Groups[1].Value
$pythonVersion = '3.14.10'
$dotnetVersion = '8.0.427'
$dotnetSha512 = 'a4dd6eb2bf2a2f6fb10997d3e044a229b23ad96a5c86d20494687e34ee73b537d7bd14488ce14cded6917f6778da4d66360e2734020b7ef487d0f29ab144489d'

$portableGitAssetVersion = $PortableGitVersion -replace '\.windows\.', '.'
$artifactSpecs = @(
  @{ Uri = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"; Name = "node-v$NodeVersion-win-x64.zip"; Sha = $NodeSha256 },
  @{ Uri = "https://github.com/git-for-windows/git/releases/download/v$PortableGitVersion/PortableGit-$portableGitAssetVersion-64-bit.7z.exe"; Name = "PortableGit-$portableGitAssetVersion-64-bit.7z.exe"; Sha = $PortableGitSha256 },
  @{ Uri = "https://github.com/PowerShell/PowerShell/releases/download/v$PowerShellVersion/PowerShell-$PowerShellVersion-win-x64.zip"; Name = "PowerShell-$PowerShellVersion-win-x64.zip"; Sha = $PowerShellSha256 },
  @{ Uri = "https://github.com/actions/runner/releases/download/v$ActionsRunnerVersion/actions-runner-win-x64-$ActionsRunnerVersion.zip"; Name = "actions-runner-win-x64-$ActionsRunnerVersion.zip"; Sha = $ActionsRunnerSha256 },
  @{ Uri = "https://registry.npmjs.org/pnpm/-/pnpm-$pnpmVersion.tgz"; Name = "pnpm-$pnpmVersion.tgz"; Sha = $PnpmSha256 },
  @{ Uri = "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-amd64.exe"; Name = "python-$pythonVersion-amd64.exe"; Sha = $PythonSha256 },
  @{ Uri = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'; Name = 'rustup-init.exe'; Sha = $RustupSha256 },
  @{ Uri = 'https://aka.ms/vs/17/release/vs_BuildTools.exe'; Name = 'vs_BuildTools.exe'; Sha = $BuildToolsSha256 }
)

$plan = [ordered]@{
  brokerArchiveSha256 = $BrokerArchiveSha256.ToLowerInvariant()
  nodeVersion = $NodeVersion
  nodeSha256 = $NodeSha256.ToLowerInvariant()
  portableGitVersion = $PortableGitVersion
  portableGitSha256 = $PortableGitSha256.ToLowerInvariant()
  powerShellVersion = $PowerShellVersion
  powerShellSha256 = $PowerShellSha256.ToLowerInvariant()
  actionsRunnerVersion = $ActionsRunnerVersion
  actionsRunnerSha256 = $ActionsRunnerSha256.ToLowerInvariant()
  pnpmVersion = $pnpmVersion
  pnpmSha256 = $PnpmSha256.ToLowerInvariant()
  pythonVersion = $pythonVersion
  pythonSha256 = $PythonSha256.ToLowerInvariant()
  dotnetVersion = $dotnetVersion
  dotnetSha512 = $dotnetSha512
  rustToolchainVersion = $RustToolchainVersion
  rustupSha256 = $RustupSha256.ToLowerInvariant()
  buildToolsBootstrapperFileVersion = $BuildToolsBootstrapperFileVersion
  buildToolsProductVersion = $BuildToolsProductVersion
  buildToolsSha256 = $BuildToolsSha256.ToLowerInvariant()
}
$planPath = Join-Path $stage 'plan.json'
$planJson = ConvertTo-Json -InputObject $plan -Depth 10 -Compress
if (Test-Path -LiteralPath $planPath) {
  Assert-NoReparsePath $planPath
  $savedPlan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
  $planMismatch = $savedPlan.PSObject.Properties.Count -ne $plan.Count
  foreach ($key in $plan.Keys) {
    $savedProperty = $savedPlan.PSObject.Properties[$key]
    if ($null -eq $savedProperty -or [string]$savedProperty.Value -cne [string]$plan[$key]) {
      $planMismatch = $true
    }
  }
  if ($planMismatch) {
    throw 'Staged image artifacts belong to a different bootstrap plan.'
  }
} else {
  [System.IO.File]::WriteAllText($planPath, $planJson, [System.Text.UTF8Encoding]::new($false))
}

$artifactPaths = @{}
foreach ($spec in $artifactSpecs) {
  $artifactPaths[$spec.Name] = Get-VerifiedDownload $spec.Uri $spec.Name $spec.Sha $downloads $ArtifactDirectory
}
$dotnetArchive = Join-Path $downloads "dotnet-sdk-$dotnetVersion-win-x64.zip"
if (-not (Test-Path -LiteralPath $dotnetArchive)) {
  $dotnetTemporary = Join-Path $downloads ('.download-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $stagedDotnet = if ($ArtifactDirectory) { Join-Path $ArtifactDirectory (Split-Path -Leaf $dotnetArchive) } else { $null }
    if ($stagedDotnet -and (Test-Path -LiteralPath $stagedDotnet -PathType Leaf)) {
      Assert-NoReparsePath $stagedDotnet
      Copy-Item -LiteralPath $stagedDotnet -Destination $dotnetTemporary -ErrorAction Stop
    } else {
      & curl.exe --fail --location --proto '=https' --proto-redir '=https' --retry 2 `
        --connect-timeout 15 --max-time 1800 --output $dotnetTemporary "https://builds.dotnet.microsoft.com/dotnet/Sdk/$dotnetVersion/dotnet-sdk-$dotnetVersion-win-x64.zip"
      if ($LASTEXITCODE -ne 0) { throw 'The .NET SDK download failed.' }
    }
    if ((Get-FileHash -LiteralPath $dotnetTemporary -Algorithm SHA512).Hash -ine $dotnetSha512) { throw 'The .NET SDK checksum did not match.' }
    Move-Item -LiteralPath $dotnetTemporary -Destination $dotnetArchive -ErrorAction Stop
  } finally { if (Test-Path -LiteralPath $dotnetTemporary) { Remove-Item -LiteralPath $dotnetTemporary -Force } }
}
Assert-NoReparsePath $dotnetArchive
if ((Get-FileHash -LiteralPath $dotnetArchive -Algorithm SHA512).Hash -ine $dotnetSha512) { throw 'The .NET SDK checksum did not match.' }
$buildToolsSignature = Get-AuthenticodeSignature -LiteralPath $artifactPaths['vs_BuildTools.exe']
if ($buildToolsSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    [string]$buildToolsSignature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') {
  throw 'The Build Tools bootstrapper does not have a valid Microsoft signature.'
}
$pythonInstaller = $artifactPaths["python-$pythonVersion-amd64.exe"]
$pythonSignature = Get-AuthenticodeSignature -LiteralPath $pythonInstaller
if ($pythonSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    [string]$pythonSignature.SignerCertificate.Subject -notmatch '^CN=Python Software Foundation(?:,|$)') {
  throw 'The Python installer does not have a valid Python Software Foundation signature.'
}
$bootstrapperFileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($artifactPaths['vs_BuildTools.exe']).FileVersion
if ([string]$bootstrapperFileVersion -cne $BuildToolsBootstrapperFileVersion) {
  throw 'The Build Tools bootstrapper file version did not match the supplied version.'
}
if (-not $AcceptBuildToolsLicense) {
  Write-Warning 'Artifacts are staged and verified. No installers were run. Review the Microsoft Build Tools license, then rerun with -ApplyImageBootstrap -AcceptBuildToolsLicense.'
  exit 10
}

$toolsRoot = Join-Path $InstallRoot 'tools'
$nodeRoot = Join-Path $toolsRoot "node-v$NodeVersion-win-x64"
$gitRoot = Join-Path $env:ProgramFiles 'Git'
$powerShellRoot = Join-Path $toolsRoot "powershell-$PowerShellVersion"
$pnpmRoot = Join-Path $toolsRoot 'pnpm'
$pythonRoot = Join-Path $toolsRoot "python-$pythonVersion"
$pythonScripts = Join-Path $pythonRoot 'Scripts'
$pythonExe = Join-Path $pythonRoot 'python.exe'
$actionsRoot = Join-Path $InstallRoot 'actions-runner'
$brokerRoot = Join-Path $InstallRoot 'broker'
$buildToolsRoot = Join-Path $toolsRoot 'BuildTools'
$dotnetRoot = Join-Path $env:ProgramFiles 'dotnet'
$cargoHome = Join-Path $profilePath '.cargo'
$rustupHome = Join-Path $profilePath '.rustup'
$cargoBin = Join-Path $cargoHome 'bin'
$nodeZip = $artifactPaths["node-v$NodeVersion-win-x64.zip"]
$gitInstaller = $artifactPaths["PortableGit-$portableGitAssetVersion-64-bit.7z.exe"]
$powerShellZip = $artifactPaths["PowerShell-$PowerShellVersion-win-x64.zip"]
$actionsZip = $artifactPaths["actions-runner-win-x64-$ActionsRunnerVersion.zip"]
$pnpmTarball = $artifactPaths["pnpm-$pnpmVersion.tgz"]
$rustupInstaller = $artifactPaths['rustup-init.exe']
$buildToolsInstaller = $artifactPaths['vs_BuildTools.exe']

foreach ($destination in @($nodeRoot, $gitRoot, $powerShellRoot, $pnpmRoot, $pythonRoot, $actionsRoot, $brokerRoot, $buildToolsRoot)) {
  if (Test-Path -LiteralPath $destination) { throw "Install destination already exists: $destination" }
}
foreach ($destination in @($cargoHome, $rustupHome)) {
  if (Test-Path -LiteralPath $destination) { throw 'The guest Administrator Rust profile destinations must be absent on a clean image.' }
}
$null = New-Item -ItemType Directory -Path $toolsRoot -ErrorAction Stop

Expand-Archive -LiteralPath $nodeZip -DestinationPath $toolsRoot -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot 'node.exe') -PathType Leaf)) {
  throw 'The Node archive layout was not recognized.'
}

$null = New-Item -ItemType Directory -Path $gitRoot -ErrorAction Stop
$gitArguments = '-y -o"' + $gitRoot + '"'
$gitProcess = Start-Process -FilePath $gitInstaller -ArgumentList $gitArguments -Wait -PassThru -NoNewWindow
if ($gitProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $gitRoot 'bin\bash.exe'))) {
  throw 'Portable Git installation failed.'
}

$null = New-Item -ItemType Directory -Path $powerShellRoot -ErrorAction Stop
Expand-Archive -LiteralPath $powerShellZip -DestinationPath $powerShellRoot -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path $powerShellRoot 'pwsh.exe') -PathType Leaf)) {
  throw 'The PowerShell archive layout was not recognized.'
}

$null = New-Item -ItemType Directory -Path $actionsRoot -ErrorAction Stop
Expand-Archive -LiteralPath $actionsZip -DestinationPath $actionsRoot -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path $actionsRoot 'config.cmd') -PathType Leaf)) {
  throw 'The official Actions runner archive layout was not recognized.'
}

$null = New-Item -ItemType Directory -Path $pnpmRoot -ErrorAction Stop
$npm = Join-Path $nodeRoot 'npm.cmd'
Invoke-Checked $npm @('install', '--global', '--prefix', $pnpmRoot, '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', $pnpmTarball) 'pnpm installation'
if (-not (Test-Path -LiteralPath (Join-Path $pnpmRoot 'pnpm.cmd') -PathType Leaf)) {
  throw 'The project pnpm executable was not installed.'
}

$pythonArguments = "/quiet InstallAllUsers=1 TargetDir=`"$pythonRoot`" PrependPath=0 AppendPath=0 Include_test=0 Include_pip=1 Include_launcher=0 Shortcuts=0 AssociateFiles=0"
$pythonProcess = Start-Process -FilePath $pythonInstaller -ArgumentList $pythonArguments -Wait -PassThru -NoNewWindow
if ($pythonProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) {
  throw "Python installation failed with exit code $($pythonProcess.ExitCode)."
}
if ((& $pythonExe --version).Trim() -cne "Python $pythonVersion") { throw 'Python version verification failed.' }

$null = New-Item -ItemType Directory -Path $cargoBin -Force -ErrorAction Stop
$env:CARGO_HOME = $cargoHome
$env:RUSTUP_HOME = $rustupHome
Invoke-Checked $rustupInstaller @('-y', '--no-modify-path', '--profile', 'minimal', '--default-host', 'x86_64-pc-windows-msvc', '--default-toolchain', $RustToolchainVersion) 'Rust MSVC toolchain installation'

Move-Item -LiteralPath $brokerSourceRoot -Destination $brokerRoot -ErrorAction Stop
$env:PATH = @($nodeRoot, (Join-Path $gitRoot 'bin'), (Join-Path $gitRoot 'cmd'), $powerShellRoot,
  $pnpmRoot, $cargoBin, $env:PATH) -join ';'
$env:CI = 'true'
$pnpm = Join-Path $pnpmRoot 'pnpm.cmd'
Push-Location $brokerRoot
try {
  Invoke-Checked $pnpm @('install', '--frozen-lockfile', '--prod', '--registry=https://registry.npmjs.org') 'GitEdge production dependency install'
  Invoke-Checked (Join-Path $nodeRoot 'node.exe') @('scripts/actions-runner.mjs', 'setup') 'GitEdge workflow runtime installation'
} finally {
  Pop-Location
}

$null = New-Item -ItemType Directory -Path $buildToolsRoot -ErrorAction Stop
$buildToolsArguments = "--quiet --wait --norestart --nocache --installPath `"$buildToolsRoot`" --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100 --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre"
$buildToolsProcess = Start-Process -FilePath $buildToolsInstaller -ArgumentList $buildToolsArguments -Wait -PassThru -NoNewWindow
if ($buildToolsProcess.ExitCode -eq 3010) {
  Write-Warning 'Build Tools installed but Windows reports that a restart is required. The guest was not restarted.'
} elseif ($buildToolsProcess.ExitCode -ne 0) {
  throw "Build Tools installation failed with exit code $($buildToolsProcess.ExitCode)."
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'The Visual Studio instance locator was not installed.' }
$vswhereArguments = @(
  '-products', '*', '-requires',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  'Microsoft.VisualStudio.Component.Windows11SDK.26100',
  'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre',
  '-format', 'json', '-utf8'
)
$instances = @((& $vswhere @vswhereArguments | Out-String | ConvertFrom-Json) | Where-Object { $_.installationPath -ieq $buildToolsRoot })
if ($LASTEXITCODE -ne 0 -or $instances.Count -ne 1) {
  throw 'The required x64 C++ tools, Windows SDK 26100, and Spectre runtimes were not installed.'
}
$installedBuildToolsVersion = [string]$instances[0].catalog.productDisplayVersion
if ($LASTEXITCODE -ne 0 -or $installedBuildToolsVersion.Trim() -cne $BuildToolsProductVersion) {
  throw 'The installed Build Tools product version did not match the supplied version.'
}
$vsDevCmd = Join-Path $buildToolsRoot 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) { throw 'VsDevCmd.bat was not installed.' }
$probe = 'call "' + $vsDevCmd + '" -no_logo -arch=x64 -host_arch=x64 && where.exe cl.exe && where.exe link.exe'
$toolPaths = @(& $env:ComSpec /d /c $probe)
if ($LASTEXITCODE -ne 0) { throw 'The Visual Studio MSVC environment could not be activated.' }
$clPath = $toolPaths | Where-Object { $_ -match '(?i)\\cl\.exe$' -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
$linkPath = $toolPaths | Where-Object { $_ -match '(?i)\\link\.exe$' -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $clPath -or -not $linkPath -or
    $clPath -notlike "$buildToolsRoot\VC\Tools\MSVC\*" -or
    $linkPath -notlike "$buildToolsRoot\VC\Tools\MSVC\*") {
  throw 'The installed MSVC compiler and linker were not found under the selected Build Tools root.'
}

$environmentScript = Join-Path $InstallRoot 'runner-env.cmd'
$environmentText = @(
  '@echo off'
  "call `"$vsDevCmd`" -no_logo -arch=x64 -host_arch=x64"
  'if errorlevel 1 exit /b %errorlevel%'
  "set `"PYTHON=$pythonExe`""
  "set `"PATH=$pythonRoot;$pythonScripts;%PATH%`""
  "set `"CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=$linkPath`""
) -join "`r`n"
[System.IO.File]::WriteAllText($environmentScript, $environmentText + "`r`n", [System.Text.Encoding]::ASCII)
$entrypoint = @(
  '@echo off'
  "call `"$environmentScript`""
  'if errorlevel 1 exit /b %errorlevel%'
  ('"' + (Join-Path $nodeRoot 'node.exe') + '" "' + (Join-Path $brokerRoot 'scripts\runner-broker.mjs') + '" execute-vm-job')
  'exit /b %errorlevel%'
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $InstallRoot 'run-vm-job.cmd'), $entrypoint + "`r`n", [Text.Encoding]::ASCII)

$null = New-Item -ItemType Directory -Path $dotnetRoot -Force
Expand-Archive -LiteralPath $dotnetArchive -DestinationPath $dotnetRoot -Force
$env:PATH = "$dotnetRoot;$env:PATH"
$proxy = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { $env:HTTP_PROXY }
$proxyArgs = @{}
if ($proxy) {
  $proxyArgs.Proxy = $proxy
  [Net.WebRequest]::DefaultWebProxy = [Net.WebProxy]::new($proxy)
}
Install-PackageProvider -Name NuGet -ForceBootstrap -Force -Scope AllUsers @proxyArgs | Out-Null
Install-Module -Name ArtifactSigning -RequiredVersion '0.1.20' -Repository PSGallery -Scope AllUsers -Force @proxyArgs
Import-Module ArtifactSigning -RequiredVersion '0.1.20' -Force
if (-not (Get-Command Invoke-ArtifactSigning -ErrorAction SilentlyContinue)) { throw 'The Artifact Signing command is unavailable.' }
& (Get-Module ArtifactSigning) { Assert-DotnetRuntime; Get-EveryDependency | Out-Null }
if (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'ArtifactSigning\Microsoft.Windows.SDK.BuildTools\Microsoft.Windows.SDK.BuildTools.10.0.26100.4188\bin\10.0.26100.0\x64\signtool.exe') -PathType Leaf)) {
  throw 'The Artifact Signing SDK is unavailable.'
}

$machinePaths = @($InstallRoot, $nodeRoot, $pythonRoot, $pythonScripts, $dotnetRoot, (Join-Path $gitRoot 'bin'), (Join-Path $gitRoot 'cmd'),
  $powerShellRoot, $pnpmRoot, $cargoBin)
Add-MachinePath $machinePaths
[Environment]::SetEnvironmentVariable('CARGO_HOME', $cargoHome, 'User')
[Environment]::SetEnvironmentVariable('RUSTUP_HOME', $rustupHome, 'User')
[Environment]::SetEnvironmentVariable('CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', $linkPath, 'Machine')
[Environment]::SetEnvironmentVariable('CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', $linkPath, 'User')
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $linkPath

foreach ($tool in @('powershell.exe', 'pwsh.exe', 'git.exe', 'bash.exe', 'node.exe', 'pnpm.cmd', 'python.exe', 'rustc.exe', 'cargo.exe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required guest tool is not on PATH: $tool" }
}
if ((& (Join-Path $nodeRoot 'node.exe') --version) -cne "v$NodeVersion") { throw 'Node version verification failed.' }
if ((& (Join-Path $pnpmRoot 'pnpm.cmd') --version).Trim() -cne $pnpmVersion) { throw 'pnpm version verification failed.' }
if ((& $pythonExe --version).Trim() -cne "Python $pythonVersion") { throw 'Python version verification failed.' }
if ((& (Join-Path $gitRoot 'cmd\git.exe') --version) -notmatch [regex]::Escape($PortableGitVersion)) {
  throw 'Git version verification failed.'
}
if ((& (Join-Path $powerShellRoot 'pwsh.exe') --version) -notmatch [regex]::Escape($PowerShellVersion)) {
  throw 'PowerShell version verification failed.'
}
if (-not (Test-Path -LiteralPath (Join-Path $actionsRoot 'bin\Runner.Listener.exe') -PathType Leaf)) {
  throw 'The pinned official Actions runner artifact is incomplete.'
}
if ((& (Join-Path $cargoBin 'rustc.exe') --version) -notmatch [regex]::Escape($RustToolchainVersion)) {
  throw 'Rust toolchain version verification failed.'
}

$environmentProbe = 'call "' + $environmentScript + '" && where.exe cl.exe && where.exe link.exe && "!PYTHON!" --version'
$environmentOutput = @(& $env:ComSpec /d /v:on /c $environmentProbe)
if ($LASTEXITCODE -ne 0 -or ($environmentOutput -join "`n") -notmatch "Python $([regex]::Escape($pythonVersion))") {
  throw 'The guest runner environment did not resolve MSVC and Python.'
}
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
Write-Output 'Guest tools are installed and verified. The Actions runner remains unconfigured; no broker state or credentials were created.'

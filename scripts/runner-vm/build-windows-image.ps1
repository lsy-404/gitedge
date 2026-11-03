[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$IsoPath,
  [ValidateRange(1, 999)][int]$ImageIndex = 4,
  [Parameter(Mandatory = $true)][string]$VhdxPath,
  [ValidateRange(34359738368, 2199023255552)][long]$DiskSizeBytes = 137438953472,
  [Parameter(Mandatory = $true)][string]$CredentialPath,
  [switch]$ApplyImage
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-LocalPath([string]$Path, [string]$Label) {
  if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f<>|?*]' -or
      $Path -match '(^|[\\/])\.\.([\\/]|$)' -or $Path.StartsWith('\\?\') -or
      $Path.StartsWith('\\.\')) {
    throw "$Label must be an absolute local Windows path without traversal or special characters."
  }
  return [IO.Path]::GetFullPath($Path)
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$Label) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Get-CryptoIndex([int]$Maximum) {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $bytes = [byte[]]::new(4)
    $range = [uint64]4294967296
    $limit = $range - ($range % [uint64]$Maximum)
    do {
      $rng.GetBytes($bytes)
      $value = [uint64][BitConverter]::ToUInt32($bytes, 0)
    } while ($value -ge $limit)
    return [int]($value % [uint64]$Maximum)
  } finally {
    $rng.Dispose()
  }
}

function New-GuestPassword {
  $sets = @('abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!#$%&()*+,-.:;=?@[]^_{}')
  $chars = [Collections.Generic.List[char]]::new()
  foreach ($set in $sets) { $chars.Add($set[(Get-CryptoIndex $set.Length)]) }
  $all = $sets -join ''
  while ($chars.Count -lt 32) { $chars.Add($all[(Get-CryptoIndex $all.Length)]) }
  for ($i = $chars.Count - 1; $i -gt 0; $i--) {
    $j = Get-CryptoIndex ($i + 1)
    $temp = $chars[$i]; $chars[$i] = $chars[$j]; $chars[$j] = $temp
  }
  return -join $chars
}

if (-not $ApplyImage) { throw 'No changes were made. Pass -ApplyImage to create the image.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell session.'
}
$hostOs = Get-CimInstance Win32_OperatingSystem
if ($hostOs.Caption -notmatch 'Windows Server 2022') { throw 'The host must run Windows Server 2022.' }
if (-not (Get-Command New-VHD -ErrorAction SilentlyContinue)) { throw 'The Hyper-V PowerShell module is required.' }

$IsoPath = Assert-LocalPath $IsoPath 'IsoPath'
$VhdxPath = Assert-LocalPath $VhdxPath 'VhdxPath'
$CredentialPath = Assert-LocalPath $CredentialPath 'CredentialPath'
if ([IO.Path]::GetExtension($IsoPath) -ine '.iso' -or -not (Test-Path -LiteralPath $IsoPath -PathType Leaf)) {
  throw 'IsoPath must identify an existing ISO file.'
}
foreach ($path in @($VhdxPath, $CredentialPath)) {
  if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite existing output: $path" }
  $parent = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Output directory does not exist: $parent" }
}
if ($VhdxPath -ieq $CredentialPath) { throw 'VhdxPath and CredentialPath must be different.' }

$diskCreated = $false
$mountedVhd = $false
$mountedIso = $false
$accessPaths = [Collections.Generic.List[object]]::new()
$iso = $null
$vhd = $null
$credentialTemp = "$CredentialPath.$([guid]::NewGuid().ToString('N')).tmp"
try {
  $existingIso = Get-DiskImage -ImagePath $IsoPath -ErrorAction SilentlyContinue
  if ($existingIso -and $existingIso.Attached) { throw 'The ISO is already mounted; refusing to take ownership of an existing mount.' }
  $iso = Mount-DiskImage -ImagePath $IsoPath -PassThru -ErrorAction Stop
  $mountedIso = $true
  $media = @($iso | Get-Disk | Get-Partition | Get-Volume | Where-Object DriveLetter)
  if ($media.Count -ne 1) { throw 'The ISO must expose exactly one mounted volume with a drive letter.' }
  $mediaRoot = "$($media[0].DriveLetter):\"
  $imageFile = @((Join-Path $mediaRoot 'sources\install.wim'), (Join-Path $mediaRoot 'sources\install.esd') |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) | Select-Object -First 1
  if (-not $imageFile) { throw 'The ISO must contain sources\install.wim or sources\install.esd.' }
  $imageInfo = & dism.exe /English /Get-WimInfo "/WimFile:$imageFile" "/Index:$ImageIndex"
  if ($LASTEXITCODE -ne 0) { throw "Image index $ImageIndex was not found in the ISO image." }
  if (($imageInfo -join "`n") -notmatch 'Windows Server 2022') { throw "Image index $ImageIndex is not Windows Server 2022." }

  $vhd = New-VHD -Path $VhdxPath -Dynamic -SizeBytes $DiskSizeBytes -ErrorAction Stop
  $diskCreated = $true
  $mountedVhd = $true
  $disk = $vhd | Mount-VHD -PassThru -ErrorAction Stop | Get-Disk
  Initialize-Disk -Number $disk.Number -PartitionStyle GPT -ErrorAction Stop | Out-Null
  $efi = New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' -AssignDriveLetter -ErrorAction Stop
  $efi = $efi | Format-Volume -FileSystem FAT32 -NewFileSystemLabel 'System' -Confirm:$false -ErrorAction Stop
  $msr = New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}' -ErrorAction Stop
  $osPartition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -GptType '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' -AssignDriveLetter -ErrorAction Stop
  $osPartition = $osPartition | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'Windows' -Confirm:$false -ErrorAction Stop
  foreach ($partition in @($efi, $osPartition)) {
    $letter = [string]$partition.DriveLetter
    if (-not $letter) { throw 'Windows did not assign a temporary drive letter to a required partition.' }
    $accessPaths.Add([pscustomobject]@{ DiskNumber = $disk.Number; PartitionNumber = $partition.PartitionNumber; Path = "$letter`:" })
  }

  $osRoot = "$($osPartition.DriveLetter):\"
  $efiRoot = "$($efi.DriveLetter):\"
  Invoke-Checked 'dism.exe' @('/Apply-Image', "/ImageFile:$imageFile", "/Index:$ImageIndex", "/ApplyDir:$osRoot", '/CheckIntegrity', '/Verify') 'Applying Windows image'
  Invoke-Checked 'bcdboot.exe' @("${osRoot}Windows", '/s', $efiRoot, '/f', 'UEFI') 'Creating UEFI boot files'

  $password = New-GuestPassword
  $passwordXml = [Security.SecurityElement]::Escape($password)
  $unattendPath = Join-Path $osRoot 'Windows\Panther\Unattend.xml'
  $panther = Split-Path -Parent $unattendPath
  New-Item -ItemType Directory -Path $panther -Force | Out-Null
  $setupScripts = Join-Path $osRoot 'Windows\Setup\Scripts'
  New-Item -ItemType Directory -Path $setupScripts -Force | Out-Null
  $completionScript = @'
$ErrorActionPreference = 'Stop'
$registry = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
foreach ($name in @('AutoAdminLogon', 'DefaultPassword', 'DefaultUserName', 'DefaultDomainName')) {
  Remove-ItemProperty -Path $registry -Name $name -ErrorAction SilentlyContinue
}
$files = @(
  "$env:WINDIR\Panther\Unattend.xml",
  "$env:WINDIR\Panther\UnattendGC\Unattend.xml",
  "$env:WINDIR\Panther\Unattend\Unattend.xml",
  "$env:WINDIR\System32\Sysprep\Unattend.xml",
  "$env:SystemDrive\Autounattend.xml",
  "$env:SystemDrive\Unattend.xml"
)
foreach ($file in $files) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
$markerDirectory = Join-Path $env:ProgramData 'GitEdge\RunnerImage'
New-Item -ItemType Directory -Path $markerDirectory -Force | Out-Null
Set-Content -LiteralPath (Join-Path $markerDirectory 'setup.complete') -Value 'ready' -Encoding ASCII -NoNewline
'@
  $completionPath = Join-Path $setupScripts 'RunnerImageFirstLogon.ps1'
  Set-Content -LiteralPath $completionPath -Value $completionScript -Encoding UTF8
  $answerFile = @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE><HideEULAPage>true</HideEULAPage><HideLocalAccountScreen>true</HideLocalAccountScreen><ProtectYourPC>3</ProtectYourPC></OOBE>
      <UserAccounts><AdministratorPassword><Value>$passwordXml</Value><PlainText>true</PlainText></AdministratorPassword></UserAccounts>
      <AutoLogon><Enabled>true</Enabled><LogonCount>1</LogonCount><Username>Administrator</Username><Password><Value>$passwordXml</Value><PlainText>true</PlainText></Password></AutoLogon>
      <FirstLogonCommands><SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>1</Order><CommandLine>powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Windows\Setup\Scripts\RunnerImageFirstLogon.ps1</CommandLine><Description>Finalize runner image setup</Description><RequiresUserInput>false</RequiresUserInput></SynchronousCommand></FirstLogonCommands>
    </component>
  </settings>
</unattend>
"@
  Set-Content -LiteralPath $unattendPath -Value $answerFile -Encoding UTF8

  Add-Type -AssemblyName System.Security
  $protectedPassword = [Security.Cryptography.ProtectedData]::Protect(
    [Text.Encoding]::UTF8.GetBytes($password), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  $credentialData = [ordered]@{
    version = 1
    username = 'Administrator'
    protection = 'LocalMachine'
    password = [Convert]::ToBase64String($protectedPassword)
  }
  $credentialData | ConvertTo-Json -Compress | Set-Content -LiteralPath $credentialTemp -Encoding ASCII
  $acl = Get-Acl -LiteralPath $credentialTemp
  $acl.SetAccessRuleProtection($true, $false)
  $acl.Access | ForEach-Object { $acl.RemoveAccessRuleAll($_) }
  $acl.SetOwner([Security.Principal.NTAccount]::new('BUILTIN\Administrators'))
  foreach ($identity in @('SYSTEM', 'BUILTIN\Administrators')) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $credentialTemp -AclObject $acl -ErrorAction Stop
  [IO.File]::Move($credentialTemp, $CredentialPath)
} finally {
  if (Test-Path -LiteralPath $credentialTemp) { Remove-Item -LiteralPath $credentialTemp -Force -ErrorAction SilentlyContinue }
  foreach ($item in $accessPaths) {
    Remove-PartitionAccessPath -DiskNumber $item.DiskNumber -PartitionNumber $item.PartitionNumber -AccessPath $item.Path -ErrorAction SilentlyContinue
  }
  if ($mountedVhd) { Dismount-VHD -Path $VhdxPath -ErrorAction SilentlyContinue }
  if ($mountedIso) { Dismount-DiskImage -ImagePath $IsoPath -ErrorAction SilentlyContinue }
  if ($diskCreated -and -not (Test-Path -LiteralPath $VhdxPath)) { $diskCreated = $false }
}

Write-Output "Created $VhdxPath"
Write-Output "Credential saved to $CredentialPath (machine-scoped DPAPI; ACL restricted to SYSTEM and Administrators)."

function New-NoCloudIso([string]$Directory, [string]$Destination, [object]$Network, [string]$Id, [string]$User, [string]$AuthorizedKey, [object]$GuestHostKey = $null) {
  $seed = Join-Path $Directory 'cloud-init'
  New-Item -ItemType Directory -Path $seed -ErrorAction Stop | Out-Null
  $utf8 = [Text.UTF8Encoding]::new($false)
  $metadata = "instance-id: ge-$Id`nlocal-hostname: ge-$($Id.Substring(0,8))`n"
  $userdata = "#cloud-config`nssh_pwauth: false`nssh_deletekeys: false`nusers:`n  - name: $User`n    lock_passwd: true`n    groups: [adm, sudo]`n    sudo: ALL=(ALL) NOPASSWD:ALL`n    shell: /bin/bash`n    ssh_authorized_keys:`n      - $AuthorizedKey`n"
  if ($GuestHostKey) {
    $private = ($GuestHostKey.private.TrimEnd() -split '\r?\n' | ForEach-Object { '    ' + $_ }) -join "`n"
    $userdata += "ssh_keys:`n  ed25519_private: |`n$private`n  ed25519_public: '$($GuestHostKey.public)'`n"
  }
  $dns = @($Network.dns) -join ', '
  $netconfig = "version: 2`nethernets:`n  eth0:`n    match:`n      name: 'e*'`n    set-name: eth0`n    dhcp4: false`n    dhcp6: false`n    addresses: [$($Network.address)/$($Network.prefixLength)]`n    routes:`n      - to: default`n        via: $($Network.gateway)`n    nameservers:`n      addresses: [$dns]`n"
  [IO.File]::WriteAllText((Join-Path $seed 'meta-data'), $metadata, $utf8)
  [IO.File]::WriteAllText((Join-Path $seed 'user-data'), $userdata, $utf8)
  [IO.File]::WriteAllText((Join-Path $seed 'network-config'), $netconfig, $utf8)
  if (-not ('GitEdge.IsoStream' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace GitEdge {
  public static class IsoStream {
    public static void Save(object source, string destination) {
      var input = (IStream)source;
      var read = Marshal.AllocHGlobal(sizeof(int));
      try {
        using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write)) {
          var buffer = new byte[65536];
          for (;;) {
            input.Read(buffer, buffer.Length, read);
            var count = Marshal.ReadInt32(read);
            if (count == 0) break;
            output.Write(buffer, 0, count);
          }
        }
      } finally { Marshal.FreeHGlobal(read); }
    }
  }
}
'@
  }
  $image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  try {
    $image.FileSystemsToCreate = 3
    $image.VolumeName = 'cidata'
    $image.Root.AddTree($seed, $false)
    $result = $image.CreateResultImage()
    [GitEdge.IsoStream]::Save($result.ImageStream, $Destination)
  } finally {
    [Runtime.InteropServices.Marshal]::ReleaseComObject($image) | Out-Null
  }
}

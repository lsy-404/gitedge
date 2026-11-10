#!/bin/bash
set -euo pipefail

if [[ "$(/usr/bin/id -u)" != 0 ]]; then
  echo "Run this image setup helper as root." >&2
  exit 1
fi

source_dir=$(cd "$(/usr/bin/dirname "$0")" && /bin/pwd -P)
helper=/Library/PrivilegedHelperTools/com.gitedge.vm-bootstrap.sh
plist=/Library/LaunchDaemons/com.gitedge.vm-bootstrap.plist
host_key=/private/var/run/gitedge-vm/ssh_host_ed25519_key

configured_hostkeys=$(/usr/sbin/sshd -T -f /etc/ssh/sshd_config 2>/dev/null | /usr/bin/awk 'tolower($1) == "hostkey" { print $2 }')
if [[ "$configured_hostkeys" != "$host_key" ]]; then
  echo "sshd must be configured to advertise only the per-run host key before sealing." >&2
  exit 1
fi

/usr/bin/plutil -lint "$source_dir/com.gitedge.vm-bootstrap.plist" >/dev/null
/usr/bin/install -d -o root -g wheel -m 0755 /Library/PrivilegedHelperTools
/usr/bin/install -o root -g wheel -m 0755 "$source_dir/bootstrap-macos-image.sh" "$helper"
/usr/bin/install -o root -g wheel -m 0644 "$source_dir/com.gitedge.vm-bootstrap.plist" "$plist"

#!/bin/bash
set -euo pipefail

seed=/Volumes/GITEDGE_SEED
config="$seed/run.json"
home=/Volumes/RunnerData/Users/gitedge-runner
service_dir=/private/var/run/gitedge-vm
host_key="$service_dir/ssh_host_ed25519_key"
sshd_config=/etc/ssh/sshd_config

if [[ ! -f "$config" || -L "$config" || ! -f "$seed/authorized_keys" || -L "$seed/authorized_keys" || ! -f "$seed/ssh_host_ed25519_key" || -L "$seed/ssh_host_ed25519_key" || ! -f "$seed/ssh_host_ed25519_key.pub" || -L "$seed/ssh_host_ed25519_key.pub" ]]; then
  exit 0
fi

get_json() {
  /usr/bin/plutil -extract "$1" raw -o - "$config"
}

version=$(get_json version)
run_id=$(get_json id)
address=$(get_json network.address)
prefix=$(get_json network.prefixLength)
gateway=$(get_json network.gateway)
user=$(get_json sshUser)
runtime=$(get_json brokerRuntime)
node_path=$(get_json node)
guest_agent=$(get_json guestAgent)
host_public=$(get_json sshHostPublicKey)
guest_mac=$(get_json network.mac)

[[ "$version" == 1 ]] || exit 1
[[ "$run_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || exit 1
[[ "$address" =~ ^10\.253\.247\.[23]$ ]] || exit 1
[[ "$gateway" == 10.253.247.1 && "$prefix" == 29 ]] || exit 1
[[ "$guest_mac" =~ ^52:54:00:74:00:0[12]$ ]] || exit 1
[[ "$user" == gitedge-runner ]] || exit 1
for target in "$runtime" "$node_path" "$guest_agent"; do
  [[ "$target" == /Volumes/RunnerData/Users/gitedge-runner/* ]] || exit 1
  [[ "$target" != *"/../"* && "$target" != */.. && "$target" != *"/./"* ]] || exit 1
done
[[ -d "$home" && ! -L "$home" ]] || exit 1
account_home=$(/usr/bin/dscl . -read "/Users/$user" NFSHomeDirectory | /usr/bin/awk '$1 == "NFSHomeDirectory:" { print $2 }')
[[ "$account_home" == "$home" ]] || exit 1
[[ -d "$runtime" && ! -L "$runtime" && -x "$node_path" && ! -L "$node_path" && -f "$guest_agent" && ! -L "$guest_agent" ]] || exit 1
node_version=$("$node_path" -p 'process.versions.node')
[[ "$node_version" == 24.* ]] || exit 1
[[ "$(/usr/bin/awk 'END { print NR }' "$seed/authorized_keys")" == 1 ]] || exit 1
/usr/bin/ssh-keygen -lf "$seed/authorized_keys" >/dev/null 2>&1 || exit 1
if ! /usr/sbin/dseditgroup -o checkmember -m "$user" com.apple.access_ssh >/dev/null 2>&1; then
  exit 1
fi
volume_info=$(/usr/sbin/diskutil info -plist /Volumes/RunnerData)
[[ "$(printf '%s' "$volume_info" | /usr/bin/plutil -extract MountPoint raw -o - -)" == /Volumes/RunnerData ]] || exit 1
[[ "$(printf '%s' "$volume_info" | /usr/bin/plutil -extract VolumeName raw -o - -)" == RunnerData ]] || exit 1
[[ "$(printf '%s' "$volume_info" | /usr/bin/plutil -extract FilesystemType raw -o - -)" == apfs ]] || exit 1

if [[ -e "$service_dir/ready" ]]; then
  [[ -f "$service_dir/ready" && ! -L "$service_dir/ready" ]] || exit 1
  [[ "$(/bin/cat "$service_dir/ready")" == "$run_id" ]] && exit 0
  exit 1
fi

configured_hostkeys=$(/usr/sbin/sshd -G -f "$sshd_config" 2>/dev/null | /usr/bin/awk 'tolower($1) == "hostkey" { print $2 }')
[[ "$configured_hostkeys" == "$host_key" ]] || exit 1
[[ "$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null)" == *On ]] || exit 1

/usr/bin/install -d -o root -g wheel -m 0700 "$service_dir"
/usr/bin/install -o root -g wheel -m 0600 "$seed/ssh_host_ed25519_key" "$host_key"
/usr/bin/install -o root -g wheel -m 0644 "$seed/ssh_host_ed25519_key.pub" "$host_key.pub"
/usr/bin/install -d -o "$user" -g staff -m 0700 "$home/.ssh"
/usr/bin/install -o "$user" -g staff -m 0600 "$seed/authorized_keys" "$home/.ssh/authorized_keys"
/usr/sbin/chown -R "$user":staff "$home/.ssh"
/usr/sbin/chmod 0700 "$home/.ssh"

derived=$(/usr/bin/ssh-keygen -y -f "$host_key" 2>/dev/null | /usr/bin/awk '{ print $1 " " $2 }')
expected=$(/usr/bin/awk '{ print $1 " " $2 }' "$host_key.pub")
seed_public=$(printf '%s\n' "$host_public" | /usr/bin/awk '{ print $1 " " $2 }')
[[ "$derived" == "$expected" && "$seed_public" == "$expected" ]] || exit 1

device=$(/usr/sbin/networksetup -listallhardwareports | /usr/bin/awk -v target="$(printf '%s' "$guest_mac" | /usr/bin/tr '[:upper:]' '[:lower:]')" '
  /^Hardware Port: / { ethernet = $0 ~ /Ethernet/; device = "" }
  /^Device: / { device = $2 }
  /^Ethernet Address: / { if (ethernet && tolower($3) == target) { print device; exit } }
')
[[ "$device" =~ ^[A-Za-z0-9]+$ ]] || exit 1
service=$(/usr/sbin/networksetup -listnetworkserviceorder | /usr/bin/awk -v target="$device" '
  /^\([0-9]+\) / { service = $0; sub(/^\([0-9]+\) /, "", service); disabled = 0; next }
  /^\(\*\) / { service = $0; sub(/^\(\*\) /, "", service); disabled = 1; next }
  /^\(Hardware Port: / {
    hardware = $0
    sub(/^.*Device: /, "", hardware)
    sub(/\).*/, "", hardware)
    if (hardware == target && !disabled) { matches++; selected = service }
  }
  END { if (matches == 1) print selected; else exit 1 }
')
[[ -n "$service" ]] || exit 1
/usr/sbin/networksetup -setmanual "$service" "$address" 255.255.255.248 "$gateway"
/usr/sbin/networksetup -setdnsservers "$service" Empty
/usr/sbin/networksetup -setwebproxy "$service" "$gateway" 3128
/usr/sbin/networksetup -setsecurewebproxy "$service" "$gateway" 3128
/usr/sbin/networksetup -setproxybypassdomains "$service" localhost 127.0.0.1 "$gateway"
/usr/sbin/networksetup -setwebproxystate "$service" on
/usr/sbin/networksetup -setsecurewebproxystate "$service" on
/usr/sbin/sshd -t -f "$sshd_config"
/bin/launchctl kickstart -k system/com.openssh.sshd
/bin/printf '%s\n' "$run_id" > "$service_dir/ready"
/usr/sbin/chown root:wheel "$service_dir/ready"
/bin/chmod 0600 "$service_dir/ready"

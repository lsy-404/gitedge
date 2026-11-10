#!/usr/bin/env bash
set -euo pipefail

bridge=gemacbr
table=gitedge_macvm
installed=/usr/local/libexec/gitedge-macvm-network
unit=/etc/systemd/system/gitedge-macvm-network.service

fail() { echo "$*" >&2; exit 1; }
[[ ${EUID} == 0 ]] || fail 'Run as root.'
[[ $# == 2 && $2 =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || fail 'Usage: macos-network.sh install|run BROKER_USER'
mode=$1
broker=$2
id "$broker" >/dev/null || fail 'Broker user does not exist.'
[[ $(id -u "$broker") != 0 ]] || fail 'Broker user must be non-root.'

if [[ $mode == install ]]; then
  [[ ! -e $installed && ! -L $installed && ! -e $unit && ! -L $unit ]] || fail 'Installation paths already exist.'
  install -o root -g root -m 0755 "$0" "$installed"
  cat > "$unit" <<EOF
[Unit]
Description=GitEdge macOS VM isolated network
After=network-online.target
Wants=network-online.target
Before=gitedge-runner-broker.service

[Service]
Type=notify
NotifyAccess=all
ExecStart=$installed run $broker
Restart=no

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$unit"
  systemctl daemon-reload
  systemctl enable --now gitedge-macvm-network.service
  exit
fi
[[ $mode == run ]] || fail 'Unknown mode.'

for name in "$bridge" gemac1 gemac2; do
  ! ip link show dev "$name" >/dev/null 2>&1 || fail "Interface $name already exists."
done
for family in bridge inet; do
  ! nft list table "$family" "$table" >/dev/null 2>&1 || fail "Table $family $table already exists."
done
python3 - <<'PY'
import ipaddress
import json
import subprocess

network = ipaddress.ip_network('10.253.247.0/29')
for command in (['ip', '-j', '-4', 'route', 'show', 'table', 'all'], ['ip', '-j', '-4', 'address', 'show']):
    for entry in json.loads(subprocess.check_output(command)):
        values = [entry.get('dst', 'default')] if 'dst' in entry else [item['local'] + '/' + str(item['prefixlen']) for item in entry.get('addr_info', []) if item.get('family') == 'inet']
        for value in values:
            if value != 'default' and ipaddress.ip_network(value, strict=False).overlaps(network):
                raise SystemExit('VM subnet overlaps an existing route or address: ' + value)
PY
if ss -H -ltn | awk '{print $4}' | grep -Eq '(^|[.:])(3128|3129)$'; then
  fail 'A listener already uses a VM service port.'
fi

have_rules=0
have_bridge=0
have_tap1=0
have_tap2=0
proxy_pid=
cleanup() {
  [[ -z $proxy_pid ]] || { kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; }
  (( have_tap2 == 0 )) || ip link del gemac2
  (( have_tap1 == 0 )) || ip link del gemac1
  (( have_bridge == 0 )) || ip link del "$bridge"
  if (( have_rules )); then
    nft delete table bridge "$table"
    nft delete table inet "$table"
  fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT

nft -f - <<'NFT'
table bridge gitedge_macvm {
  chain ingress {
    type filter hook prerouting priority -300; policy accept;
    iifname "gemac1" jump slot1
    iifname "gemac2" jump slot2
  }
  chain slot1 {
    ether saddr 52:54:00:74:00:01 ether type ip ip saddr 10.253.247.2 ip daddr 10.253.247.1 accept
    ether saddr 52:54:00:74:00:01 ether type arp arp saddr ether 52:54:00:74:00:01 arp saddr ip 10.253.247.2 arp daddr ip 10.253.247.1 accept
    drop
  }
  chain slot2 {
    ether saddr 52:54:00:74:00:02 ether type ip ip saddr 10.253.247.3 ip daddr 10.253.247.1 accept
    ether saddr 52:54:00:74:00:02 ether type arp arp saddr ether 52:54:00:74:00:02 arp saddr ip 10.253.247.3 arp daddr ip 10.253.247.1 accept
    drop
  }
  chain forward {
    type filter hook forward priority -300; policy accept;
    iifname { "gemac1", "gemac2" } drop
    oifname { "gemac1", "gemac2" } drop
  }
}
table inet gitedge_macvm {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "gemacbr" ip daddr 10.253.247.1 ct state established,related accept
    iifname "gemacbr" ip daddr 10.253.247.1 tcp dport { 3128, 3129 } accept
    iifname "gemacbr" drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "gemacbr" drop
    oifname "gemacbr" drop
  }
}
NFT
have_rules=1
ip link add "$bridge" type bridge
have_bridge=1
ip link set dev "$bridge" address 02:00:00:74:00:01
ip address add 10.253.247.1/29 dev "$bridge"
ip tuntap add dev gemac1 mode tap user "$broker"
have_tap1=1
ip tuntap add dev gemac2 mode tap user "$broker"
have_tap2=1
ip link set gemac1 master "$bridge"
ip link set gemac2 master "$bridge"
ip link set gemac1 up
ip link set gemac2 up
ip link set "$bridge" up
socat TCP4-LISTEN:3128,bind=10.253.247.1,reuseaddr,fork TCP4:172.29.73.1:3128 &
proxy_pid=$!
ready=0
for _ in {1..50}; do
  kill -0 "$proxy_pid" 2>/dev/null || fail 'Proxy exited before becoming ready.'
  if ss -H -ltn | awk '{print $4}' | grep -Fxq '10.253.247.1:3128'; then
    ready=1
    break
  fi
  sleep 0.1
done
(( ready )) || fail 'Proxy did not become ready.'
systemd-notify --ready
wait "$proxy_pid"

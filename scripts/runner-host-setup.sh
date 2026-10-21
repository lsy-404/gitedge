#!/usr/bin/env bash
set -euo pipefail

if ((EUID != 0)); then
  echo 'Run as root on Linux.' >&2
  exit 1
fi
if [[ "$(uname -s)" != Linux || $# -gt 1 || ( $# == 1 && "$1" != --oci-idle-load ) ]]; then
  echo 'Usage: sudo bash scripts/runner-host-setup.sh [--oci-idle-load]' >&2
  exit 1
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
swap_bytes=$(swapon --noheadings --show=SIZE --bytes | awk '{s+=$1} END {printf "%.0f",s+0}')
if ((swap_bytes < 8589934592)); then
  if [[ -e /swapfile.gitedge || -L /swapfile.gitedge ]]; then
    echo 'Inspect the existing /swapfile.gitedge before changing swap.' >&2
    exit 1
  fi
  available=$(df --output=avail -B1 / | tail -1)
  if ((available < 12884901888)); then
    echo 'At least 12 GiB free disk is required to add 8 GiB swap.' >&2
    exit 1
  fi
  fallocate -l 8G /swapfile.gitedge
  chmod 600 /swapfile.gitedge
  mkswap /swapfile.gitedge >/dev/null
  swapon /swapfile.gitedge
  if ! grep -q '^/swapfile.gitedge[[:space:]]' /etc/fstab; then
    printf '%s\n' '/swapfile.gitedge none swap sw 0 0' >>/etc/fstab
  fi
fi

install -d -m 755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/gitedge-retention.conf <<'CONF'
[Journal]
SystemMaxUse=128M
RuntimeMaxUse=32M
MaxRetentionSec=7day
CONF
systemctl restart systemd-journald

if [[ "${1:-}" == --oci-idle-load ]]; then
  command -v openssl >/dev/null
  if ! id gitedge-runner >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/gitedge-runner --shell /usr/sbin/nologin gitedge-runner
  fi
  install -d -m 755 /usr/local/libexec
  install -m 755 "$script_dir/runner-idle-load.sh" /usr/local/libexec/gitedge-idle-load
  cat >/etc/systemd/system/oci-idle-load.service <<'UNIT'
[Unit]
Description=OCI idle CPU maintenance
After=network.target

[Service]
Type=simple
User=gitedge-runner
ExecStart=/usr/bin/bash /usr/local/libexec/gitedge-idle-load
Nice=19
CPUWeight=1
CPUQuota=60%
IOWeight=1
MemoryMax=32M
RuntimeMaxSec=9min
TimeoutStopSec=5s
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UNIT
  cat >/etc/systemd/system/oci-idle-load.timer <<'UNIT'
[Unit]
Description=Periodic OCI idle CPU maintenance

[Timer]
OnBootSec=5min
OnCalendar=*-*-* *:10:00
RandomizedDelaySec=60s
Persistent=true
Unit=oci-idle-load.service

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now oci-idle-load.timer
fi
swapon --show
systemctl is-active systemd-journald

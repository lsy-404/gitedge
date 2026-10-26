#!/usr/bin/env bash
set -euo pipefail

if ((EUID != 0)); then
  echo 'Run as root on Linux.' >&2
  exit 1
fi
idle_task=()
if [[ "${1:-}" == --oci-idle-load ]]; then
  shift
  if [[ "${1:-}" == -- ]]; then shift; fi
  if (($# == 0)); then
    echo 'OCI idle load requires a resumable task command after --.' >&2
    exit 64
  fi
  idle_task=("$@")
elif (($# != 0)); then
  echo 'Usage: sudo bash scripts/runner-host-setup.sh [--oci-idle-load -- COMMAND [ARG ...]]' >&2
  exit 1
fi
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Linux is required.' >&2
  exit 1
fi

systemd_quote() {
  local value=$1
  [[ $value != *$'\n'* && $value != *$'\r'* ]] || return 1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\$\$}
  value=${value//%/%%}
  printf ' "%s"' "$value"
}

idle_exec=''
if ((${#idle_task[@]})); then
  for argument in "${idle_task[@]}"; do
    idle_exec+=$(systemd_quote "$argument") || {
      echo 'Task arguments cannot contain line breaks.' >&2
      exit 64
    }
  done
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ((${#idle_task[@]} == 0)); then
  swap_bytes=$(swapon --noheadings --show=SIZE --bytes | awk '{s+=$1} END {printf "%.0f",s+0}')
  if ((swap_bytes < 8588886016)); then
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
fi

if ((${#idle_task[@]})); then
  python3 -c 'import subprocess; assert {"user", "group", "extra_groups"} <= set(subprocess.Popen.__init__.__code__.co_varnames)'
  if ! id gitedge-idle >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/gitedge-idle --shell /usr/sbin/nologin gitedge-idle
    chmod 700 /var/lib/gitedge-idle
  else
    state_owner=$(stat -c '%U:%G:%a' /var/lib/gitedge-idle)
    if [[ "$state_owner" != gitedge-idle:gitedge-idle:700 ]]; then
      echo 'The idle task state directory must be private and owned by gitedge-idle.' >&2
      exit 1
    fi
  fi
  systemctl stop oci-idle-load.timer oci-idle-load.service >/dev/null 2>&1 || true
  if systemctl is-active --quiet oci-idle-load.timer || systemctl is-active --quiet oci-idle-load.service; then
    echo 'The existing idle task service or timer could not be stopped safely.' >&2
    exit 1
  fi
  install -d -m 755 /usr/local/libexec
  install -m 755 "$script_dir/runner-idle-load.py" /usr/local/libexec/gitedge-idle-load
  install -d -m 755 /run/gitedge-idle-status
  cat >/etc/tmpfiles.d/gitedge-idle-status.conf <<'CONF'
d /run/gitedge-idle-status 0755 root root -
CONF
  memory_kib=$(awk '/MemTotal:/ { print $2 }' /proc/meminfo)
  idle_memory_high=128M
  idle_memory_max=192M
  if ((memory_kib >= 4194304)); then
    idle_memory_high=768M
    idle_memory_max=1G
  fi
  cat >/etc/systemd/system/oci-idle-load.service <<UNIT
[Unit]
Description=OCI idle background task
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/lib/gitedge-idle
ExecStart=/usr/bin/python3 /usr/local/libexec/gitedge-idle-load --resume-after 45 --run-for 0 --state-dir /var/lib/gitedge-idle --max-disk-mib 512 --task-user gitedge-idle --cpu-target-percent 25 --cpu-quota-cap-percent 50 --${idle_exec}
User=root
Group=root
Nice=0
CPUWeight=1
CPUQuota=50%
CPUQuotaPeriodSec=20ms
IOWeight=1
IOSchedulingClass=idle
MemoryHigh=$idle_memory_high
MemoryMax=$idle_memory_max
MemorySwapMax=0
TimeoutStopSec=10s
KillMode=control-group
UMask=0077
RuntimeDirectory=gitedge-idle
RuntimeDirectoryMode=0700
Restart=no
LogRateLimitIntervalSec=30s
LogRateLimitBurst=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
InaccessiblePaths=-/etc/server-toolkit -/var/lib/openlist
ReadOnlyPaths=-/opt/gitedge/work/actions
ReadWritePaths=/var/lib/gitedge-idle /run/gitedge-idle /run/gitedge-idle-status
UNIT
  cat >/etc/systemd/system/oci-idle-load.timer <<'UNIT'
[Unit]
Description=Start OCI idle background task after boot

[Timer]
OnBootSec=5min
Unit=oci-idle-load.service

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now oci-idle-load.timer
  systemctl start oci-idle-load.service
fi
swapon --show
systemctl is-active systemd-journald

#!/usr/bin/env bash
set -Eeuo pipefail

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

usage() {
  cat >&2 <<'USAGE'
Usage:
  sudo scripts/runner-vm/bootstrap-linux-image.sh --apply \
    <broker-runtime.tar> <broker-sha256> \
    <node-v24.22.2-linux-x64.tar.xz> 24.22.2 <node-sha256> \
    <actions-runner-linux-x64-2.338.2.tar.gz> 2.338.2 <runner-sha256>

Run inside a clean Ubuntu 24.04 x86_64 guest. All archives must already be present.
The caller supplies the SHA-256 digest for each archive.
USAGE
}

fail() {
  printf 'bootstrap-linux-image: %s\n' "$1" >&2
  exit 1
}

[[ ${1:-} == --apply ]] || { usage; fail 'explicit --apply is required.'; }
[[ $# -eq 8 ]] || { usage; fail 'expected eight arguments after --apply.'; }
shift
broker_archive=$1
broker_sha=$2
node_archive=$3
node_version=$4
node_sha=$5
runner_archive=$6
runner_version=$7
runner_sha=$8
[[ $node_version == 24.22.2 ]] || fail 'Node version must be 24.22.2.'
[[ $runner_version == 2.338.2 ]] || fail 'Actions runner version must be 2.338.2.'
[[ $(id -u) -eq 0 ]] || fail 'run this script as root inside the guest.'
[[ -r /etc/os-release ]] || fail 'Ubuntu release metadata is unavailable.'
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || fail 'guest must be Ubuntu 24.04.'
[[ $(uname -m) == x86_64 ]] || fail 'guest must be x86_64.'

for digest in "$broker_sha" "$node_sha" "$runner_sha"; do
  [[ $digest =~ ^[[:xdigit:]]{64}$ ]] || fail 'each supplied SHA-256 must contain 64 hexadecimal characters.'
done
for archive in "$broker_archive" "$node_archive" "$runner_archive"; do
  [[ -f $archive && ! -L $archive && -r $archive ]] || fail "archive must be a readable regular file: $archive"
done

verify_sha() {
  local archive=$1 expected=${2,,} actual
  actual=$(sha256sum -- "$archive")
  actual=${actual%% *}
  [[ $actual == "$expected" ]] || fail "SHA-256 mismatch: $archive"
}
verify_sha "$broker_archive" "$broker_sha"
verify_sha "$node_archive" "$node_sha"
verify_sha "$runner_archive" "$runner_sha"

for command_name in tar python3 sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required preflight command is missing: $command_name"
done
id runner >/dev/null 2>&1 || fail 'cloud-init must create the runner user before bootstrap.'

stage=$(mktemp -d /var/tmp/gitedge-bootstrap.XXXXXXXXXX)
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0700 "$stage"

# Inspect archive member types and paths before extracting untrusted input.
python3 - "$broker_archive" "$node_archive" "$runner_archive" "$stage" <<'PY'
import json
import os
import re
import sys
import tarfile

broker_path, node_path, runner_path, stage = sys.argv[1:]
limits = (1 << 30, 1 << 30, 1 << 30)

def inspect(path, limit, prefix=None, allow_internal_links=False):
    if os.path.getsize(path) > limit:
        raise SystemExit(f"archive exceeds {limit} byte limit: {path}")
    with tarfile.open(path, "r:*") as archive:
        members = archive.getmembers()
        if not members or len(members) > 50000:
            raise SystemExit(f"archive has an invalid entry count: {path}")
        total = 0
        names = set()
        for member in members:
            name = member.name.rstrip("/")
            parts = name.split("/")
            if (not name or name.startswith("/") or "\\" in name
                    or any(part in ("", ".", "..") for part in parts)
                    or name in names):
                raise SystemExit(f"archive has an unsafe or duplicate path: {path}")
            names.add(name)
            if prefix and parts[0] != prefix:
                raise SystemExit(f"unexpected top-level archive path: {path}")
            if member.isfile():
                total += member.size
                if total > limit:
                    raise SystemExit(f"archive expanded size exceeds limit: {path}")
        for member in members:
            name = member.name.rstrip("/")
            if member.issym() and allow_internal_links:
                target = member.linkname
                if os.path.isabs(target) or "\\" in target:
                    raise SystemExit(f"archive contains an unsafe symbolic link: {path}")
                resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
                if (resolved == ".." or resolved.startswith("../")
                        or resolved.split("/", 1)[0] != prefix or resolved not in names):
                    raise SystemExit(f"archive symbolic link escapes or is unresolved: {path}")
            elif not (member.isdir() or member.isfile()):
                raise SystemExit(f"archive contains a link or special file: {path}")
        return archive, names

_, broker_names = inspect(broker_path, limits[0], "gitedge")
_, node_names = inspect(node_path, limits[1], "node-v24.22.2-linux-x64", True)
_, runner_names = inspect(runner_path, limits[2])
required_broker = {"gitedge/package.json", "gitedge/pnpm-lock.yaml",
                   "gitedge/scripts/runner-vm/guest.mjs"}
if not required_broker <= broker_names:
    raise SystemExit("broker archive lacks package metadata, lockfile, or guest agent")
with tarfile.open(broker_path, "r:*") as broker:
    manifest_member = broker.extractfile("gitedge/package.json")
    if manifest_member is None:
        raise SystemExit("broker package manifest is unreadable")
    manifest_bytes = manifest_member.read(4 * 1024 * 1024 + 1)
if len(manifest_bytes) > 4 * 1024 * 1024:
    raise SystemExit("broker package manifest is too large")
try:
    package_manager = json.loads(manifest_bytes)["packageManager"]
except (KeyError, TypeError, json.JSONDecodeError):
    raise SystemExit("broker package.json must declare packageManager")
match = re.fullmatch(r"pnpm@(\d+\.\d+\.\d+)(?:\+sha512\.[A-Za-z0-9+/=_-]+)?", package_manager)
if match is None:
    raise SystemExit("broker packageManager must pin an exact pnpm version")
with open(os.path.join(stage, "pnpm-version"), "w", encoding="ascii") as output:
    output.write(match.group(1))
if "node-v24.22.2-linux-x64/bin/node" not in node_names:
    raise SystemExit("Node archive does not contain the expected x64 distribution")
required_runner = {"config.sh", "run.sh", "bin/installdependencies.sh"}
if not required_runner <= runner_names:
    raise SystemExit("Actions runner archive is missing required official files")
PY

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git build-essential python3 python3-venv pkg-config \
  unzip zip jq docker.io sudo

mkdir -p /opt/gitedge/tools /opt/gitedge/job
install -d -o runner -g runner -m 0750 /opt/gitedge/job

node_root=/opt/gitedge/tools/node-$node_version
[[ ! -e $node_root ]] || fail "Node installation target already exists: $node_root"
mkdir -p "$stage/node"
tar -xJf "$node_archive" -C "$stage/node" --no-same-owner --no-same-permissions
mv "$stage/node/node-v$node_version-linux-x64" "$node_root"
ln -sfn "$node_root" /opt/gitedge/tools/node

runner_root=/opt/gitedge/actions-runner
[[ ! -e $runner_root ]] || fail "Actions runner target already exists: $runner_root"
mkdir -p "$runner_root"
tar -xzf "$runner_archive" -C "$runner_root" --no-same-owner --no-same-permissions
chown -R runner:runner "$runner_root"

broker_root=/opt/gitedge/broker
[[ ! -e $broker_root ]] || fail "broker target already exists: $broker_root"
mkdir -p /opt/gitedge
# The broker archive has exactly one approved top-level directory.
tar -xf "$broker_archive" -C /opt/gitedge --no-same-owner --no-same-permissions
mv /opt/gitedge/gitedge "$broker_root"
chown -R root:root "$broker_root"
chmod -R go-w "$broker_root"

for tool in node npm npx; do
  ln -sfn "/opt/gitedge/tools/node/bin/$tool" "/usr/local/bin/$tool"
done
ln -sfn /opt/gitedge/tools/bin/pnpm /usr/local/bin/pnpm
cat > /etc/profile.d/gitedge-tools.sh <<'PROFILE'
export PATH="/opt/gitedge/tools/node/bin:/opt/gitedge/tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PROFILE
chmod 0644 /etc/profile.d/gitedge-tools.sh
cat > /etc/sudoers.d/runner <<'SUDOERS'
runner ALL=(ALL) NOPASSWD:ALL
SUDOERS
chmod 0440 /etc/sudoers.d/runner
visudo -cf /etc/sudoers.d/runner >/dev/null
usermod -aG sudo,docker runner

export PATH="/opt/gitedge/tools/node/bin:/opt/gitedge/tools/bin:$PATH"
npm install --global --prefix /opt/gitedge/tools "pnpm@$(cat "$stage/pnpm-version")"
chown -R root:root /opt/gitedge/tools
chmod -R go-w /opt/gitedge/tools

cd "$runner_root"
./bin/installdependencies.sh

cd "$broker_root"
pnpm install --frozen-lockfile --prod

systemctl enable --now docker.service
if ! docker info >/dev/null 2>&1; then
  fail 'Docker daemon did not become usable for root.'
fi
if ! runuser -u runner -- docker info >/dev/null 2>&1; then
  fail 'Docker daemon is not usable by runner; verify its docker group session after login.'
fi

node --version | grep -Fx "v$node_version" >/dev/null || fail 'installed Node version does not match.'
pnpm --version | grep -Fx "$(cat "$stage/pnpm-version")" >/dev/null || fail 'installed pnpm version does not match.'
[[ -f $broker_root/scripts/runner-vm/guest.mjs ]] || fail 'guest agent was not installed.'

printf 'Ubuntu guest bootstrap complete. Broker and Actions runner remain unregistered and stopped.\n'

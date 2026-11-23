# Disposable VM runner pools

GitEdge's optional VM runner pools support disposable Hyper-V guests on Windows x64 and disposable QEMU/KVM macOS guests on Linux x64. Each registered profile ID must have exactly one entry under `pools`; there must not be an extra pool or a profile without a pool. Save this configuration as `vm.json` in the broker state directory. Registrations created against this configuration record the selected driver in their private profile; a missing VM configuration then stops startup instead of executing on the host.

Each dispatched GitHub job, GitEdge workflow, or signing request gets one new VM and one differencing disk based on its configured VHDX image. The broker records private recovery metadata in the job directory, then removes the VM and run directory when the job ends. When the broker starts, it scans its owned run directories and attempts to clean up VMs left by an interrupted job. Base images are shared read-only inputs; job writes go to differencing disks.

Verified VM pools report `isolation: "vm"` in their capacity. The dispatcher counts all running job kinds against each pool's slots. Native profiles retain whole-host exclusivity for GitEdge workflows and signing jobs.

## Configuration

This example starts one Windows slot with 8 vCPUs and 12 GiB, and one Linux slot with 8 vCPUs and 8 GiB. Size guests for the workflows they accept. The broker checks aggregate vCPU, memory, slot, and free-disk budgets across both pools. Reserve host capacity with `reserveCpus`, `reserveMemoryMiB`, and `reserveDiskMiB`. Hyper-V also requires at least 8 GiB of currently free host memory beyond each VM it starts. QEMU checks Linux `MemAvailable` against guest RAM after the aggregate ledger applies the configured reserve. Ensure the host has enough physical CPU, RAM, and disk for the chosen limits.

`diskMiB` is the host disk budget accounted for by each slot. Hyper-V jobs use differencing disks and QEMU jobs use sparse qcow2 overlays on their selected base images. `addresses` lists one unique static guest IPv4 address per slot across all pools.

```json
{
  "version": 1,
  "driver": "hyperv",
  "vmRoot": "D:\\GitEdge\\vm-pool",
  "reserveCpus": 4,
  "reserveMemoryMiB": 16384,
  "reserveDiskMiB": 20480,
  "pools": {
    "windows-profile": {
      "slots": 1,
      "addresses": ["192.168.240.10"],
      "machine": {
        "baseImage": "D:\\GitEdge\\images\\windows-runner.vhdx",
        "credentialPath": "D:\\GitEdge\\state\\windows-guest.credential.json",
        "cpus": 8,
        "memoryMiB": 12288,
        "diskMiB": 98304,
        "switchName": "GitEdge-Private",
        "guestNetwork": {
          "address": "192.168.240.10",
          "prefixLength": 24,
          "gateway": "192.168.240.1",
          "dns": ["1.1.1.1"]
        }
      },
      "guest": {
        "platform": "windows",
        "arch": "x64",
        "root": "C:\\ge\\job",
        "node": "C:\\ge\\tools\\node-v24.22.2-win-x64\\node.exe",
        "runtimeRoot": "C:\\ge\\broker",
        "runnerPath": "C:\\ge\\actions-runner",
        "entrypoint": "C:\\ge\\run-vm-job.cmd",
        "environment": {}
      }
    },
    "linux-profile": {
      "slots": 1,
      "addresses": ["192.168.240.20"],
      "machine": {
        "baseImage": "D:\\GitEdge\\images\\ubuntu-24.04-runner.vhdx",
        "cpus": 8,
        "memoryMiB": 8192,
        "diskMiB": 65536,
        "switchName": "GitEdge-Private",
        "guestNetwork": {
          "address": "192.168.240.20",
          "prefixLength": 24,
          "gateway": "192.168.240.1",
          "dns": ["1.1.1.1"]
        },
        "sshUser": "runner",
        "sshKeyPath": "D:\\GitEdge\\state\\guest-controller",
        "sshHostKey": "ssh-ed25519 REPLACE_WITH_GUEST_HOST_PUBLIC_KEY",
        "sshAuthorizedKey": "ssh-ed25519 REPLACE_WITH_CONTROLLER_PUBLIC_KEY"
      },
      "guest": {
        "platform": "linux",
        "arch": "x64",
        "root": "/opt/gitedge/job",
        "node": "/usr/local/bin/node",
        "runtimeRoot": "/opt/gitedge/broker",
        "runnerPath": "/opt/gitedge/actions-runner",
        "environment": {
          "RUNNER_ALLOW_RUNASROOT": "1"
        }
      }
    }
  }
}
```

Replace `windows-profile` and `linux-profile` with the exact profile IDs registered with the broker. The example's paths, subnet, and addresses are placeholders. Windows guests require an absolute `entrypoint`; the Windows image's `run-vm-job.cmd` activates the Visual Studio MSVC and Python environment before starting `node <runtimeRoot>\scripts\runner-launcher.mjs execute-vm-job`. Other guests run `node <runtimeRoot>/scripts/runner-launcher.mjs execute-vm-job` directly. Guest `environment` is for non-secret settings only.

## Host prerequisites and network boundary

Create the private Hyper-V **Internal** switch and its matching Windows NAT before starting the broker. The configured gateway and prefix must match the switch's host vEthernet adapter, and the NAT must cover that same subnet. The VM controller requires those resources to exist and match the configuration; it does not create or reconfigure the host switch or NAT.

The controller installs per-VM adapter ACLs. Inbound traffic is denied by default; Linux guests permit host-to-guest SSH on TCP port 22 from the configured gateway only. Outbound access is denied by default, with public IPv4 egress allowed after explicit blocks for private/LAN ranges, the host's IPv4 addresses, link-local metadata destinations, and other reserved ranges. Use a private subnet dedicated to these guests and unique addresses for every slot. No guest adapter is attached to an external switch. If a private forward proxy is required, set `machine.egressProxyPort` to its TCP port on the configured gateway. This adds one stateful outbound exception to that port. Configure `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_USE_ENV_PROXY=1` in the non-secret guest environment; the proxy must independently deny private, host, and metadata destinations. Configure the guest Docker service proxy as well when Docker jobs need it.

The host must be Windows x64 with Hyper-V and the required networking cmdlets available. The controller uses Windows PowerShell by default. To select PowerShell 7, set `GITEDGE_HYPERV_POWERSHELL` in the broker service's environment to its absolute executable path.

## QEMU macOS guests

QEMU pools run only on Linux x64 with KVM and the pre-created bridge/TAP setup documented in [macos-network.md](../scripts/runner-vm/macos-network.md). The broker runs as the unprivileged account that owns the TAPs and can read the root-managed SMC configuration. It requires QEMU, qemu-img, xorriso, OpenSSH client tools, and the sealed image paths to exist before serving. It never creates or changes host networking.

Each job gets independent qcow2 overlays for OpenCore, the macOS system disk, and RunnerData, plus a private copy of NVRAM. The bases remain read-only. Run overlays, seed ISO, per-job SSH keys and guest workspace writes live under `vmRoot`. Attach only the read-only `GITEDGE_SEED` ISO and those per-run overlays; the installer recovery image is not part of a job VM. The broker SSH key is generated per run and stays on the Linux host. The seed contains its public key and that guest's one-time SSH host private key; it contains no runner registration or job token. The macOS LaunchDaemon validates the seed, RunnerData APFS volume, account home, SSH policy and interface MAC before adding the key and bringing up SSH. SSH is pinned to that per-run host key.

The QEMU `vm.json` uses these driver-level paths and slot entries. A QEMU pool runs one or two slots; a one-slot pool lists only the first address and `slotNetwork` entry. Use the actual sealed image paths and the registered profile ID; keep the SMC file private and supply only its path.

```json
{
  "version": 1,
  "driver": "qemu",
  "vmRoot": "/srv/macos/runner-work",
  "reserveCpus": 2,
  "reserveMemoryMiB": 3584,
  "reserveDiskMiB": 4096,
  "qemu": "/usr/bin/qemu-system-x86_64",
  "qemuImg": "/usr/bin/qemu-img",
  "xorriso": "/usr/bin/xorriso",
  "ssh": "/usr/bin/ssh",
  "sshKeygen": "/usr/bin/ssh-keygen",
  "qemuWorkingDirectory": "/srv/macos/OSX-KVM",
  "firmwareCode": "/srv/macos/OSX-KVM/OVMF_CODE_4M.fd",
  "nvramTemplate": "/srv/macos/vm/OVMF_VARS-tahoe.fd",
  "smcConfig": "/srv/macos/vm/private/smc.qemu.conf",
  "pools": {
    "macos-profile": {
      "slots": 2,
      "addresses": ["10.253.247.2", "10.253.247.3"],
      "slotNetwork": [
        { "address": "10.253.247.2", "tap": "gemac1", "mac": "52:54:00:74:00:01" },
        { "address": "10.253.247.3", "tap": "gemac2", "mac": "52:54:00:74:00:02" }
      ],
      "machine": {
        "baseImage": "/srv/macos-system/mac-system-tahoe.qcow2",
        "openCoreImage": "/srv/macos/vm/OpenCore-tahoe.qcow2",
        "systemImage": "/srv/macos-system/mac-system-tahoe.qcow2",
        "runnerDataImage": "/srv/macos/vm/runner-data-tahoe.qcow2",
        "cpus": 4,
        "memoryMiB": 8192,
        "diskMiB": 102400,
        "cachePort": 3129,
        "egressProxyPort": 3128,
        "guestNetwork": {
          "address": "10.253.247.2",
          "prefixLength": 29,
          "gateway": "10.253.247.1",
          "dns": []
        }
      },
      "guest": {
        "platform": "macos",
        "arch": "x64",
        "sshUser": "gitedge-runner",
        "root": "/Volumes/RunnerData/Users/gitedge-runner/work",
        "node": "/Volumes/RunnerData/Users/gitedge-runner/.local/node/bin/node",
        "runtimeRoot": "/Volumes/RunnerData/Users/gitedge-runner/gitedge-runtime",
        "runnerPath": "/Volumes/RunnerData/Users/gitedge-runner/actions-runner",
        "environment": {}
      }
    }
  }
}
```

Use `platform: "macos"` and `arch: "x64"` for Intel guests. The broker reserves aggregate memory as `MemTotal - reserveMemoryMiB`, then admits a QEMU launch only when Linux `MemAvailable` is at least the requested guest RAM. The QEMU check does not add the Hyper-V 8 GiB free-memory margin a second time. Set `reserveCpus` and `reserveMemoryMiB` from the host's measured resources; this is admission accounting, not a performance guarantee.

Place `vmRoot`, the RunnerData base and the persistent cache directory on the mechanical D volume. Keep the sealed system image and Xcode on C. Store the cache server's `cache.json` binding at gateway `10.253.247.1`, port `3129`; each session is still scoped to its runner, repository, ref and job. Guest HTTP and HTTPS traffic uses the isolated bridge proxy at `10.253.247.1:3128`; the guest has no DNS server or other network route.

Before sealing the base, install `bootstrap-macos-image.sh` and its LaunchDaemon with `install-macos-image-bootstrap.sh` after configuring sshd to advertise only `/private/var/run/gitedge-vm/ssh_host_ed25519_key`. The broker requires two pre-provisioned slot assignments: `gemac1` / `52:54:00:74:00:01` / `10.253.247.2`, and `gemac2` / `52:54:00:74:00:02` / `10.253.247.3`. Configure the VM pool's `slotNetwork` entries in that order to match [macos-network.md](../scripts/runner-vm/macos-network.md).

Persistent dependency and build caches require explicit broker configuration. See [runner-cache.md](runner-cache.md) for shared device budgets, ref isolation and the private `machine.cachePort` exception.

## Guest access and image contents

Windows guest control uses PowerShell Direct and a host-side guest credential protected with machine-scoped DPAPI. Keep that credential file on the host with a private ACL; never include it in an image or template. It is separate from broker profile registration credentials.

Before executing a job, the controller sets each Windows guest to UTC and synchronizes its clock over PowerShell Direct. Startup fails if the measured clock difference exceeds five seconds.

Linux guest control uses SSH with a pinned Ed25519 host public key and a controller private key. Keep the private key on the host with host-only permissions. The guest image supplies its host key; cloud-init adds the controller's public key and configures the static address. The controller private key is not copied into the guest or job disk. Replace both public-key placeholders with complete Ed25519 public keys before use.

Base images should contain the runner launcher (`<runtimeRoot>/scripts/runner-launcher.mjs`), the official GitHub Actions runner files, Node, pnpm and other required build tools. The image bootstrap scripts install a whole release under `runtimeRoot`, which includes the launcher; only the launcher and the guest agent `scripts/runner-vm/guest.mjs` are used from it. Do not bake GitEdge host registration credentials into images. The broker keeps registration state in its protected host profile directories and uses the corresponding profile ID to select a pool.

The broker and job code do not come from the image. VM pools require the host broker to run under the launcher: each job payload names the runner kit the host is running and a lease heartbeat, and the guest launcher downloads that kit with the job's lease credential, keeps the lease alive while it unpacks the kit into `<guest.root>/state/runner-kit/<hex>` and runs `pnpm install --frozen-lockfile --prod --prefer-offline`, and then runs the kit's `execute-vm-job`. Host and guest therefore always run the same kit, and updating the host never invalidates an image. Images need Node 24, pnpm, network access to the GitEdge origin and package registry, and the platform tools listed in [Account Runner signing](account-runner-signing.md#signing-runtime), including Python 3.12 or newer on macOS guests. A pnpm store warmed during image preparation with `pnpm install --frozen-lockfile --prod` in `packages/runner-kit` makes that install faster. Keep the guest state directory writable by the job user; it is discarded with the VM.

Run `node scripts/actions-runner.mjs setup` in `runtimeRoot` during image preparation to cache the verified GitEdge workflow engine under `<runtimeRoot>/work/actions`, where guest jobs look for it. Workflow heartbeats and completion reports retry transient transport failures while their execution lease remains valid.

Complete Windows setup before installing guest tools. Shut the image OS down normally before freezing its VHDX; a forced VM reset can discard pending writes. Verify the extracted runtime files after unmounting the image, as well as the input archive hash.

Windows and Linux images share the same job lifecycle and labels, but install their platform-specific toolchain during image preparation. Keep base images separate from broker state, pool VM storage, and registration credentials. This document describes the configured design; the example is not evidence that a pool has been provisioned or validated.

## Verification and scale-up

Run `node runner-launcher.mjs verify-vm-images --state-dir <state>` with the controller account before starting the service. Verification boots a fresh guest for each pool, checks platform, tools, and that `node <runtimeRoot>/scripts/runner-launcher.mjs version` prints the host kit's launcher version, and removes those guests. An image needs rebuilding only when that version changes; an image made before the launcher existed fails verification until `scripts/runner-launcher.mjs` is added under `runtimeRoot` (and, on Windows, `run-vm-job.cmd` calls it instead of `runner-broker.mjs`). `serve` repeats this verification before connecting. A VM configuration error stops startup.

Host brokers update themselves through the launcher; see [Runner kit and launcher](actions.md#runner-kit-and-launcher). If an earlier release left an `active.lock` file after an unclean stop, verify that its recorded process is gone before removing that file. The current directory lock recovers automatically after sixty seconds without an update.

After real jobs and reclamation pass on one slot per platform, stop the controller while idle, set each pool to `slots: 2`, add a second unique address to each pool, and update the corresponding profile slot counts. Recheck aggregate budgets and image verification before restarting. Verify overlapping real jobs and confirm that VM configurations and differencing disks disappear afterward.

## Apple Silicon macOS hosts with Tart

The `tart` driver runs one disposable macOS ARM64 guest on an Apple Silicon macOS host.
Install Tart 2.41.1, Softnet 0.25.0, and a prepared **local** base VM containing the
Tart guest agent, an existing SSH-enabled guest user with passwordless sudo, Node 24,
pnpm, Git, the official ARM64 Actions runner, and this exact broker runtime.
Install both dependency sets with `pnpm install --frozen-lockfile` at the checkout
root and `pnpm --dir scripts/signing install --frozen-lockfile`. The signing SDK
has its own pinned manifest and lockfile. Installed `node_modules` trees are
excluded from the source digest; both manifests and lockfiles remain covered.

No new host account is required. Jobs execute as the configured existing guest user,
not as root or as the host user. Give that guest user ownership of its job directory
and the prepared runtime work directory. The guest agent identity is checked at boot.

Keep Tart storage, base disks and job disks on APFS so local clones use copy-on-write.
Set an absolute private `tartHome` used only by this broker. The base must be shut down
before serving. Do not store runner registration credentials or personal credentials
in the base. Clone names use `gitedge-job-<run UUID>`; recovery only removes that
run's VM after the broker validates its private recovery marker. Automatic image
pruning is disabled. The provider does not share host directories, clipboard, audio
or USB accessories, and it does not expose guest services to the LAN.

Example `vm.json` for a 64 GiB host (adjust resource reservations to the actual host):

```json
{
  "version": 1,
  "driver": "tart",
  "tart": "/Applications/Tart.app/Contents/MacOS/tart",
  "softnet": "/Library/Application Support/GitEdge/tools/softnet",
  "tartHome": "/Volumes/DevSSD/GitEdge/tart",
  "vmRoot": "/Volumes/DevSSD/GitEdge/vm-work",
  "reserveCpus": 5,
  "reserveMemoryMiB": 32768,
  "reserveDiskMiB": 20480,
  "pools": {
    "macmini-build-01": {
      "slots": 1,
      "addresses": ["127.0.0.1"],
      "machine": {
        "baseImage": "macmini-build-base",
        "cpus": 8,
        "memoryMiB": 24576,
        "diskMiB": 95367,
        "cachePort": 3129,
        "guestNetwork": { "gateway": "127.0.0.1" }
      },
      "guest": {
        "platform": "macos",
        "arch": "arm64",
        "sshUser": "admin",
        "root": "/opt/gitedge/job",
        "node": "/opt/gitedge/tools/node/bin/node",
        "runtimeRoot": "/opt/gitedge/broker",
        "runnerPath": "/opt/gitedge/actions-runner",
        "environment": {
          "PATH": "/opt/gitedge/tools/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        }
      }
    }
  }
}
```

For Tart, `addresses` identifies the single loopback cache session, not a static
DHCP assignment. Job control uses Tart's guest-agent transport. Cache transport
uses a per-VM Ed25519 controller key generated on the host and a pinned guest
public host key obtained over the guest agent. Only the controller's public key
is installed into the cloned guest. A restricted SSH reverse tunnel listens on
**guest loopback** port 3129 and forwards to **host loopback** port 3129. The private
key is never read or copied by the controller and is removed with run storage.
Softnet blocks VM-initiated connections to the host and peers, denies inbound
connections except host SSH, permits gateway DNS on UDP/TCP port 53, and retains
its private/LAN destination restrictions for other services.
No proxy is configured for Internet traffic.

Configure `cache.json` with `address: "127.0.0.1"`, `port: 3129`, and
`maxBytes: 100000000000` for a 100 GB shared cache budget. Keep its directory on
DevSSD outside VM disks. Existing cache ranking, repository/ref separation and
expiring job capabilities remain in effect. This is the cache store's application
budget; it is not a filesystem quota on VM images or other SSD contents.

Use `verify-vm-images` before registration or serving. It boots and removes a
fresh guest without claiming a project job. Register with `--slots 1 --cost 10`
and routing labels `dependency-install` and `cache-available`; no signing labels
are required. Set the server registration on hold before starting the broker.

# Hyper-V runner pools

GitEdge's optional VM runner pools use disposable Hyper-V guests on a Windows x64 host. A pool can contain Windows and Linux profiles at the same time. Each registered profile ID must have exactly one entry under `pools`; there must not be an extra pool or a profile without a pool. Save this configuration as `vm.json` in the broker state directory. Registrations created against this configuration record `execution: "hyperv"` in their private profile; a missing VM configuration then stops startup instead of executing on the host.

Each dispatched GitHub job, GitEdge workflow, or signing request gets one new VM and one differencing disk based on its configured VHDX image. The broker records private recovery metadata in the job directory, then removes the VM and run directory when the job ends. When the broker starts, it scans its owned run directories and attempts to clean up VMs left by an interrupted job. Base images are shared read-only inputs; job writes go to differencing disks.

## Configuration

This example starts one Windows slot with 8 vCPUs and 12 GiB, and one Linux slot with 8 vCPUs and 8 GiB. Size guests for the workflows they accept. The broker checks aggregate vCPU, memory, slot, and free-disk budgets across both pools. Reserve host capacity with `reserveCpus`, `reserveMemoryMiB`, and `reserveDiskMiB`; it also requires at least 8 GiB of currently free host memory beyond each VM it starts. Ensure the host has enough physical CPU, RAM, and disk for the chosen limits.

`diskMiB` is the host disk budget allocated to each slot. Each job disk is a Hyper-V differencing disk whose parent is the selected base image. `addresses` lists one unique static guest IPv4 address per slot across all pools.

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

Replace `windows-profile` and `linux-profile` with the exact profile IDs registered with the broker. The example's paths, subnet, and addresses are placeholders. Windows guests require an absolute `entrypoint`; the Windows image's `run-vm-job.cmd` activates the Visual Studio MSVC and Python environment before starting the broker's guest job command. Guest `environment` is for non-secret settings only.

## Host prerequisites and network boundary

Create the private Hyper-V **Internal** switch and its matching Windows NAT before starting the broker. The configured gateway and prefix must match the switch's host vEthernet adapter, and the NAT must cover that same subnet. The VM controller requires those resources to exist and match the configuration; it does not create or reconfigure the host switch or NAT.

The controller installs per-VM adapter ACLs. Inbound traffic is denied by default; Linux guests permit host-to-guest SSH on TCP port 22 from the configured gateway only. Outbound access is denied by default, with public IPv4 egress allowed after explicit blocks for private/LAN ranges, the host's IPv4 addresses, link-local metadata destinations, and other reserved ranges. Use a private subnet dedicated to these guests and unique addresses for every slot. No guest adapter is attached to an external switch. If a private forward proxy is required, set `machine.egressProxyPort` to its TCP port on the configured gateway. This adds one stateful outbound exception to that port. Configure `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_USE_ENV_PROXY=1` in the non-secret guest environment; the proxy must independently deny private, host, and metadata destinations. Configure the guest Docker service proxy as well when Docker jobs need it.

The host must be Windows x64 with Hyper-V and the required networking cmdlets available. The controller uses Windows PowerShell by default. To select PowerShell 7, set `GITEDGE_HYPERV_POWERSHELL` in the broker service's environment to its absolute executable path.

## Guest access and image contents

Windows guest control uses PowerShell Direct and a host-side guest credential protected with machine-scoped DPAPI. Keep that credential file on the host with a private ACL; never include it in an image or template. It is separate from broker profile registration credentials.

Before executing a job, the controller sets each Windows guest to UTC and synchronizes its clock over PowerShell Direct. Startup fails if the measured clock difference exceeds five seconds.

Linux guest control uses SSH with a pinned Ed25519 host public key and a controller private key. Keep the private key on the host with host-only permissions. The guest image supplies its host key; cloud-init adds the controller's public key and configures the static address. The controller private key is not copied into the guest or job disk. Replace both public-key placeholders with complete Ed25519 public keys before use.

Base images should contain the broker runtime, the official GitHub Actions runner files, Node and other required build tools. Do not bake GitEdge host registration credentials into images. The broker keeps registration state in its protected host profile directories and uses the corresponding profile ID to select a pool.

Run `node scripts/actions-runner.mjs setup` during image preparation to cache the verified GitEdge workflow engine. Workflow heartbeats and completion reports retry transient transport failures while their execution lease remains valid.

Complete Windows setup before installing guest tools. Shut the image OS down normally before freezing its VHDX; a forced VM reset can discard pending writes. Verify the extracted runtime files after unmounting the image, as well as the input archive hash.

Windows and Linux images share the same job lifecycle and labels, but install their platform-specific toolchain during image preparation. Keep base images separate from broker state, pool VM storage, and registration credentials. This document describes the configured design; the example is not evidence that a pool has been provisioned or validated.

## Verification and scale-up

Run `node scripts/runner-broker.mjs verify-vm-images --state-dir <state>` with the controller account before starting `serve`. Verification boots a fresh guest for each pool, checks platform, tools, and the broker release hash, and removes those guests. `serve` repeats this verification before connecting. A VM configuration error stops startup.

Stop the previous broker before updating it. If an earlier release left an `active.lock` file after an unclean stop, verify that its recorded process is gone before removing that file. The current directory lock recovers automatically after sixty seconds without an update.

After real jobs and reclamation pass on one slot per platform, stop the controller while idle, set each pool to `slots: 2`, add a second unique address to each pool, and update the corresponding profile slot counts. Recheck aggregate budgets and image verification before restarting. Verify overlapping real jobs and confirm that VM configurations and differencing disks disappear afterward.

# Hyper-V runner pools

GitEdge's optional VM runner pools use disposable Hyper-V guests on a Windows x64 host. A pool can contain Windows and Linux profiles at the same time. Each registered profile ID must have exactly one entry under `pools`; there must not be an extra pool or a profile without a pool. Save this configuration as `vm.json` in the broker state directory.

A job gets one new VM and one differencing disk based on its configured VHDX image. The broker records private recovery metadata in the job directory, then removes the VM and run directory when the job ends. When the broker starts, it scans its owned run directories and attempts to clean up VMs left by an interrupted job. Base images are shared read-only inputs; job writes go to differencing disks.

## Configuration

This small example starts each profile at one slot, one vCPU, and 1 GiB of guest memory. For heavier builds, increase each guest to two vCPUs and 2 GiB (`cpus: 2`, `memoryMiB: 2048`) and raise the host budget to match. The broker checks aggregate vCPU, memory, slot, and free-disk budgets across both pools. Reserve host capacity with `reserveCpus`, `reserveMemoryMiB`, and `reserveDiskMiB`; it also requires at least 8 GiB of currently free host memory beyond each VM it starts. Ensure the host has enough physical CPU, RAM, and disk for the chosen limits.

`diskMiB` is the host disk budget allocated to each slot. Each job disk is a Hyper-V differencing disk whose parent is the selected base image. `addresses` lists one unique static guest IPv4 address per slot across all pools.

```json
{
  "version": 1,
  "driver": "hyperv",
  "vmRoot": "D:\\GitEdge\\vm-pool",
  "reserveCpus": 2,
  "reserveMemoryMiB": 4096,
  "reserveDiskMiB": 32768,
  "pools": {
    "windows-profile": {
      "slots": 1,
      "addresses": ["192.168.240.10"],
      "machine": {
        "baseImage": "D:\\GitEdge\\images\\windows-runner.vhdx",
        "cpus": 1,
        "memoryMiB": 1024,
        "diskMiB": 32768,
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
        "root": "C:\\GitEdge\\job",
        "node": "C:\\GitEdge\\tools\\node\\node.exe",
        "runtimeRoot": "C:\\GitEdge",
        "runnerPath": "C:\\GitEdge\\actions-runner",
        "entrypoint": "C:\\GitEdge\\run-vm-job.cmd",
        "environment": {}
      }
    },
    "linux-profile": {
      "slots": 1,
      "addresses": ["192.168.240.20"],
      "machine": {
        "baseImage": "D:\\GitEdge\\images\\ubuntu-24.04-runner.vhdx",
        "cpus": 1,
        "memoryMiB": 1024,
        "diskMiB": 32768,
        "switchName": "GitEdge-Private",
        "guestNetwork": {
          "address": "192.168.240.20",
          "prefixLength": 24,
          "gateway": "192.168.240.1",
          "dns": ["1.1.1.1"]
        }
      },
      "guest": {
        "platform": "linux",
        "arch": "x64",
        "root": "/opt/gitedge/job",
        "node": "/opt/gitedge/tools/node/bin/node",
        "runtimeRoot": "/opt/gitedge",
        "runnerPath": "/opt/gitedge/actions-runner",
        "environment": {}
      }
    }
  }
}
```

Replace `windows-profile` and `linux-profile` with the exact profile IDs registered with the broker. The example's paths, subnet, and addresses are placeholders. Windows guests require an absolute `entrypoint`; the Windows image's `run-vm-job.cmd` activates the Visual Studio MSVC and Python environment before starting the broker's guest job command. Guest `environment` is for non-secret settings only.

## Host prerequisites and network boundary

Create the private Hyper-V **Internal** switch and its matching Windows NAT before starting the broker. The configured gateway and prefix must match the switch's host vEthernet adapter, and the NAT must cover that same subnet. The VM controller requires those resources to exist and match the configuration; it does not create or reconfigure the host switch or NAT.

The controller installs per-VM adapter ACLs. Inbound traffic is denied by default; Linux guests permit host-to-guest SSH on TCP port 22 from the configured gateway only. Outbound access is denied by default, with public IPv4 egress allowed after explicit blocks for private/LAN ranges, the host's IPv4 addresses, link-local metadata destinations, and other reserved ranges. Use a private subnet dedicated to these guests and unique addresses for every slot. No guest adapter is attached to an external switch.

The host must be Windows x64 with Hyper-V and the required networking cmdlets available. The controller uses Windows PowerShell by default. To select PowerShell 7, set `GITEDGE_HYPERV_POWERSHELL` in the broker service's environment to its absolute executable path.

## Guest access and image contents

Windows guest control uses PowerShell Direct and a host-side guest credential protected with machine-scoped DPAPI. Keep that credential file on the host with a private ACL; never include it in an image or template. It is separate from broker profile registration credentials.

Linux guest control uses SSH with a pinned Ed25519 host public key and a controller private key. Keep the private key on the host with host-only permissions. The guest image supplies its host key; cloud-init adds the controller's public key and configures the static address. The private key is not copied into the guest or job disk.

Base images should contain the broker runtime, the official GitHub Actions runner files, Node and other required build tools. Do not bake GitEdge host registration credentials into images. The broker keeps registration state in its protected host profile directories and uses the corresponding profile ID to select a pool.

Windows and Linux images share the same job lifecycle and labels, but install their platform-specific toolchain during image preparation. Keep base images separate from broker state, pool VM storage, and registration credentials. This document describes the configured design; the example is not evidence that a pool has been provisioned or validated.

# Runner cache

Runner cache persistence is opt-in on each broker. Without an explicit cache configuration, the Actions cache v2 service accepts saves and discards their contents; restores return a miss. Workflows continue to use standard `actions/cache` and dependency setup actions. Dependencies and build outputs must be declared by the workflow; enabling storage does not choose build directories automatically.

Save a private `cache.json` in the broker state directory:

```json
{
  "version": 1,
  "directory": "D:\\GitEdgeRunnerCache",
  "maxBytes": 1000000000000,
  "address": "192.168.240.1",
  "port": 3129,
  "profiles": ["windows-profile", "linux-profile"],
  "proxy": "http://127.0.0.1:23129"
}
```

`maxBytes` is the entire device's shared budget, including pending uploads. Profiles share available space dynamically. Entries remain isolated by registered runner, repository, authorized ref, cache key and cache version. A runner's capacity reports explicit cache support and usage; an omitted profile has no persistent cache. The optional `proxy` supplies outbound GitHub token-key discovery through the existing egress proxy.

For Hyper-V pools, set `machine.cachePort` to the same port on each enabled profile. The service binds only to the configured VM gateway; the controller permits that exact gateway port through each guest's outbound ACL. Restrict the Windows firewall rule to the pool's guest addresses and local gateway. Include the gateway in guest `NO_PROXY`/`no_proxy`. Host execution requires a loopback listener. Do not expose the listener to a LAN or the Internet.

Each job receives an expiring capability bound to its runner, repository and source address. GitHub saves and restores also verify the signed runtime token's repository and cache scope permissions. Capabilities are revoked when a job ends. Each task's private official runner copy redirects its cache v2 endpoint; artifact requests continue to their original results service. The installed shared runner is untouched. Legacy cache v1 clients are unsupported.

The store learns from restore requests. Retention ranks seven-day decaying access frequency first, archive size second, then last access. Frequent large entries take priority over frequent small entries; cold small entries are evicted first. A new upload cannot displace higher-priority entries. Concurrent blocks reserve space before writing, active downloads are pinned, and archives stay in ordered blocks to avoid a second merged copy. An upload that cannot fit is accepted and discarded. Metadata and interrupted uploads are bounded; startup reclaims incomplete work.

Place storage in a dedicated private directory. On Windows Server, enforce an additional physical hard quota on that directory, for example `New-FsrmQuota -Path D:\GitEdgeRunnerCache -Size 1000000000000`. Do not use `-SoftLimit`. This also bounds metadata and filesystem overhead. Keep free space for the host and VM differencing disks outside the cache budget.

Stop the broker while idle before changing configuration or runtime files. VM base images must contain the same broker release as the controller. Verify fresh Windows and Linux guests, then confirm a save followed by a restore in a different guest and inspect the reported usage. Removing a profile from `profiles` disables persistence for future jobs; existing cached objects are reclaimed by the normal budget policy.

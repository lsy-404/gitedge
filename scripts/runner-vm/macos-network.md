# macOS VM network

On the Linux host, review `macos-network.sh`, then run it once as root with `bash macos-network.sh install BROKER_USER`. The named account owns the two persistent TAP devices; QEMU can open them without network administration capability. Installation checks required commands and network conflicts before creating a root-owned systemd unit and script and starting the service. Existing installation paths, interfaces, nftables tables, overlapping IPv4 routes or addresses, and listeners on port 3128 cause a failure. The service must be active before starting the broker. A failed installation needs operator inspection before retrying.

| Slot | TAP | MAC | IPv4 address |
| --- | --- | --- | --- |
| 1 | `gemac1` | `52:54:00:74:00:01` | `10.253.247.2/29` |
| 2 | `gemac2` | `52:54:00:74:00:02` | `10.253.247.3/29` |

The bridge `gemacbr` is `10.253.247.1/29`. Configure each guest with its assigned static address, gateway `10.253.247.1`, and no DNS server. Set its HTTP and HTTPS proxy to `10.253.247.1:3128`; the upstream proxy resolves target names. Bind the host cache to `10.253.247.1:3129`. The proxy forwards to `172.29.73.1:3128`. Host SSH connections to a guest must use `10.253.247.1` as their source address. Guest traffic is restricted to the gateway proxy and cache, and established replies to host SSH. The bridge does not provide guest-to-guest forwarding, routed networking, IPv6, or DNS.

Before installation, check syntax with `bash -n scripts/runner-vm/macos-network.sh`. On the target host, review routes, listeners and the named broker account. After installation, check `systemctl status gitedge-macvm-network`, `ip address show gemacbr`, `ip tuntap show`, and `nft list table bridge gitedge_macvm` / `nft list table inet gitedge_macvm`. Validate isolation and connectivity with disposable guests before admitting jobs. Stop the broker and its guests before stopping or restarting the network service, then start the broker after the network service is ready. Stopping the service removes its interfaces and tables; it does not change existing host routing, forwarding, Docker state or firewall rules.

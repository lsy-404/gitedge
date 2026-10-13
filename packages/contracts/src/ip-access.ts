import { z } from "zod";
import ipaddr from "ipaddr.js";

export const IP_RPM_MIN = 1;
export const IP_RPM_MAX = 100_000;

export const UpdateIpRpmSchema = z
  .object({ rpm: z.number().int().min(IP_RPM_MIN).max(IP_RPM_MAX) })
  .strict();
export type UpdateIpRpm = z.infer<typeof UpdateIpRpmSchema>;

export const CreateAccessBanSchema = z
  .object({
    kind: z.enum(["user", "ip"]),
    value: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(500),
    expiresAt: z.number().int().positive().nullable(),
  })
  .strict();
export type CreateAccessBan = z.infer<typeof CreateAccessBanSchema>;

export const AccessBanSchema = z.object({
  id: z.string(),
  kind: z.enum(["user", "ip"]),
  value: z.string(),
  reason: z.string(),
  expiresAt: z.number().nullable(),
  createdAt: z.number(),
  createdBy: z.string(),
});
export type AccessBan = z.infer<typeof AccessBanSchema>;

export const IpAccessSettingsSchema = z.object({
  rpm: z.number().int().min(IP_RPM_MIN).max(IP_RPM_MAX),
});
export type IpAccessSettings = z.infer<typeof IpAccessSettingsSchema>;

export function canonicalIpRange(value: string): string {
  const [address, prefix] = ipaddr.parseCIDR(value);
  if (address.kind() === "ipv4")
    return `${ipaddr.IPv4.networkAddressFromCIDR(value).toString()}/${prefix}`;
  const ipv6 = ipaddr.IPv6.parse(address.toString());
  if (ipv6.isIPv4MappedAddress()) {
    if (prefix < 96) throw new Error("IPv4-mapped CIDR prefix must be at least 96.");
    const ipv4 = ipv6.toIPv4Address();
    const ipv4Prefix = prefix - 96;
    const network = ipaddr.IPv4.networkAddressFromCIDR(`${ipv4.toString()}/${ipv4Prefix}`);
    return `${network.toString()}/${ipv4Prefix}`;
  }
  return `${ipaddr.IPv6.networkAddressFromCIDR(value).toRFC5952String()}/${prefix}`;
}

export function ipMatchesRange(ip: string, range: string): boolean {
  try {
    const address = ipaddr.parse(ip);
    const [network, prefix] = ipaddr.parseCIDR(range);
    const candidate =
      address.kind() === "ipv6"
        ? normalizeMappedAddress(ipaddr.IPv6.parse(address.toString()))
        : address;
    return candidate.kind() === network.kind() && candidate.match(network, prefix);
  } catch {
    return false;
  }
}

function normalizeMappedAddress(address: ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
  const ipv6 = ipaddr.IPv6.parse(address.toString());
  return ipv6.isIPv4MappedAddress() ? ipv6.toIPv4Address() : ipv6;
}

export function parseIpRange(value: string): string {
  const input = value.includes("/")
    ? value
    : `${value}/${ipaddr.parse(value).kind() === "ipv4" ? 32 : 128}`;
  return canonicalIpRange(input);
}

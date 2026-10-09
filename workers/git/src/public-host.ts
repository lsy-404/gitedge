import { readTextLimited } from "../../../src/worker/common/readText";

export type HostResolution =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "private_address" | "unresolved" | "resolver_error" };

export type HostResolver = (hostname: string) => Promise<HostResolution>;

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 3000;
const MAX_ANSWERS = 32;
const MAX_RESPONSE_BYTES = 65_536;

// Special-purpose ranges from the IANA IPv4 registry: this network, private, shared, loopback,
// link-local, protocol assignments, documentation, benchmarking, multicast and reserved.
const IPV4_BLOCKED: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function blockedIpv4(value: number): boolean {
  return IPV4_BLOCKED.some(([network, bits]) => {
    const size = 2 ** (32 - bits);
    return Math.floor(value / size) === Math.floor(network / size);
  });
}

function ipv6Groups(address: string): number[] | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const last = halves.length === 2 ? right : left;
  const embedded = last.at(-1)?.includes(".") ? last.pop() : undefined;
  const embeddedValue = embedded === undefined ? null : ipv4Number(embedded);
  if (embedded !== undefined && embeddedValue === null) return null;
  const words =
    embeddedValue === null ? [] : [Math.floor(embeddedValue / 65536), embeddedValue % 65536];
  const explicit = left.length + right.length + words.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  const groups = [...left, ...Array<string>(8 - explicit).fill("0"), ...right].map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN
  );
  if (groups.some(Number.isNaN)) return null;
  return [...groups, ...words];
}

function blockedIpv6(groups: readonly number[]): boolean {
  const [first = 0, second = 0] = groups;
  if (groups.slice(0, 7).every((group) => group === 0)) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0))
    return blockedIpv4((groups[6] ?? 0) * 65536 + (groups[7] ?? 0));
  if (first === 0x64 && second === 0xff9b) return true;
  if (first === 0x100 && groups.slice(1, 4).every((group) => group === 0)) return true;
  if (first === 0x2001 && (second === 0x0db8 || second < 0x200)) return true;
  if (first === 0x2002) return true;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** True when an address is loopback, private, link-local, shared, reserved, multicast or unparsable. */
export function isNonPublicAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) return blockedIpv4(v4);
  const v6 = ipv6Groups(address);
  return v6 === null || blockedIpv6(v6);
}

interface DohAnswer {
  readonly type: number;
  readonly data: string;
}

function dohAnswers(payload: unknown): DohAnswer[] | null {
  if (!payload || typeof payload !== "object" || !("Status" in payload)) return null;
  if (payload.Status !== 0 || !("Answer" in payload)) return [];
  if (!Array.isArray(payload.Answer)) return null;
  return payload.Answer.slice(0, MAX_ANSWERS).flatMap((answer: unknown) =>
    answer &&
    typeof answer === "object" &&
    "type" in answer &&
    "data" in answer &&
    typeof answer.type === "number" &&
    typeof answer.data === "string"
      ? [{ type: answer.type, data: answer.data }]
      : []
  );
}

/** Resolves A and AAAA records over DNS-over-HTTPS and rejects hosts that reach non-public addresses. */
export async function resolvePublicHost(hostname: string): Promise<HostResolution> {
  const addresses: string[] = [];
  for (const [type, recordType] of [
    ["A", 1],
    ["AAAA", 28],
  ] as const) {
    const url = new URL(DOH_ENDPOINT);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    let answers: DohAnswer[] | null;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      });
      const text = response.ok ? await readTextLimited(response.body, MAX_RESPONSE_BYTES) : null;
      if (!response.ok) await response.body?.cancel();
      answers = text === null ? null : dohAnswers(JSON.parse(text));
    } catch {
      answers = null;
    }
    if (!answers) return { ok: false, reason: "resolver_error" };
    for (const answer of answers) if (answer.type === recordType) addresses.push(answer.data);
  }
  if (addresses.length === 0) return { ok: false, reason: "unresolved" };
  return addresses.some(isNonPublicAddress)
    ? { ok: false, reason: "private_address" }
    : { ok: true };
}

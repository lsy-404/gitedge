export type ImportUrlRejection =
  "invalid" | "scheme" | "credentials" | "ip_literal" | "local_host" | "port";

export type ImportUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: ImportUrlRejection };

const MAX_URL_LENGTH = 2048;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];

// WHATWG URL normalizes decimal, octal and hex IPv4 forms, so only dotted quads remain; a numeric last label also catches unparsed variants.
function ipLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  const last = hostname.split(".").at(-1) ?? "";
  return /^(?:\d+|0x[0-9a-f]*)$/i.test(last);
}

/**
 * Accepts only public https remotes on the default port. DNS cannot be resolved inside a Worker,
 * so hostnames that resolve to private ranges are blocked by Artifacts' own egress, not here.
 */
export function validateImportUrl(input: string): ImportUrlResult {
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (ipLiteral(hostname)) return { ok: false, reason: "ip_literal" };
  if (
    !hostname.includes(".") ||
    hostname === "localhost" ||
    LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  )
    return { ok: false, reason: "local_host" };
  if (url.port) return { ok: false, reason: "port" };
  if (!/^[a-z0-9.-]+$/.test(hostname)) return { ok: false, reason: "invalid" };
  url.hash = "";
  url.search = "";
  return { ok: true, url: url.toString() };
}

/** Suggests a repository name from the last path segment of a clone URL. */
export function repositoryNameFromUrl(input: string): string {
  try {
    const segment = decodeURIComponent(
      new URL(input.trim()).pathname.split("/").filter(Boolean).at(-1) ?? ""
    );
    return segment
      .replace(/\.git$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .slice(0, 100);
  } catch {
    return "";
  }
}

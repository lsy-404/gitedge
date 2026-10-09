import {
  NamespaceSlugSchema,
  ReservedAccountIdentifiers,
  RepositorySlugSchema,
} from "../../../packages/contracts/src/index";

export interface SiteTarget {
  owner: string;
  repo: string;
  /** Commit OID of a pull request preview; null for the branch site. */
  preview: string | null;
  /** Raw (still encoded) path inside the site, empty or starting with a slash. */
  path: string;
  mode: "path" | "host";
}

const PATH_ROUTE = /^\/([^/]+)\/([^/]+)\/-\/(site|preview)(\/.*)?$/;
const PREVIEW_PATH = /^\/([0-9a-f]{40})(\/.*)?$/;
const HOST_ROUTE = /^\/([^/]+)(\/.*)?$/;

/** Splits a preview remainder into its commit OID and the path inside the preview. */
function previewTarget(
  rest: string | undefined
): { oid: string; path: string } | "redirect" | null {
  if (rest === undefined) return null;
  const match = PREVIEW_PATH.exec(rest);
  if (!match) return null;
  return match[2] === undefined ? "redirect" : { oid: match[1], path: match[2] };
}

export type SiteMatch =
  | { kind: "site"; target: SiteTarget }
  | { kind: "redirect"; location: string }
  | { kind: "not-found" };

function validNames(owner: string, repo: string): boolean {
  return (
    !ReservedAccountIdentifiers.has(owner) &&
    NamespaceSlugSchema.safeParse(owner).success &&
    RepositorySlugSchema.safeParse(repo).success
  );
}

function withSlash(url: URL): SiteMatch {
  return { kind: "redirect", location: `${url.pathname}/${url.search}` };
}

/** True when the request host is `<owner>.<sitesHost>`; the owner label is returned. */
export function sitesHostOwner(hostname: string, sitesHost: string | undefined): string | null {
  const suffix = sitesHost?.trim().toLowerCase();
  if (!suffix) return null;
  const host = hostname.toLowerCase();
  if (!host.endsWith(`.${suffix}`)) return null;
  const owner = host.slice(0, -(suffix.length + 1));
  return owner && !owner.includes(".") ? owner : null;
}

/** Path scheme: `/<owner>/<repo>/-/site/...` and `/<owner>/<repo>/-/preview/<oid>/...`. */
export function matchPathSite(url: URL): SiteMatch | null {
  const match = PATH_ROUTE.exec(url.pathname);
  if (!match) return null;
  const [, owner, repo, kind, rest] = match;
  if (!validNames(owner, repo)) return null;
  if (kind === "site") {
    if (rest === undefined) return withSlash(url);
    return { kind: "site", target: { owner, repo, preview: null, path: rest, mode: "path" } };
  }
  const preview = previewTarget(rest);
  if (preview === "redirect") return withSlash(url);
  if (!preview) return { kind: "not-found" };
  return {
    kind: "site",
    target: { owner, repo, preview: preview.oid, path: preview.path, mode: "path" },
  };
}

/** Host scheme: `https://<owner>.<sitesHost>/<repo>/...` with previews under `/<repo>/-/preview/<oid>/`. */
export function matchHostSite(url: URL, owner: string): SiteMatch {
  const match = HOST_ROUTE.exec(url.pathname);
  if (!match || !validNames(owner, match[1])) return { kind: "not-found" };
  const [, repo, rest] = match;
  if (rest === undefined) return withSlash(url);
  const preview = /^\/-\/preview(\/.*)?$/.exec(rest);
  if (!preview)
    return { kind: "site", target: { owner, repo, preview: null, path: rest, mode: "host" } };
  const target = previewTarget(preview[1]);
  if (target === "redirect") return withSlash(url);
  if (!target) return { kind: "not-found" };
  return {
    kind: "site",
    target: { owner, repo, preview: target.oid, path: target.path, mode: "host" },
  };
}

export const SITE_FETCH_VARY = "Sec-Fetch-Site, Sec-Fetch-Mode";

/**
 * Path-scheme files share the application origin, so a non-navigation request from that origin
 * would let them satisfy the application's `script-src 'self'`. Sandboxed site documents have an
 * opaque origin and send `cross-site`, so only application pages are refused here.
 */
export function loadedByApplicationOrigin(request: Request): boolean {
  return (
    request.headers.get("Sec-Fetch-Site") === "same-origin" &&
    request.headers.get("Sec-Fetch-Mode") !== "navigate"
  );
}

export function siteRequest(request: Request, target: SiteTarget): Request {
  const url = new URL("https://git.internal/internal/site");
  url.searchParams.set("owner", target.owner);
  url.searchParams.set("repo", target.repo);
  url.searchParams.set("path", target.path);
  url.searchParams.set("mode", target.mode);
  url.searchParams.set("search", new URL(request.url).search);
  if (target.preview) url.searchParams.set("preview", target.preview);
  const headers = new Headers();
  const conditional = request.headers.get("If-None-Match");
  if (conditional) headers.set("If-None-Match", conditional);
  return new Request(url, { method: request.method, headers });
}

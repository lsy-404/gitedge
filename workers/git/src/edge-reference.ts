import { GitOidSchema } from "../../../packages/contracts/src/index";
import type { EdgeAddress } from "./edge-cache";
import { resolveCommit } from "./read";

export interface EdgeReference {
  /** The ref or commit id the response is computed from; null for ref-independent listings. */
  readonly ref: string | null;
  readonly params: Readonly<Record<string, string>>;
}

const LISTINGS = new Set(["refs", "branches", "tags"]);

function pick(url: URL, ...names: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null) params[name] = value;
  }
  return params;
}

/** Describes what a cacheable read depends on, or null when the resource is never cached. */
export function edgeReference(
  resource: string,
  url: URL,
  ref: string,
  path: string
): EdgeReference | null {
  if (LISTINGS.has(resource)) return { ref: null, params: pick(url, "name") };
  switch (resource) {
    case "tree":
    case "file":
    case "blame":
      return { ref, params: { ref, path } };
    case "files":
      return { ref, params: { ref } };
    case "commits":
      return { ref, params: { ref, ...pick(url, "limit", "offset") } };
    case "history": {
      const cursor = url.searchParams.get("cursor");
      return cursor !== null && GitOidSchema.safeParse(cursor).success
        ? { ref: cursor, params: { path } }
        : { ref, params: { ref, path } };
    }
    case "commit-diff": {
      const oid = url.searchParams.get("oid") ?? "";
      return GitOidSchema.safeParse(oid).success ? { ref: oid, params: {} } : null;
    }
    default:
      return null;
  }
}

/**
 * Names the cache entry for a read. Full commit ids are immutable; a branch or tag is resolved to
 * its current commit so the key changes the moment a push moves it. Unresolvable refs and reads
 * that cannot be shared skip the extra lookup and are served uncached.
 */
export async function edgeAddress(
  repo: Parameters<typeof resolveCommit>[0],
  reference: EdgeReference,
  shared: boolean
): Promise<EdgeAddress | null> {
  if (reference.ref === null) return { kind: "listing" };
  if (GitOidSchema.safeParse(reference.ref).success)
    return { kind: "immutable", oid: reference.ref };
  if (!shared) return null;
  const commit = await resolveCommit(repo, reference.ref);
  return commit ? { kind: "ref", oid: commit.hash } : null;
}

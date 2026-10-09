import { contentDisposition } from "../../../src/worker/common/content-disposition";
import { errorResponse } from "../../../src/worker/common/http";
import { GitOidSchema } from "../../../packages/contracts/src/index";
import { readArtifactTree } from "./read";

export const RAW_MAX_BYTES = 64 * 1024 * 1024;
const TEXT_SNIFF_BYTES = 8192;
const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const INLINE_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export type RawRepository = Pick<ArtifactsRepo, "info" | "log" | "readTree" | "readBlob">;
export interface RawTarget {
  ref: string;
  path: string;
}
export interface RawDelivery {
  contentType: string;
  disposition: "inline" | "attachment";
}

function textual(sample: Uint8Array): boolean {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Only plain text and raster/vector images render in the browser; everything else downloads. */
export function classifyRaw(path: string, sample: Uint8Array, forceDownload: boolean): RawDelivery {
  const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  const image = INLINE_IMAGE_TYPES[extension];
  if (forceDownload)
    return { contentType: image ?? "application/octet-stream", disposition: "attachment" };
  if (image) return { contentType: image, disposition: "inline" };
  if (textual(sample)) return { contentType: "text/plain; charset=utf-8", disposition: "inline" };
  return { contentType: "application/octet-stream", disposition: "attachment" };
}

/**
 * Splits `ref/path` where the ref may itself contain slashes by preferring the longest
 * existing branch or tag name. Commit ids and HEAD are recognised without listing refs.
 */
export async function splitRawSpec(
  spec: string,
  defaultBranch: string,
  refNames: () => Promise<ReadonlySet<string>>
): Promise<RawTarget | null> {
  const segments = spec.split("/");
  if (segments.length < 2 || segments.some((segment) => segment === "")) return null;
  const first = segments[0] ?? "";
  if (GitOidSchema.safeParse(first).success)
    return { ref: first, path: segments.slice(1).join("/") };
  const names = await refNames();
  for (let end = segments.length - 1; end >= 1; end -= 1) {
    const candidate = segments.slice(0, end).join("/");
    if (candidate === "HEAD") return { ref: defaultBranch, path: segments.slice(end).join("/") };
    if (names.has(candidate)) return { ref: candidate, path: segments.slice(end).join("/") };
  }
  return null;
}

export interface RawOptions {
  publicRepository: boolean;
  forceDownload: boolean;
  head: boolean;
  ifNoneMatch: string | null;
}

/** Streams one blob with headers that keep repository content from executing in the origin. */
export async function serveRaw(
  repo: RawRepository,
  target: RawTarget,
  options: RawOptions
): Promise<Response> {
  const slash = target.path.lastIndexOf("/");
  const parent = await readArtifactTree(
    repo,
    target.ref,
    slash === -1 ? "" : target.path.slice(0, slash)
  );
  const entry = parent?.entries.find((item) => item.path === target.path && item.type === "blob");
  if (!entry) return errorResponse(404, "not_found", "File was not found.");
  const etag = `"${entry.oid}"`;
  const immutable = GitOidSchema.safeParse(target.ref).success;
  const cacheControl = options.publicRepository
    ? immutable
      ? "public, max-age=300"
      : "public, max-age=0, must-revalidate"
    : "private, no-store";
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
    "Referrer-Policy": "no-referrer",
  };
  if (options.ifNoneMatch?.split(",").some((value) => value.trim() === etag))
    return new Response(null, { status: 304, headers });
  let blob: Blob | null;
  try {
    blob = await repo.readBlob(entry.oid);
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "MEMORY_LIMIT"
    )
      return errorResponse(
        413,
        "file_too_large",
        "The file is too large to serve; clone the repository instead."
      );
    throw cause;
  }
  if (!blob) return errorResponse(404, "not_found", "File was not found.");
  if (blob.size > RAW_MAX_BYTES)
    return errorResponse(
      413,
      "file_too_large",
      "The file is too large to serve; clone the repository instead."
    );
  const sample = new Uint8Array(await blob.slice(0, TEXT_SNIFF_BYTES).arrayBuffer());
  const delivery = classifyRaw(target.path, sample, options.forceDownload);
  const filename = target.path.split("/").at(-1) ?? "download";
  return new Response(options.head ? null : blob.stream(), {
    headers: {
      ...headers,
      "Content-Type": delivery.contentType,
      "Content-Length": String(blob.size),
      "Content-Disposition": contentDisposition(delivery.disposition, filename),
    },
  });
}

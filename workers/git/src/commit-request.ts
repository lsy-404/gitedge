import {
  CommitRepositoryChangesSchema,
  REPOSITORY_COMMIT_LIMITS,
  editablePath,
  type EditRepositoryFileInput,
} from "../../../packages/contracts/src/repository-controls";
import type { RepositoryChange } from "./changes";
import type { RepositoryCommitInput } from "./write";

export class CommitRequestError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const MULTIPART_OVERHEAD_BYTES = 512 * 1024;
const MAX_BODY_BYTES =
  REPOSITORY_COMMIT_LIMITS.totalBytes +
  REPOSITORY_COMMIT_LIMITS.manifestBytes +
  MULTIPART_OVERHEAD_BYTES;

class BodyLimitError extends Error {}

function limitedBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_BODY_BYTES) throw new BodyLimitError("Request body is too large.");
        controller.enqueue(chunk);
      },
    })
  );
}
async function readForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data"))
    throw new CommitRequestError(
      415,
      "unsupported_media_type",
      "Commits require multipart/form-data."
    );
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    throw new CommitRequestError(
      413,
      "payload_too_large",
      "The upload exceeds the commit size limit."
    );
  if (!request.body) throw new CommitRequestError(400, "bad_request", "Request body is required.");
  try {
    return await new Response(limitedBody(request.body), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch (cause) {
    if (cause instanceof BodyLimitError)
      throw new CommitRequestError(413, "payload_too_large", cause.message);
    throw new CommitRequestError(400, "bad_request", "Malformed multipart request.");
  }
}

/** Parses a multipart commit: a `manifest` JSON field plus one file field per referenced part. */
export async function readCommitRequest(request: Request): Promise<RepositoryCommitInput> {
  const form = await readForm(request);
  const manifest = form.get("manifest");
  if (typeof manifest !== "string" || manifest.length > REPOSITORY_COMMIT_LIMITS.manifestBytes)
    throw new CommitRequestError(400, "bad_request", "Commit manifest is missing or too large.");
  let value: unknown;
  try {
    value = JSON.parse(manifest);
  } catch {
    throw new CommitRequestError(400, "bad_request", "Commit manifest is not valid JSON.");
  }
  const parsed = CommitRepositoryChangesSchema.safeParse(value);
  if (!parsed.success) throw new CommitRequestError(400, "bad_request", "Invalid commit manifest.");
  const { changes, ...input } = parsed.data;
  const referenced = new Set<string>(["manifest"]);
  let total = 0;
  async function readPart(part: string, path: string): Promise<Uint8Array> {
    const file = form.get(part);
    if (typeof file === "string" || file === null)
      throw new CommitRequestError(400, "bad_request", `File part for ${path} is missing.`);
    if (file.size > REPOSITORY_COMMIT_LIMITS.fileBytes)
      throw new CommitRequestError(
        413,
        "file_too_large",
        `${path} exceeds the per-file size limit.`
      );
    total += file.size;
    if (total > REPOSITORY_COMMIT_LIMITS.totalBytes)
      throw new CommitRequestError(
        413,
        "payload_too_large",
        "The commit exceeds the total size limit."
      );
    referenced.add(part);
    return new Uint8Array(await file.arrayBuffer());
  }
  const resolved: RepositoryChange[] = [];
  for (const change of changes) {
    if (change.op === "put")
      resolved.push({
        op: "put",
        path: change.path,
        content: await readPart(change.part, change.path),
      });
    else if (change.op === "move" && change.part)
      resolved.push({
        op: "move",
        from: change.from,
        to: change.to,
        content: await readPart(change.part, change.to),
      });
    else if (change.op === "move") resolved.push({ op: "move", from: change.from, to: change.to });
    else resolved.push(change);
  }
  for (const key of form.keys())
    if (!referenced.has(key))
      throw new CommitRequestError(400, "bad_request", "Unexpected form field in commit request.");
  return { ...input, changes: resolved };
}

/** Maps the single-file JSON edit contract onto the shared commit pipeline. */
export function commitFromEdit(edit: EditRepositoryFileInput): RepositoryCommitInput {
  const content = edit.content === null ? null : new TextEncoder().encode(edit.content);
  if (!editablePath(edit.path) || (content && content.byteLength > 1_000_000))
    throw new CommitRequestError(400, "bad_request", "Invalid path or file size.");
  return {
    branch: edit.branch,
    ...(edit.newBranch ? { newBranch: edit.newBranch } : {}),
    expectedOid: edit.expectedOid,
    message: edit.message,
    changes: [
      content
        ? { op: "put", path: edit.path, content, textEdit: true }
        : { op: "delete", path: edit.path },
    ],
  };
}

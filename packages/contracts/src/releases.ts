import { z } from "zod";
import { GitBranchSchema, GitOidSchema, type Actor } from "./forge";

export const RELEASE_ASSET_MAX_BYTES = 100 * 1024 * 1024;
export const RELEASE_MAX_ASSETS = 50;
export const RELEASE_MAX_PER_REPOSITORY = 1000;
export const RELEASE_REPOSITORY_ASSET_BYTES = 10 * 1024 * 1024 * 1024;
export const RELEASE_LIST_LIMIT = 100;
export const TAG_LIST_LIMIT = 100;

export const GitTagNameSchema = GitBranchSchema.refine((value) => value.length <= 200);
/** Branch name or full commit id a new tag points at. */
export const TagTargetSchema = z.union([GitOidSchema, GitBranchSchema]);

export const CreateTagInputSchema = z
  .object({
    name: GitTagNameSchema,
    target: TagTargetSchema,
    /** Branch whose history contains `target` when it is a commit id; defaults to the default branch. */
    source: GitBranchSchema.optional(),
    /** An annotated tag is created when a message is present. */
    message: z.string().trim().min(1).max(5000).optional(),
  })
  .strict();
export type CreateTagInput = z.infer<typeof CreateTagInputSchema>;

export const DeleteTagInputSchema = z
  .object({ name: GitTagNameSchema, expectedOid: GitOidSchema })
  .strict();
export type DeleteTagInput = z.infer<typeof DeleteTagInputSchema>;

export interface RepositoryTag {
  name: string;
  /** Tag object id for annotated tags, otherwise the commit id. */
  oid: string;
  commitOid: string;
  annotated: boolean;
  subject: string;
  timestamp: number;
}

const releaseTitle = z.string().trim().max(200);
const releaseBody = z.string().max(50_000);

export const CreateReleaseInputSchema = z
  .object({
    tagName: GitTagNameSchema,
    /** Required unless the tag already exists. */
    target: TagTargetSchema.optional(),
    source: GitBranchSchema.optional(),
    title: releaseTitle.default(""),
    body: releaseBody.default(""),
    draft: z.boolean().default(false),
    prerelease: z.boolean().default(false),
  })
  .strict();
export type CreateReleaseInput = z.infer<typeof CreateReleaseInputSchema>;

export const UpdateReleaseInputSchema = z
  .object({
    title: releaseTitle.optional(),
    body: releaseBody.optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export type UpdateReleaseInput = z.infer<typeof UpdateReleaseInputSchema>;

/** Asset file names: no path separators or control characters. */
export const ReleaseAssetNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value !== "." && value !== ".." && !/[\\/\x00-\x1f\x7f]/.test(value) && value.trim() === value
  );

export interface ReleaseAsset {
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploader: string;
  createdAt: number;
}

export interface Release {
  id: string;
  tagName: string;
  title: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  /** Branch or commit the tag was created from, null when the tag already existed. */
  target: string | null;
  author: string;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  assets: ReleaseAsset[];
}

export const ReleaseEventTypes = [
  "release.published",
  "release.updated",
  "release.deleted",
] as const;
export type ReleaseEventType = (typeof ReleaseEventTypes)[number];

/** Event emitted after a release changes; a future webhook dispatcher subscribes to it. */
export interface ReleaseEvent {
  type: ReleaseEventType;
  repositoryId: string;
  releaseId: string;
  tagName: string;
  draft: boolean;
  prerelease: boolean;
  actor: Actor;
  occurredAt: number;
}
export type ReleaseEventHandler = (event: ReleaseEvent) => Promise<void>;

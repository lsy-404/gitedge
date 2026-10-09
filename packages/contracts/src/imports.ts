import { z } from "zod";
import { RepositorySlugSchema } from "./repository-controls";

export const REPOSITORY_IMPORT_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export const RepositoryImportStatusSchema = z.enum(REPOSITORY_IMPORT_STATUSES);
export type RepositoryImportStatus = z.infer<typeof RepositoryImportStatusSchema>;

export const REPOSITORY_IMPORT_ERROR_CODES = [
  "invalid_url",
  "remote_auth_required",
  "remote_not_found",
  "upstream_unavailable",
  "size_limit",
  "name_taken",
  "timed_out",
  "import_failed",
] as const;
export type RepositoryImportErrorCode = (typeof REPOSITORY_IMPORT_ERROR_CODES)[number];

export const CreateRepositoryImportInputSchema = z.object({
  sourceUrl: z.string().trim().min(1).max(2048),
  owner: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  slug: RepositorySlugSchema,
  visibility: z.enum(["public", "private"]),
  description: z.string().trim().max(500).default(""),
});
export type CreateRepositoryImportInput = z.input<typeof CreateRepositoryImportInputSchema>;

export interface RepositoryImport {
  readonly id: string;
  readonly owner: string;
  readonly slug: string;
  readonly visibility: "public" | "private";
  readonly description: string;
  readonly sourceUrl: string;
  readonly status: RepositoryImportStatus;
  readonly progress: string;
  readonly errorCode: RepositoryImportErrorCode | null;
  readonly error: string | null;
  readonly attempt: number;
  readonly repositoryId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
}

export const GitImportInputSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  sourceUrl: z.string().min(1).max(2048),
  description: z.string().max(500),
});

export const GitImportResultSchema = z.object({
  name: z.string().min(1),
  remote: z.string().min(1),
  defaultBranch: z.string().min(1),
});
export type GitImportResult = z.infer<typeof GitImportResultSchema>;

/** Running jobs idle longer than this are treated as lost and become retryable. */
export const REPOSITORY_IMPORT_STALE_MS = 10 * 60 * 1000;

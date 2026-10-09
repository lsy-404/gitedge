import { z } from "zod";

/** Soft-deleted repositories stay restorable for this long before the purge job removes them. */
export const REPOSITORY_RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const ConfirmationInputSchema = z.object({ confirm: z.string().min(1).max(200) });
export type ConfirmationInput = z.infer<typeof ConfirmationInputSchema>;

/** Internal Forge to Git purge step: deletes session forks after `after`, then the repository. */
export const RepositoryPurgeRequestSchema = z.object({
  repositoryId: z.string().min(1),
  after: z.string().min(1).nullable(),
});
export type RepositoryPurgeRequest = z.infer<typeof RepositoryPurgeRequestSchema>;
export const RepositoryPurgeResultSchema = z.object({
  complete: z.boolean(),
  next: z.string().min(1).nullable(),
});
export type RepositoryPurgeResult = z.infer<typeof RepositoryPurgeResultSchema>;

export interface DeletedRepository {
  id: string;
  owner: string;
  name: string;
  deletedAt: number;
  purgeAfter: number;
  deletedBy: string | null;
  /** True once the purge job has begun and the repository can no longer be restored. */
  purging: boolean;
}

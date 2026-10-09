import { z } from "zod";

/** Soft-deleted repositories stay restorable for this long before the purge job removes them. */
export const REPOSITORY_RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const ConfirmationInputSchema = z.object({ confirm: z.string().min(1).max(200) });
export type ConfirmationInput = z.infer<typeof ConfirmationInputSchema>;

export const TransferRepositoryInputSchema = ConfirmationInputSchema.extend({
  owner: z.string().trim().toLowerCase().min(1).max(63),
});
export type TransferRepositoryInput = z.infer<typeof TransferRepositoryInputSchema>;

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

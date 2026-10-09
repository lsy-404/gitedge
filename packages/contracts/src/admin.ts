import { z } from "zod";

export const ADMIN_PAGE_SIZE = 50;

export const UpdateAdminUserSchema = z
  .object({
    groupKey: z.string().trim().min(1).max(64).optional(),
    siteAdmin: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.groupKey !== undefined || value.siteAdmin !== undefined);
export type UpdateAdminUserInput = z.infer<typeof UpdateAdminUserSchema>;

export interface AdminUser {
  id: string;
  identifier: string;
  groupKey: string;
  createdAt: number;
  disabledAt: number | null;
  deletedAt: number | null;
  /** Stored flag; configured administrators are always administrators in addition. */
  siteAdmin: boolean;
  configuredAdmin: boolean;
}

export interface AdminRepository {
  id: string;
  owner: string;
  name: string;
  visibility: "public" | "private";
  archived: boolean;
  createdBy: string;
  createdAt: number;
  deletedAt: number | null;
}

export interface AdminGroup {
  key: string;
  rpm: number;
  maxRepositories: number;
}

export interface AdminStats {
  users: { total: number; disabled: number; deleted: number };
  organizations: number;
  repositories: { public: number; private: number; deleted: number };
  pendingInvitations: number;
  auditEventsLast24Hours: number;
}

export interface AdminPage<T> {
  items: T[];
  nextCursor: string | null;
}

export const AccountDeletionInputSchema = z
  .object({ confirm: z.string().min(1).max(100) })
  .strict();

/** Sections of the account export; a truncated section lists the rows beyond the cap. */
export const ACCOUNT_EXPORT_SECTION_LIMIT = 2000;

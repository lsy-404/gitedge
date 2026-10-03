import { z } from "zod";
import { GitBranchSchema, GitOidSchema } from "./forge";

export const RepositorySlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.-]+$/)
  .refine(
    (value) => value !== "." && value !== ".." && !value.endsWith(".git") && !value.endsWith("."),
    "Invalid repository name"
  );
export const BranchProtectionInputSchema = z.object({
  pattern: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_./*?-]+$/)
    .refine((value) => !value.includes("..") && !value.startsWith("/")),
  enabled: z.boolean().default(true),
  locked: z.boolean().default(false),
  requiredApprovals: z.number().int().min(0).max(5).default(0),
  requirePassingChecks: z.boolean().default(false),
  requiredStatusChecks: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  requireLinearHistory: z.boolean().default(false),
  requireSignedCommits: z.boolean().default(false),
});
export type BranchProtectionInput = z.infer<typeof BranchProtectionInputSchema>;
export interface BranchProtectionRule extends BranchProtectionInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}
export const RepositoryRoleSchema = z.enum(["read", "write", "admin"]);
export type RepositoryRole = z.infer<typeof RepositoryRoleSchema>;
export interface RepositoryCollaborator {
  id: string;
  identifier: string;
  role: RepositoryRole;
  inherited: boolean;
}
export const PutRepositoryCollaboratorSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(3).max(63),
  role: RepositoryRoleSchema,
});
export const EditRepositoryFileSchema = z.object({
  branch: GitBranchSchema,
  newBranch: GitBranchSchema.optional(),
  expectedOid: GitOidSchema.nullable(),
  path: z.string().min(1).max(1000),
  content: z.string().max(1_000_000).nullable(),
  message: z.string().trim().min(1).max(500),
});
export type EditRepositoryFileInput = z.infer<typeof EditRepositoryFileSchema>;
export const CreateBranchInputSchema = z.object({
  name: GitBranchSchema,
  source: GitBranchSchema,
  expectedOid: GitOidSchema,
});
export const DeleteBranchInputSchema = z.object({
  name: GitBranchSchema,
  expectedOid: GitOidSchema,
});
export interface RepositoryBranch {
  name: string;
  oid: string;
  protected: boolean;
  rules: string[];
  isDefault: boolean;
}
export interface RepositorySnapshotFile {
  path: string;
  contentBase64: string;
  mode: string;
}
export interface RepositorySnapshot {
  oid: string;
  files: RepositorySnapshotFile[];
  totalBytes: number;
}
export interface RepositoryCommunityFile {
  kind: string;
  title: string;
  repositoryId: string;
  owner: string;
  repository: string;
  path: string;
  inherited: boolean;
  truncated: boolean;
  content: string;
  truncated: boolean;
}
export interface RepositoryCommunity {
  truncated: boolean;
  files: RepositoryCommunityFile[];
  issueTemplates: RepositoryCommunityFile[];
  pullRequestTemplate: RepositoryCommunityFile | null;
  truncated: boolean;
}

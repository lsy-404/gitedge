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
    .refine((value) => GitBranchSchema.safeParse(value.replace(/[*?]/g, "x")).success),
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
export const REPOSITORY_COMMIT_LIMITS = {
  changes: 100,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
  manifestBytes: 256 * 1024,
} as const;
export function editablePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1000 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    path
      .split("/")
      .every(
        (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"
      ) &&
    path.split("/").length <= 32
  );
}
const EditablePathSchema = z.string().refine(editablePath, "Invalid repository path");
export const RepositoryChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("put"), path: EditablePathSchema, part: z.string().min(1).max(64) }),
  z.object({ op: z.literal("delete"), path: EditablePathSchema }),
  z.object({ op: z.literal("move"), from: EditablePathSchema, to: EditablePathSchema }),
]);
export type RepositoryChangeInput = z.infer<typeof RepositoryChangeSchema>;
function touchedPaths(change: RepositoryChangeInput): string[] {
  return change.op === "move" ? [change.from, change.to] : [change.path];
}
function nested(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}
/** True when two changes touch the same path or one path contains another, which makes order matter. */
export function repositoryChangesOverlap(changes: readonly RepositoryChangeInput[]): boolean {
  const owned = changes.flatMap((change, index) =>
    touchedPaths(change).map((path) => ({ path, index }))
  );
  return owned.some((a, i) =>
    owned.some((b, j) => i < j && (nested(a.path, b.path) || nested(b.path, a.path)))
  );
}
export const CommitRepositoryChangesSchema = z
  .object({
    branch: GitBranchSchema,
    newBranch: GitBranchSchema.optional(),
    expectedOid: GitOidSchema.nullable(),
    message: z.string().trim().min(1).max(500),
    changes: z.array(RepositoryChangeSchema).min(1).max(REPOSITORY_COMMIT_LIMITS.changes),
  })
  .refine((value) => !repositoryChangesOverlap(value.changes), "Changes must not overlap")
  .refine(
    (value) =>
      value.changes.every((change) => change.op !== "move" || !nested(change.from, change.to)),
    "A path cannot move into itself"
  )
  .refine((value) => {
    const parts = value.changes.flatMap((change) => (change.op === "put" ? [change.part] : []));
    return new Set(parts).size === parts.length;
  }, "File parts must be unique");
export type CommitRepositoryChangesInput = z.infer<typeof CommitRepositoryChangesSchema>;
export interface CommitRepositoryChangesResult {
  oid: string;
  branch: string;
}
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
  ref: string;
  path: string;
  inherited: boolean;
  truncated: boolean;
  content: string;
}
export interface RepositoryCommunity {
  truncated: boolean;
  files: RepositoryCommunityFile[];
  issueTemplates: RepositoryCommunityFile[];
  pullRequestTemplate: RepositoryCommunityFile | null;
}

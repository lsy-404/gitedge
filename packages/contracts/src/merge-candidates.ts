import { z } from "zod";
import { GitOidSchema } from "./forge";

export const MergeCandidateSchema = z.object({
  id: z.string(),
  baseOid: GitOidSchema,
  headOid: GitOidSchema,
  resultOid: GitOidSchema.nullable(),
  method: z.enum(["merge", "squash", "rebase"]),
  createdAt: z.number(),
  status: z.enum(["preparing", "running", "passed", "failed"]),
  checks: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })
  ),
});
export type MergeCandidate = z.infer<typeof MergeCandidateSchema>;

export interface MergeCandidateRecord {
  id: string;
  pull_request_id: string;
  repository_id: string;
  base_oid: string;
  head_oid: string;
  result_oid: string | null;
  expected_workflows: string;
  method: "merge" | "squash" | "rebase";
  source_ref: string;
  created_at: number;
  queue_entered_at: number;
  author_name: string;
  author_email: string;
  message: string;
}

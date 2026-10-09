import { z } from "zod";
import { GitBranchSchema } from "./forge";
import { RepositorySlugSchema } from "./repository-controls";

export const MAX_REPOSITORY_TOPICS = 20;
export const RepositoryTopicSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,34}$/);
export const SetRepositoryTopicsInputSchema = z
  .object({
    topics: z
      .array(RepositoryTopicSchema)
      .max(MAX_REPOSITORY_TOPICS)
      .transform((topics) => [...new Set(topics)].sort()),
  })
  .strict();
export type SetRepositoryTopicsInput = z.infer<typeof SetRepositoryTopicsInputSchema>;

export const WatchLevels = ["participating", "all", "ignore"] as const;
export const WatchLevelSchema = z.enum(WatchLevels);
export type WatchLevel = z.infer<typeof WatchLevelSchema>;
export const SetWatchInputSchema = z.object({ level: WatchLevelSchema }).strict();

export const ForkRepositoryInputSchema = z
  .object({
    owner: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .optional(),
    name: RepositorySlugSchema.optional(),
  })
  .strict();
export type ForkRepositoryInput = z.infer<typeof ForkRepositoryInputSchema>;

export const ForkSyncInputSchema = z.object({ branch: GitBranchSchema }).strict();
export type ForkSyncInput = z.infer<typeof ForkSyncInputSchema>;
export interface ForkSyncResult {
  status: "up_to_date" | "fast_forwarded";
  branch: string;
  oid: string;
}

export const EXPLORE_PAGE_SIZE = 20;
export const EXPLORE_MAX_PAGE_SIZE = 50;
export const ExploreSorts = ["updated", "stars"] as const;
export const ExploreQuerySchema = z.object({
  sort: z.enum(ExploreSorts).default("updated"),
  q: z.string().trim().min(1).max(100).optional(),
  topic: RepositoryTopicSchema.optional(),
  limit: z.coerce.number().int().min(1).max(EXPLORE_MAX_PAGE_SIZE).default(EXPLORE_PAGE_SIZE),
  cursor: z
    .string()
    .regex(/^\d{1,16}(?::\d{1,16})?:[A-Za-z0-9-]{1,64}$/)
    .optional(),
});
export type ExploreQuery = z.infer<typeof ExploreQuerySchema>;

export interface RepositoryForkOrigin {
  id: string;
  owner: string;
  name: string;
}
export interface ExploreRepository {
  id: string;
  owner: string;
  name: string;
  description: string;
  topics: string[];
  starCount: number;
  updatedAt: number;
  forkOf: RepositoryForkOrigin | null;
}
export interface ExplorePage {
  items: ExploreRepository[];
  nextCursor: string | null;
}
export interface ExploreTopic {
  topic: string;
  repositories: number;
}

/** The viewer's relationship to a repository plus its public counters. */
export interface RepositorySocial {
  starCount: number;
  starred: boolean;
  watchLevel: WatchLevel;
  forkCount: number;
}
export interface StarredPage {
  items: ExploreRepository[];
  nextCursor: string | null;
}

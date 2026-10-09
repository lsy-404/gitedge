import { z } from "zod";
import { GitBranchSchema, RepositoryForkOriginSchema } from "./forge";
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
export const ForkSyncResultSchema = z.object({
  status: z.enum(["up_to_date", "fast_forwarded"]),
  branch: z.string(),
  oid: z.string(),
});
export type ForkSyncResult = z.infer<typeof ForkSyncResultSchema>;

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

export const ExploreRepositorySchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  description: z.string(),
  topics: z.array(z.string()),
  starCount: z.number(),
  updatedAt: z.number(),
  forkOf: RepositoryForkOriginSchema.nullable(),
});
export type ExploreRepository = z.infer<typeof ExploreRepositorySchema>;
export const ExplorePageSchema = z.object({
  items: z.array(ExploreRepositorySchema),
  nextCursor: z.string().nullable(),
});
export type ExplorePage = z.infer<typeof ExplorePageSchema>;
export const ExploreTopicSchema = z.object({ topic: z.string(), repositories: z.number() });
export type ExploreTopic = z.infer<typeof ExploreTopicSchema>;

export const RepositorySocialSchema = z
  .object({
    starCount: z.number(),
    starred: z.boolean(),
    watchLevel: WatchLevelSchema,
    forkCount: z.number(),
  })
  .describe("The viewer's relationship to a repository plus its public counters.");
export type RepositorySocial = z.infer<typeof RepositorySocialSchema>;
export const StarredPageSchema = ExplorePageSchema;
export type StarredPage = ExplorePage;
export const RepositoryTopicsSchema = z.object({ topics: z.array(z.string()) });

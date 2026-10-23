import { z } from "zod";
import { ExploreRepositorySchema } from "./social";
import { RepositorySchema } from "./forge";

export const ProfileActivitySchema = z.object({
  kind: z.enum(["issue", "pull_request", "comment"]),
  targetKind: z.enum(["issue", "pull_request", "discussion"]),
  number: z.number().int().positive(),
  title: z.string(),
  owner: z.string(),
  repository: z.string(),
  createdAt: z.number(),
});
export type ProfileActivity = z.infer<typeof ProfileActivitySchema>;

export const PublicProfileSchema = z.object({
  owner: z.string(),
  displayName: z.string(),
  bio: z.string(),
  location: z.string(),
  website: z.string(),
  avatarUrl: z.string().nullable(),
  joinedAt: z.number().nullable().describe("Unix epoch timestamp in milliseconds."),
  readme: z.object({ content: z.string(), repositoryId: z.string(), path: z.string() }).nullable(),
  repositories: z.array(RepositorySchema),
  starredRepositories: z.array(ExploreRepositorySchema),
  starredTruncated: z.boolean(),
  activity: z.array(ProfileActivitySchema),
  truncated: z.boolean(),
});
export type PublicProfile = z.infer<typeof PublicProfileSchema>;

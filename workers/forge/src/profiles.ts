import {
  NamespaceSlugSchema,
  trustedHeaders,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import type { ProfileActivity, PublicProfile } from "../../../packages/contracts/src/profiles";
import { readTextLimited } from "../../../src/worker/common/readText";
import { repositorySocialFields } from "./social";
import { repoResponse, type ForgeEnv, type RepositoryRow } from "./common";
import { z } from "zod";
import { createLogger } from "../../../src/worker/common/logger";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
export async function publicProfile(
  env: ForgeEnv,
  request: Request,
  owner: string,
  user: TrustedUser | null
): Promise<Response> {
  const parsed = NamespaceSlugSchema.safeParse(owner);
  if (!parsed.success) return errorResponse(404, "not_found", "Profile was not found.");
  const profile = await env.DB.prepare(
    "SELECT n.slug AS owner,COALESCE(p.display_name,n.display_name,n.slug) AS displayName,COALESCE(p.bio,n.description,'') AS bio,COALESCE(p.location,'') AS location,COALESCE(p.website,'') AS website,u.id AS userId,u.created_at AS joinedAt,ei.avatar_url AS avatarUrl FROM namespaces n LEFT JOIN users u ON n.kind='personal' AND u.id=n.created_by LEFT JOIN auth_account_profiles p ON p.user_id=u.id LEFT JOIN external_identities ei ON ei.user_id=u.id AND ei.provider='github' WHERE n.slug=? AND (u.id IS NULL OR (u.deleted_at IS NULL AND u.disabled_at IS NULL))"
  )
    .bind(parsed.data)
    .first<{
      owner: string;
      displayName: string;
      bio: string;
      location: string;
      website: string;
      userId: string | null;
      joinedAt: number | null;
      avatarUrl: string | null;
    }>();
  if (!profile) return errorResponse(404, "not_found", "Profile was not found.");
  const repos = await env.DB.prepare(
    "SELECT r.*,n.slug AS owner FROM repositories r JOIN namespaces n ON n.id=r.namespace_id WHERE n.slug=? AND r.deleted_at IS NULL AND r.system_kind IS NULL AND r.visibility='public' AND r.artifact_name IS NOT NULL ORDER BY r.updated_at DESC LIMIT 101"
  )
    .bind(profile.owner)
    .all<RepositoryRow>();
  const sameName = await env.DB.prepare(
    "SELECT r.*,n.slug AS owner FROM repositories r JOIN namespaces n ON n.id=r.namespace_id WHERE n.slug=? AND r.slug=? AND r.deleted_at IS NULL AND r.system_kind IS NULL AND r.visibility='public' AND r.artifact_name IS NOT NULL"
  )
    .bind(profile.owner, profile.owner)
    .first<RepositoryRow>();
  let readme: { content: string; repositoryId: string; path: string } | null = null;
  if (sameName) {
    const url = new URL(`/repositories/${sameName.id}/file`, request.url);
    url.searchParams.set("ref", sameName.default_branch ?? "main");
    url.searchParams.set("path", "README.md");
    const response = await env.GIT.fetch(
      new Request(url, { headers: trustedHeaders(user ?? undefined) })
    );
    const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
    if (response.ok) {
      const text = await readTextLimited(response.body, 1_100_000);
      if (text) {
        let data: unknown = null;
        try {
          data = JSON.parse(text);
        } catch {
          logger.warn("forge:profile-readme-parse-failed", { repositoryId: sameName.id });
        }
        const file = z
          .object({ data: z.object({ content: z.string().nullable(), binary: z.boolean() }) })
          .safeParse(data);
        if (file.success && !file.data.data.binary && file.data.data.content?.trim())
          readme = {
            content: file.data.data.content,
            repositoryId: sameName.id,
            path: "README.md",
          };
      }
    } else {
      logger.warn("forge:profile-readme-unavailable", {
        repositoryId: sameName.id,
        status: response.status,
      });
      await response.body?.cancel();
    }
  }
  const social = await repositorySocialFields(env, repos.results.slice(0, 100), user?.id ?? null);
  let starredRepositories: RepositoryRow[] = [];
  let starredTruncated = false;
  if (profile.userId) {
    const starred = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner FROM repository_stars s JOIN repositories r ON r.id=s.repository_id JOIN namespaces n ON n.id=r.namespace_id WHERE s.user_id=? AND r.deleted_at IS NULL AND r.system_kind IS NULL AND r.visibility='public' AND r.artifact_name IS NOT NULL ORDER BY s.created_at DESC,r.id LIMIT 101"
    )
      .bind(profile.userId)
      .all<RepositoryRow>();
    starredRepositories = starred.results;
    starredTruncated = starred.results.length > 100;
  }
  let activity: ProfileActivity[] = [];
  if (profile.userId) {
    const activityPage = await env.DB.prepare(
      "SELECT * FROM (SELECT 'issue' AS kind,'issue' AS targetKind,i.number,i.title,n.slug AS owner,r.slug AS repository,i.created_at AS createdAt FROM forge_issues i JOIN repositories r ON r.id=i.repository_id JOIN namespaces n ON n.id=r.namespace_id WHERE i.author_id=? AND COALESCE(json_extract(i.actor_json,'$.kind'),'user')='user' AND r.deleted_at IS NULL AND r.system_kind IS NULL AND r.visibility='public' AND r.artifact_name IS NOT NULL UNION ALL SELECT 'pull_request','pull_request',p.number,p.title,n.slug,r.slug,p.created_at FROM forge_pull_requests p JOIN repositories r ON r.id=p.repository_id JOIN namespaces n ON n.id=r.namespace_id WHERE p.author_id=? AND COALESCE(json_extract(p.actor_json,'$.kind'),'user')='user' AND r.deleted_at IS NULL AND r.system_kind IS NULL AND r.visibility='public' AND r.artifact_name IS NOT NULL UNION ALL SELECT 'comment',c.target_kind,COALESCE(i.number,p.number,d.number),COALESCE(i.title,p.title,d.title),n.slug,r.slug,c.created_at FROM forge_comments c JOIN repositories r ON r.id=c.repository_id JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN forge_issues i ON c.target_kind='issue' AND i.id=c.target_id AND i.repository_id=c.repository_id LEFT JOIN forge_pull_requests p ON c.target_kind='pull_request' AND p.id=c.target_id AND p.repository_id=c.repository_id LEFT JOIN forge_discussions d ON c.target_kind='discussion' AND d.id=c.target_id AND d.repository_id=c.repository_id WHERE c.author_id=? AND COALESCE(json_extract(c.actor_json,'$.kind'),'user')='user' AND r.deleted_at IS NULL AND r.system_kind IS NULL AND r.visibility='public' AND r.artifact_name IS NOT NULL AND COALESCE(i.id,p.id,d.id) IS NOT NULL) ORDER BY createdAt DESC,repository,number DESC LIMIT 30"
    )
      .bind(profile.userId, profile.userId, profile.userId)
      .all<ProfileActivity>();
    activity = activityPage.results;
  }
  const starredSocial = await repositorySocialFields(env, starredRepositories.slice(0, 100), null);
  const { userId, ...publicProfile } = profile;
  const payload: PublicProfile = {
    ...publicProfile,
    readme,
    repositories: repos.results
      .slice(0, 100)
      .map((repo) => repoResponse(repo, null, false, social.get(repo.id))),
    starredRepositories: starredRepositories
      .slice(0, 100)
      .map((repo) => repoResponse(repo, null, false, starredSocial.get(repo.id))),
    starredTruncated,
    activity,
    truncated: repos.results.length > 100,
  };
  return dataResponse(payload);
}

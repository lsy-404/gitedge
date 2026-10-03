import {
  NamespaceSlugSchema,
  trustedHeaders,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { readTextLimited } from "../../../src/worker/common/readText";
import { json, error, repoResponse, type ForgeEnv, type RepositoryRow } from "./common";
import { z } from "zod";
export async function publicProfile(
  env: ForgeEnv,
  request: Request,
  owner: string,
  user: TrustedUser | null
): Promise<Response> {
  const parsed = NamespaceSlugSchema.safeParse(owner);
  if (!parsed.success) return error(404, "not_found", "Profile was not found.");
  const profile = await env.DB.prepare(
    "SELECT n.slug AS owner,COALESCE(p.display_name,n.display_name,n.slug) AS displayName,COALESCE(p.bio,n.description,'') AS bio,COALESCE(p.location,'') AS location,COALESCE(p.website,'') AS website FROM namespaces n LEFT JOIN users u ON n.kind='personal' AND u.id=n.created_by LEFT JOIN auth_account_profiles p ON p.user_id=u.id WHERE n.slug=?"
  )
    .bind(parsed.data)
    .first<{
      owner: string;
      displayName: string;
      bio: string;
      location: string;
      website: string;
    }>();
  if (!profile) return error(404, "not_found", "Profile was not found.");
  const repos = await env.DB.prepare(
    "SELECT r.*,n.slug AS owner FROM repositories r JOIN namespaces n ON n.id=r.namespace_id WHERE n.slug=? AND r.visibility='public' AND r.artifact_name IS NOT NULL ORDER BY r.updated_at DESC LIMIT 101"
  )
    .bind(profile.owner)
    .all<RepositoryRow>();
  const sameName = await env.DB.prepare(
    "SELECT r.*,n.slug AS owner FROM repositories r JOIN namespaces n ON n.id=r.namespace_id WHERE n.slug=? AND r.slug=? AND r.visibility='public' AND r.artifact_name IS NOT NULL"
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
    if (response.ok) {
      const text = await readTextLimited(response.body, 1_100_000);
      if (text) {
        let data: unknown = null;
        try {
          data = JSON.parse(text);
        } catch {}
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
    } else await response.body?.cancel();
  }
  return json({
    data: {
      ...profile,
      readme,
      repositories: repos.results.slice(0, 100).map((repo) => repoResponse(repo, false)),
      truncated: repos.results.length > 100,
    },
  });
}

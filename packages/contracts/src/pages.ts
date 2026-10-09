import { z } from "zod";
import { GitBranchSchema, type CheckRun } from "./forge";
import { editablePath } from "./repository-controls";

export const PAGES_CHECK_NAME = "GitEdge Pages preview";
export const PAGES_CHECK_ACTOR_KEY = "ci:gitedge-pages";
export const PAGES_CHECK_ACTOR = {
  kind: "ci",
  id: "gitedge-pages",
  name: "GitEdge Pages",
} as const;
/** True only for the system preview check; members cannot post checks under the Pages actor. */
export function isPagesPreviewCheck(check: Pick<CheckRun, "name" | "actor">): boolean {
  return (
    check.name === PAGES_CHECK_NAME &&
    check.actor.kind === PAGES_CHECK_ACTOR.kind &&
    check.actor.id === PAGES_CHECK_ACTOR.id
  );
}
export const PAGES_SITE_MAX_BYTES = 25 * 1024 * 1024;
export const PAGES_MAX_PATH_SEGMENTS = 32;

/** `/` for the repository root, otherwise `/segment/...` without a trailing slash. */
export const PagesFolderSchema = z
  .string()
  .trim()
  .max(200)
  .transform((value) =>
    value === "" || value === "/" ? "/" : `/${value.replace(/^\/+|\/+$/g, "")}`
  )
  .refine((value) => value === "/" || editablePath(value.slice(1)), "Invalid folder");
export const PagesNotFoundPathSchema = z
  .string()
  .trim()
  .max(200)
  .refine(editablePath, "Invalid page path")
  .nullable();

export const UpdatePagesInputSchema = z
  .object({
    branch: GitBranchSchema,
    folder: PagesFolderSchema,
    notFoundPath: PagesNotFoundPathSchema,
    spaFallback: z.boolean(),
  })
  .strict();
export type UpdatePagesInput = z.infer<typeof UpdatePagesInputSchema>;

export const PagesSettingsSchema = z.object({
  branch: z.string(),
  folder: z.string(),
  notFoundPath: z.string().nullable(),
  spaFallback: z.boolean(),
  enabled: z
    .boolean()
    .describe("Mirrors the repository feature toggle; sites are only served while it is on."),
  available: z.boolean().describe("Pages serve public repositories only."),
  lastPublishedOid: z.string().nullable(),
  lastPublishedAt: z.number().nullable(),
  pathUrl: z.string().describe("Site root on the Gateway origin, always available."),
  hostUrl: z
    .string()
    .nullable()
    .describe("Absolute site root on the sites host, null when none is configured."),
  canManage: z.boolean(),
});
export type PagesSettings = z.infer<typeof PagesSettingsSchema>;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function pagesPathUrl(owner: string, repository: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/-/site/`;
}

export function pagesPreviewPath(owner: string, repository: string, oid: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/-/preview/${oid}/`;
}

/** Site root on `<owner>.<sitesHost>`, or null when no sites host is set or the owner is not a DNS label. */
export function pagesHostUrl(
  owner: string,
  repository: string,
  sitesHost: string | undefined
): string | null {
  const host = sitesHost?.trim().toLowerCase();
  if (!host || !DNS_LABEL.test(owner)) return null;
  return `https://${owner}.${host}/${encodeURIComponent(repository)}/`;
}

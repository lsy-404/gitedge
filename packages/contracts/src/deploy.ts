import { z } from "zod";

const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,23}$/);
const ResourceName = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z][a-z0-9-]{2,47}$/);
const WorkerModulePath = z
  .string()
  .regex(/^[A-Za-z0-9_./-]{1,240}\.m?js$/)
  .refine((path) => !path.includes("..") && !path.startsWith("/") && !path.startsWith("-"));
const MigrationPath = z
  .string()
  .regex(/^[A-Za-z0-9_./-]{1,240}\.sql$/)
  .refine((path) => !path.includes("..") && !path.startsWith("/") && !path.startsWith("-"));

export const DeployManifestSchema = z
  .object({
    schema: z.literal(1),
    name: z.string().trim().min(1).max(80),
    license: z.object({
      id: z.string().trim().min(1).max(80),
      text: z.string().trim().min(1).max(40_000),
    }),
    terms: z.object({ required: z.boolean(), text: z.string().max(20_000) }),
    worker: z.object({
      name: ResourceName.optional(),
      entrypoint: WorkerModulePath,
      modules: z.array(WorkerModulePath).max(32).default([]),
      compatibilityDate: z.string().regex(/^20\d\d-\d\d-\d\d$/),
      compatibilityFlags: z
        .array(z.enum(["nodejs_compat", "global_fetch_strictly_public"]))
        .max(8)
        .default([]),
      vars: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/), z.string().max(1024)).default({}),
    }),
    resources: z
      .object({
        d1: z
          .array(
            z.object({
              id: Identifier,
              binding: Identifier,
              name: ResourceName,
              migrations: z.array(MigrationPath).max(100).default([]),
            })
          )
          .max(8)
          .default([]),
        r2: z
          .array(z.object({ id: Identifier, binding: Identifier, name: ResourceName }))
          .max(8)
          .default([]),
        kv: z
          .array(z.object({ id: Identifier, binding: Identifier, name: ResourceName }))
          .max(8)
          .default([]),
      })
      .default({ d1: [], r2: [], kv: [] }),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.terms.required && !manifest.terms.text.trim())
      context.addIssue({
        code: "custom",
        path: ["terms", "text"],
        message: "Required terms must contain text.",
      });
    const resources = [
      ...manifest.resources.d1,
      ...manifest.resources.r2,
      ...manifest.resources.kv,
    ];
    const resourceIds = resources.map((resource) => resource.id);
    const bindingNames = [
      ...resources.map((resource) => resource.binding),
      ...Object.keys(manifest.worker.vars),
    ];
    if (new Set(resourceIds).size !== resourceIds.length)
      context.addIssue({
        code: "custom",
        path: ["resources"],
        message: "Resource ids must be unique.",
      });
    if (new Set(bindingNames).size !== bindingNames.length)
      context.addIssue({
        code: "custom",
        path: ["resources"],
        message: "Worker binding names must be unique.",
      });
    if (resources.length > 8)
      context.addIssue({
        code: "custom",
        path: ["resources"],
        message: "A manifest may declare at most eight resources.",
      });
    const migrationCount = manifest.resources.d1.reduce(
      (total, database) => total + database.migrations.length,
      0
    );
    if (migrationCount > 50)
      context.addIssue({
        code: "custom",
        path: ["resources", "d1"],
        message: "A manifest may declare at most 50 migrations.",
      });
    const moduleCount = new Set([manifest.worker.entrypoint, ...manifest.worker.modules]).size;
    if (moduleCount + migrationCount > 16)
      context.addIssue({
        code: "custom",
        path: ["worker", "modules"],
        message: "A manifest may declare at most 16 files across modules and migrations.",
      });
  });

export type DeployManifest = z.infer<typeof DeployManifestSchema>;

export interface DeployResourceResult {
  id: string;
  name: string;
  reused: boolean;
}

export interface DeployPlan {
  repositoryId: string;
  ref: string;
  manifestDigest: string;
  manifest: DeployManifest;
  permissions: string[];
}

export interface DeployResult {
  workerName: string;
  url: string | null;
  resources: DeployResourceResult[];
}

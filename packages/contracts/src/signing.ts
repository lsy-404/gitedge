import { z } from "zod";

export const SIGNING_MAX_ARCHIVE_BYTES = 2_000_000_000;
export const SIGNING_PART_BYTES = 8 * 1024 * 1024;

export const SigningPlatformSchema = z.enum(["windows", "macos", "ios"]);
export type SigningPlatform = z.infer<typeof SigningPlatformSchema>;
export const SigningCredentialPlatformSchema = z.enum(["windows", "macos", "ios", "github-source"]);
export type SigningCredentialPlatform = z.infer<typeof SigningCredentialPlatformSchema>;
export const SigningStageSchema = z.enum([
  "sign",
  "finalize",
  "dmg_sign",
  "dmg_finalize",
  "windows_sign",
  "ios_sign",
]);
export type SigningStage = z.infer<typeof SigningStageSchema>;

const SigningSourceRepositorySchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    workflowPath: z.string().regex(/^\.github\/workflows\/[\w.-]+\.ya?ml$/),
    releaseTagPattern: z
      .string()
      .max(100)
      .regex(/^\^.*\$$/)
      .optional(),
    artifactName: z.string().min(1).max(100),
    actorIds: z.array(z.number().int().positive()).min(1).max(32),
    events: z.array(z.string().min(1).max(64)).min(1).max(8),
    refs: z.array(z.string().min(1).max(256)).min(1).max(32),
  })
  .strict()
  .superRefine((repository, context) => {
    if (repository.releaseTagPattern) {
      try {
        new RegExp(repository.releaseTagPattern);
      } catch {
        context.addIssue({ code: "custom", message: "signing_release_tag_pattern_invalid" });
      }
    }
  });

const SigningMacosRecipeSchema = z
  .object({
    bundle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
    bundle_name: z.string().min(1).max(255),
    architecture: z.enum(["arm64", "x64", "universal"]),
    profile: z.enum(["native", "electron"]),
    harden_electron_fuses: z.boolean(),
    output_format: z.enum(["zip", "dmg"]),
    max_unpacked_bytes: z.number().int().positive().max(8_000_000_000),
  })
  .strict();

const SigningWindowsRecipeSchema = z
  .object({
    bundle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
    architecture: z.enum(["x64", "arm64"]),
    max_unpacked_bytes: z.number().int().positive().max(8_000_000_000),
    product_name: z.string().min(1).max(255),
    electron_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    executable_name: z.string().min(1).max(255),
    installer: z.enum(["nsis", "squirrel"]),
    portable: z.boolean(),
  })
  .strict();

const SigningIosRecipeSchema = z
  .object({
    bundle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
    architecture: z.literal("arm64"),
    max_unpacked_bytes: z.number().int().positive().max(8_000_000_000),
  })
  .strict();

const SigningProjectSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    enabled: z.literal(true),
    max_artifact_bytes: z.number().int().positive().max(SIGNING_MAX_ARCHIVE_BYTES),
    macos: SigningMacosRecipeSchema.optional(),
    windows: SigningWindowsRecipeSchema.optional(),
    ios: SigningIosRecipeSchema.optional(),
  })
  .strict();

export const SigningPolicySchema = z
  .object({
    stage: SigningStageSchema,
    teamId: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    windowsIdentity: z.enum(["azure-managed-identity", "azure-workload-identity"]).optional(),
    azure: z
      .object({
        endpoint: z.url().refine((value) => {
          const endpoint = new URL(value);
          return (
            endpoint.protocol === "https:" &&
            endpoint.hostname.endsWith(".codesigning.azure.net") &&
            endpoint.pathname === "/" &&
            !endpoint.search &&
            !endpoint.hash
          );
        }),
        account: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
        certificate_profile: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
        subject: z.string().min(1).max(512),
      })
      .strict()
      .optional(),
    project: SigningProjectSchema,
    sourceRepositories: z.array(SigningSourceRepositorySchema).min(1).max(16),
  })
  .strict()
  .superRefine((policy, context) => {
    const platforms = [policy.project.macos, policy.project.windows, policy.project.ios].filter(
      Boolean
    ).length;
    if (platforms !== 1)
      context.addIssue({ code: "custom", message: "signing_policy_platform_ambiguous" });
    if (policy.project.macos && (!policy.teamId || policy.stage !== "sign"))
      context.addIssue({ code: "custom", message: "signing_macos_policy_invalid" });
    if (
      policy.project.windows &&
      (!policy.azure || !policy.windowsIdentity || policy.stage !== "windows_sign")
    )
      context.addIssue({ code: "custom", message: "signing_windows_policy_invalid" });
    if (policy.project.ios && (!policy.teamId || policy.stage !== "ios_sign"))
      context.addIssue({ code: "custom", message: "signing_ios_policy_invalid" });
  });
export type SigningPolicy = z.infer<typeof SigningPolicySchema>;

export const SigningProfileSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    workflowOid: z.string().regex(/^[0-9a-f]{40}$/),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
    workflowSource: z.string().min(1).max(65_536),
    platform: SigningPlatformSchema,
    timeoutMinutes: z.number().int().min(1).max(360),
    enabled: z.boolean(),
    policy: SigningPolicySchema,
  })
  .strict();
export type SigningProfile = z.infer<typeof SigningProfileSchema>;

export const SigningProfileMetadataSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    platform: SigningPlatformSchema,
    workflowOid: z.string().regex(/^[0-9a-f]{40}$/),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
    enabled: z.boolean(),
    approvedAt: z.number().int().positive(),
  })
  .strict();
export type SigningProfileMetadata = z.infer<typeof SigningProfileMetadataSchema>;

export const SigningCredentialStatusSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    platform: SigningCredentialPlatformSchema,
    configured: z.boolean(),
    updatedAt: z.number().int().positive().nullable(),
  })
  .strict();
export type SigningCredentialStatus = z.infer<typeof SigningCredentialStatusSchema>;
export const SigningSourceCredentialSchema = z
  .object({ token: z.string().min(1).max(512) })
  .strict();
export const SigningSubmissionSchema = z
  .object({
    profile: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    platform: SigningPlatformSchema,
    sourceRepositoryId: z.string().min(1),
    sourceCommitOid: z.string().regex(/^[0-9a-f]{40}$/),
    sourceRunId: z.string().min(1).max(128),
    sourceArtifactId: z.string().min(1).max(128),
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceSize: z.number().int().positive().max(SIGNING_MAX_ARCHIVE_BYTES),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/)
      .max(64),
  })
  .strict();
export type SigningSubmission = z.infer<typeof SigningSubmissionSchema>;

export const SigningRequestStateSchema = z.enum([
  "accepted",
  "awaiting_source",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const SigningRequestSchema = z
  .object({
    id: z.uuid(),
    repositoryId: z.string().min(1),
    ownerId: z.string().min(1),
    profile: z.string(),
    profileRevision: z.string().regex(/^[0-9a-f]{40}$/),
    platform: SigningPlatformSchema,
    stage: SigningStageSchema,
    runId: z.string().uuid().nullable(),
    state: SigningRequestStateSchema,
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceSize: z.number().int().positive(),
    outputDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    outputSize: z.number().int().positive().nullable(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    completedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type SigningRequest = z.infer<typeof SigningRequestSchema>;

export const SigningCreateResponseSchema = z.object({ request: SigningRequestSchema }).strict();
export type SigningCreateResponse = z.infer<typeof SigningCreateResponseSchema>;

export const SigningMachineContextSchema = z
  .object({
    ownerId: z.string().min(1),
    runnerId: z.string().uuid(),
    runId: z.string().uuid(),
    requestId: z.uuid(),
    leaseExpiresAt: z.number().int().positive(),
    repositoryId: z.string().min(1),
    workflowOid: z.string().regex(/^[0-9a-f]{40}$/),
    profileRevision: z.string().regex(/^[0-9a-f]{40}$/),
    platform: SigningPlatformSchema,
    stage: SigningStageSchema,
    generation: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    operatorApproval: z
      .object({
        operatorApproved: z.literal(true),
        approvedBy: z.string().min(1),
        approvedAt: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type SigningMachineContext = z.infer<typeof SigningMachineContextSchema>;

export const SigningHostApprovalSchema = z
  .object({
    operatorApproved: z.literal(true),
    approvedBy: z.string().min(1),
    approvedAt: z.number().int().positive(),
  })
  .strict();
export const SigningStoredProfileSchema = SigningProfileSchema.extend({
  operatorApproval: SigningHostApprovalSchema,
}).strict();
export const SigningCreateInputSchema = z
  .object({
    requestId: z.uuid(),
    ownerId: z.string().min(1),
    repositoryId: z.string().min(1),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_.-]{16,128}$/),
    profile: SigningProfileSchema,
    submission: SigningSubmissionSchema,
    generation: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    operatorApproval: SigningHostApprovalSchema,
  })
  .strict();
export type SigningCreateInput = z.infer<typeof SigningCreateInputSchema>;

export const SigningReconcileDispatchSchema = z
  .object({
    profile: SigningProfileSchema,
    submission: SigningSubmissionSchema,
    generation: z.number().int().positive(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    operatorApproval: SigningHostApprovalSchema,
    stage: SigningStageSchema,
    inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    inputSize: z.number().int().positive().max(SIGNING_MAX_ARCHIVE_BYTES),
    previousVerification: z.unknown().nullable(),
  })
  .strict();
export type SigningReconcileDispatch = z.infer<typeof SigningReconcileDispatchSchema>;

import { z } from "zod";

export const SIGNING_MAX_ARCHIVE_BYTES = 2_000_000_000;
export const SIGNING_PART_BYTES = 8 * 1024 * 1024;

export const SigningPlatformSchema = z.enum(["windows", "macos", "ios"]);
export type SigningPlatform = z.infer<typeof SigningPlatformSchema>;
export const SigningStageSchema = z.enum(["sign", "finalize", "dmg_sign", "dmg_finalize", "windows_sign", "ios_sign"]);
export type SigningStage = z.infer<typeof SigningStageSchema>;

export const SigningProfileSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  workflowOid: z.string().regex(/^[0-9a-f]{40}$/),
  workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
  workflowSource: z.string().min(1).max(65_536),
  platform: SigningPlatformSchema,
  timeoutMinutes: z.number().int().min(1).max(360),
  enabled: z.boolean(),
  policy: z.record(z.string(), z.unknown()),
}).strict();
export type SigningProfile = z.infer<typeof SigningProfileSchema>;
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
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).max(64),
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
    outputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    outputSize: z.number().int().positive().nullable(),
    createdAt: z.number().int().nonnegative(),
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
    operatorApproval: z.object({
      operatorApproved: z.literal(true),
      approvedBy: z.string().min(1),
      approvedAt: z.number().int().positive(),
    }).strict(),
  })
  .strict();
export type SigningMachineContext = z.infer<typeof SigningMachineContextSchema>;

export const SigningHostApprovalSchema = z.object({
  operatorApproved: z.literal(true),
  approvedBy: z.string().min(1),
  approvedAt: z.number().int().positive(),
}).strict();

export const SigningReconcileDispatchSchema = z.object({
  profile: SigningProfileSchema,
  submission: SigningSubmissionSchema,
  generation: z.number().int().positive(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  operatorApproval: SigningHostApprovalSchema,
  stage: SigningStageSchema,
  inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  inputSize: z.number().int().positive().max(SIGNING_MAX_ARCHIVE_BYTES),
}).strict();
export type SigningReconcileDispatch = z.infer<typeof SigningReconcileDispatchSchema>;

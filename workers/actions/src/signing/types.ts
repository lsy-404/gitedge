import type {
  SigningMachineContext,
  SigningPlatform,
  SigningProfile,
  SigningRequest,
  SigningStage,
  SigningSubmission,
} from "../../../../packages/contracts/src/signing";
import type { TrustedUser } from "../../../../packages/contracts/src/index";

export interface SigningEnv {
  readonly DB: D1Database;
  readonly FORGE: Fetcher;
  readonly SIGNING_COORDINATORS: DurableObjectNamespace<import("./coordinator").SigningCoordinator>;
  readonly SIGNING_ARTIFACTS: R2Bucket;
  readonly SIGNING_ENCRYPTION_KEY: string;
}

export type ApprovedSigningProfile = SigningProfile;

export interface SigningQueueInput {
  readonly requestId: string;
  readonly ownerId: string;
  readonly repositoryId: string;
  readonly workflowOid: string;
  readonly workflowPath: string;
  readonly workflowSource: string;
  readonly stage: SigningStage;
  readonly inputDigest: string;
  readonly platform: SigningPlatform;
  readonly generation: number;
  readonly nonce: string;
  readonly timeoutMinutes: number;
  readonly sourceDigest: string;
  readonly profileRevision: string;
  readonly operatorApproval: SigningHostApproval;
}

export interface SigningHostApproval {
  readonly operatorApproved: true;
  readonly approvedBy: string;
  readonly approvedAt: number;
}

export interface SigningExecutionHooks {
  loadApprovedProfile(
    user: TrustedUser,
    repositoryId: string,
    name: string
  ): Promise<ApprovedSigningProfile | null>;
  verifySource(
    user: TrustedUser,
    repositoryId: string,
    profile: ApprovedSigningProfile,
    input: SigningSubmission,
    runIdentity?: string | null,
    audience?: string
  ): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  enqueue(input: SigningQueueInput): Promise<{ runId: string }>;
  verifySigningHost(
    ownerId: string,
    repositoryId: string,
    platform: SigningPlatform
  ): Promise<SigningHostApproval | null>;
  verifyNotarization(
    ownerId: string,
    repositoryId: string,
    profile: ApprovedSigningProfile,
    report: unknown
  ): Promise<"Accepted" | "In Progress" | "Invalid" | "Rejected">;
  authorizeCredentials(
    context: SigningMachineContext,
    profile: ApprovedSigningProfile
  ): Promise<{ credentials: Record<string, unknown>; expiresAt: number } | null>;
  verifyOutput(input: {
    context: SigningMachineContext;
    profile: ApprovedSigningProfile;
    platform: SigningPlatform;
    sourceDigest: string;
    sourceCommitOid: string;
    version: string;
    outputDigest: string;
    outputSize: number;
    report: unknown;
  }): Promise<boolean>;
}

export interface SigningStoredRequest extends SigningRequest {
  readonly input: SigningSubmission;
  readonly workflowPath: string;
  readonly workflowSource: string;
  readonly workflowOid: string;
  readonly generation: number;
  readonly nonce: string;
  readonly operatorApproval: SigningHostApproval;
}

import type {
  RegisteredRunner,
  SigningRunnerApproval,
} from "../../../../packages/contracts/src/runners";
import type {
  SigningCredentialStatus,
  SigningCredentialPlatform,
  SigningProfileMetadata,
} from "../../../../packages/contracts/src/signing";
import { api } from "./api";

export async function approveRunnerSigning(
  runnerId: string,
  approval: SigningRunnerApproval
): Promise<RegisteredRunner> {
  const result = await api.approveRunnerSigning(runnerId, approval);
  if (!result.runner) throw new Error("Runner approval response was incomplete.");
  return result.runner;
}

export async function revokeRunnerSigning(runnerId: string): Promise<void> {
  await api.revokeRunnerSigning(runnerId);
}

export async function listSigningProfiles(repositoryId: string): Promise<SigningProfileMetadata[]> {
  return (await api.signingProfiles(repositoryId)).profiles;
}

export async function approveSigningProfile(repositoryId: string, name: string): Promise<void> {
  await api.approveSigningProfile(repositoryId, name);
}

export async function getSigningCredentialStatus(
  repositoryId: string,
  name: string,
  platform: SigningCredentialPlatform
): Promise<SigningCredentialStatus> {
  return api.signingCredentialStatus(repositoryId, name, platform);
}

export async function installSigningCredentials(
  repositoryId: string,
  name: string,
  platform: SigningCredentialPlatform,
  credentials: unknown
): Promise<SigningCredentialStatus> {
  return api.installSigningCredentials(repositoryId, name, platform, credentials);
}

export async function removeSigningCredentials(
  repositoryId: string,
  name: string,
  platform: SigningCredentialPlatform
): Promise<SigningCredentialStatus> {
  return api.removeSigningCredentials(repositoryId, name, platform);
}

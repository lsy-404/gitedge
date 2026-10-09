import { z } from "zod";
import { RepositoryRoleSchema } from "./repository-controls";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_INVITATIONS = 50;
/** Direct collaborators per repository; the collaborator list stays within one bounded page. */
export const MAX_REPOSITORY_COLLABORATORS = 80;

export const OrganizationRoleSchema = z.enum(["owner", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

const InviteeShape = {
  identifier: z.string().trim().toLowerCase().min(3).max(63).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
};

function exactlyOneInvitee(value: { identifier?: string; email?: string }): boolean {
  return (value.identifier === undefined) !== (value.email === undefined);
}

/** Invite an existing user by username, or anyone by email through a one-time link. */
export const CreateOrganizationInvitationSchema = z
  .object({ ...InviteeShape, role: OrganizationRoleSchema.default("member") })
  .strict()
  .refine(exactlyOneInvitee);
export const CreateRepositoryInvitationSchema = z
  .object({ ...InviteeShape, role: RepositoryRoleSchema.default("read") })
  .strict()
  .refine(exactlyOneInvitee);
export const UpdateOrganizationMemberSchema = z.object({ role: OrganizationRoleSchema }).strict();
export const InvitationTokenInputSchema = z.object({ token: z.string().min(20).max(128) }).strict();

export type InvitationKind = "organization" | "repository";
export type InvitationStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

export interface Invitation {
  id: string;
  kind: InvitationKind;
  role: string;
  /** Organization slug for organization invitations. */
  organization: string | null;
  repository: { id: string; owner: string; name: string } | null;
  inviter: string;
  /** Username the invitation is bound to; null for link invitations. */
  invitee: string | null;
  inviteeEmail: string | null;
  status: InvitationStatus;
  createdAt: number;
  expiresAt: number;
}

export interface CreatedInvitation extends Invitation {
  /** One-time secret for link invitations, shown once; null for username invitations. */
  token: string | null;
}

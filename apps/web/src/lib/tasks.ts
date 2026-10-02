import { ApiError } from "./api";
import type {
  Assignee,
  AssigneeCandidate,
  AssigneeRef,
  RevisionActor,
  TaskDocumentKind,
  TaskStatus,
} from "./api";

/** The parts of a memory index or task document the Markdown pane needs. */
export interface DocumentView {
  content: string;
  /** 0 until the first save. */
  revision: number;
  actor: RevisionActor | null;
  updatedAt: number | null;
}

export const taskStatuses = [
  "pending",
  "in_progress",
  "done",
  "abandoned",
] as const satisfies readonly TaskStatus[];

export const taskDocumentKinds = [
  "plan",
  "findings",
  "progress",
] as const satisfies readonly TaskDocumentKind[];

/** Matches the server-side task type rule so the form can report problems before submitting. */
export const taskTypePattern = /^[A-Za-z]{2,24}$/;
export const gitOidPattern = /^[0-9a-f]{40}$/;

export type BadgeTone = "neutral" | "success" | "danger" | "brand" | "warning";

export function taskStatusTone(status: TaskStatus): BadgeTone {
  switch (status) {
    case "in_progress":
      return "brand";
    case "done":
      return "success";
    case "abandoned":
      return "warning";
    default:
      return "neutral";
  }
}

export function assigneeKey(ref: AssigneeRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function assigneeRef(value: Assignee): AssigneeRef {
  return { kind: value.kind, id: value.id };
}

/** Parses a dropdown value produced by `assigneeKey`; an empty value means "nobody". */
export function parseAssigneeKey(
  value: string,
  candidates: readonly AssigneeCandidate[]
): AssigneeRef | null {
  const match = candidates.find((candidate) => assigneeKey(candidate) === value);
  return match ? assigneeRef(match) : null;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Human-readable writer of a revision; platform entries are labelled as such. */
export function revisionActorLabel(actor: RevisionActor | null, t: Translate): string {
  if (!actor) return "";
  if (actor.kind === "system") return t("docSystemActor");
  return actor.kind === "agent" ? `${actor.name} · ${t("agent")}` : actor.name;
}

export function revisionActorTone(actor: RevisionActor | null): BadgeTone {
  if (actor?.kind === "agent") return "brand";
  return "neutral";
}

/**
 * Maps a failed request to localized text. `overrides` replaces the generic message for a status
 * with a message key that explains the failure in the context of the action.
 */
export function errorMessage(
  cause: unknown,
  t: Translate,
  overrides: Partial<Record<number, string>> = {}
): string {
  if (cause instanceof ApiError) {
    const override = overrides[cause.status];
    if (override) return t(override);
    if (cause.status === 403) return t("permissionDenied");
    if (cause.status === 404) return t("resourceNotFound");
    if (cause.status === 409) return t("conflictError");
  }
  return t("apiError");
}

export function isUnavailable(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 403 || cause.status === 404);
}

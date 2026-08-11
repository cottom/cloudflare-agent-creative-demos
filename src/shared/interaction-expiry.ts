import type { InteractionKind, ProjectInteraction } from "./types";

/**
 * Approvals do not wait forever.
 *
 * A workflow that pauses for a human currently blocks until someone answers,
 * which in practice means until the workflow's own ceiling — an abandoned
 * approval holds a run, its budget and its slot indefinitely. Giving each
 * interaction a deadline turns "nobody answered" from a hang into an outcome.
 *
 * The deadline is derived from the kind rather than stored, so existing
 * interactions get one without a migration and the policy stays in one
 * readable table instead of scattered across whoever published them.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const TTL_BY_KIND: Record<InteractionKind, number> = {
  // A plain question in a conversation is stale quickly — the user has moved on.
  choice: 60 * 60 * 1000,
  multi_select: 60 * 60 * 1000,
  form: 4 * 60 * 60 * 1000,
  // Decisions someone may need to leave their desk for get a working day.
  approval: DEFAULT_TTL_MS,
  ppt_plan_review: DEFAULT_TTL_MS,
  canvas_variant_review: DEFAULT_TTL_MS
};

export function ttlFor(kind: InteractionKind): number {
  return TTL_BY_KIND[kind] ?? DEFAULT_TTL_MS;
}

export function expiresAt(interaction: Pick<ProjectInteraction, "kind" | "createdAt">): string {
  return new Date(new Date(interaction.createdAt).getTime() + ttlFor(interaction.kind)).toISOString();
}

export function isExpired(
  interaction: Pick<ProjectInteraction, "kind" | "createdAt" | "status">,
  now = Date.now()
): boolean {
  // Only a pending interaction can expire. One already answered keeps its
  // answer — a deadline that retroactively invalidated a decision would be
  // worse than no deadline.
  if (interaction.status !== "pending") return false;
  const created = new Date(interaction.createdAt).getTime();
  // An unparseable timestamp must not silently mean "expired long ago".
  if (!Number.isFinite(created)) return false;
  return now > created + ttlFor(interaction.kind);
}

/** Seconds left, for clients that want to show a countdown. Never negative. */
export function secondsRemaining(
  interaction: Pick<ProjectInteraction, "kind" | "createdAt" | "status">,
  now = Date.now()
): number {
  const created = new Date(interaction.createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.round((created + ttlFor(interaction.kind) - now) / 1000));
}

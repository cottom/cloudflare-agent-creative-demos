/**
 * Pure policy decisions shared by the Worker and its tests.
 *
 * These live outside `src/worker/` on purpose: everything under that directory
 * transitively imports `cloudflare:workers`, which a plain Node test runner
 * cannot resolve. Keeping the rules pure keeps them directly testable.
 */

/**
 * How many per-revision snapshots the workspace mirror retains.
 *
 * Every mutation writes a full copy of project state — including each canvas
 * drag — so an unbounded archive grows without limit inside the Durable
 * Object's SQLite storage.
 */
export const REVISION_HISTORY_LIMIT = 20;

/**
 * Select the snapshot filenames that fall outside the retention window.
 *
 * Revisions are monotonic and zero-padded, so lexicographic order matches
 * numeric order and the oldest entries sort first.
 */
export function staleRevisionFiles(names: string[], limit = REVISION_HISTORY_LIMIT): string[] {
  const snapshots = names.filter((name) => name.endsWith(".json")).sort();
  return snapshots.slice(0, Math.max(0, snapshots.length - limit));
}

/**
 * The artifact endpoint takes a caller-supplied key, so reads are confined to
 * the prefixes this app actually writes.
 *
 * ":" is permitted because a tenant-scoped project's id is its composed object
 * name, which appears as the second key segment.
 */
export function isServableArtifactKey(key: string): boolean {
  return /^(ppt|canvas)\/[\w.:/-]+$/.test(key) && !key.includes("..");
}

/**
 * Whether an artifact key belongs to a tenant.
 *
 * Keys are `<prefix>/<projectId>/…`, and a tenant-scoped project's id begins
 * with its own tenant segment. Demo-plane keys have a bare project id and no
 * tenant segment, so they match no tenant and are unreachable from `/v1`.
 */
export function artifactKeyBelongsToTenant(key: string, tenantId: string): boolean {
  if (!isServableArtifactKey(key)) return false;
  const projectSegment = key.split("/")[1] ?? "";
  return projectSegment.startsWith(`${tenantId}:`);
}

/**
 * Durable Object instance name for a project's Agent session.
 *
 * Shared rather than worker-local because the browser needs the identical
 * string to open its WebSocket at `/agents/studio-agent/<name>`; if the two
 * sides disagree the client silently talks to a different, unconfigured agent.
 */
export function studioAgentName(kind: string, projectId: string, sessionId: string): string {
  return `${kind}--${projectId}--${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 180);
}

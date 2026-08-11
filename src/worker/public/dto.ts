import type {
  ActivityEvent,
  ExportArtifact,
  ProjectInteraction,
  ProjectState,
  SessionMeta,
  WorkflowRun
} from "../../shared/types";

/**
 * Public representations.
 *
 * The internal model is shaped by how this happens to run: Durable Object
 * names, R2 keys, Cloudflare Workflow instance ids, a `kind` discriminator that
 * selects a DO binding. None of that is a third party's business, and every bit
 * of it we leak becomes a compatibility obligation the day someone builds
 * against it. This module is the one place internal vocabulary is translated,
 * so nothing downstream has to remember to.
 *
 * Conventions follow the AI platform APIs integrators already use — snake_case
 * fields, an `object` discriminator, `{data, has_more, next_cursor}` lists,
 * opaque prefixed ids — rather than inventing a house style.
 */

/** Internal `kind` ⇄ public `type`. "ppt" is our word; "presentation" is theirs. */
const TYPE_BY_KIND: Record<string, string> = { ppt: "presentation", canvas: "canvas" };
const KIND_BY_TYPE: Record<string, string> = { presentation: "ppt", canvas: "canvas" };

export function publicAssetType(kind: string): string {
  return TYPE_BY_KIND[kind] ?? kind;
}

export function internalKind(assetType: string): string | undefined {
  return KIND_BY_TYPE[assetType];
}

/** Public flow ids, decoupled from the Workflow class names behind them. */
const FLOW_BY_WORKFLOW: Record<string, string> = {
  "ppt-build": "presentation.generate",
  "canvas-variants": "canvas.variants"
};
const WORKFLOW_BY_FLOW: Record<string, string> = Object.fromEntries(
  Object.entries(FLOW_BY_WORKFLOW).map(([workflow, flow]) => [flow, workflow])
);

export function publicFlowId(workflowId: string): string {
  return FLOW_BY_WORKFLOW[workflowId] ?? workflowId;
}

export function internalWorkflowId(flow: string): string | undefined {
  return WORKFLOW_BY_FLOW[flow];
}

/**
 * Public payloads are serialised straight to JSON, so they are typed as plain
 * records rather than the depth-bounded `JsonObject` used on the Durable Object
 * RPC boundary — that bound exists to keep the type checker from giving up on
 * `Rpc.Serializable`, and applying it here would reject legitimately deep
 * document content.
 */
export type PublicObject = Record<string, unknown>;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export type ListEnvelope<T> = {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
};

export function list<T>(data: T[], nextCursor: string | null = null): ListEnvelope<T> {
  return { object: "list", data, has_more: Boolean(nextCursor), next_cursor: nextCursor };
}

export type AssetRecord = {
  id: string;
  kind: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  metadata: Record<string, string>;
};

export function toAsset(record: AssetRecord, state?: ProjectState): PublicObject {
  return {
    id: record.id,
    object: "asset",
    type: publicAssetType(record.kind),
    name: record.name,
    // `revision` is an internal word for the same idea every optimistic-
    // concurrency API calls a version.
    version: state ? state.revision : null,
    status: record.archivedAt ? "archived" : "active",
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    metadata: record.metadata
  };
}

/**
 * A file, addressed by its own id.
 *
 * The internal `key` is an R2 path that embeds the tenant, the asset and the
 * revision (`ppt/acme:ppt:deck-1/revision-3.pptx`). Publishing it would hand
 * integrators our storage layout and the composed object name — so the key
 * never crosses this boundary; the id does, and is resolved server-side.
 */
export function toFile(artifact: ExportArtifact, assetId: string): PublicObject {
  return {
    id: artifact.id,
    object: "file",
    filename: artifact.name,
    content_type: artifact.contentType,
    purpose: artifact.kind === "pptx" ? "export" : artifact.kind === "image" ? "generated_image" : "snapshot",
    asset_id: assetId,
    asset_version: artifact.revision,
    created_at: artifact.createdAt,
    download_url: `/v1/assets/${assetId}/files/${artifact.id}/content`
  };
}

const RUN_STATUS: Record<WorkflowRun["status"], string> = {
  queued: "queued",
  running: "running",
  // "waiting" is ambiguous from outside; the caller needs to know it is waiting
  // on *them*.
  waiting: "requires_action",
  complete: "succeeded",
  error: "failed",
  cancelled: "cancelled"
};

export function toRun(run: WorkflowRun, assetId: string, pendingActions: ProjectInteraction[]): PublicObject {
  return {
    id: run.id,
    object: "run",
    flow: publicFlowId(run.type === "ppt_build" ? "ppt-build" : "canvas-variants"),
    status: RUN_STATUS[run.status],
    progress: run.progress,
    message: run.message,
    asset_id: assetId,
    required_action: pendingActions.length
      ? { type: "submit_response", action: toAction(pendingActions[0]!, assetId) }
      : null,
    error: run.error ?? null,
    created_at: run.createdAt,
    updated_at: run.updatedAt
  };
}

/**
 * A pause that needs a human answer.
 *
 * `payload` is passed through as the form schema so integrators can render
 * their own UI for it rather than being forced into ours.
 */
export function toAction(interaction: ProjectInteraction, assetId: string): PublicObject {
  return {
    id: interaction.id,
    object: "action",
    type: interaction.kind,
    title: interaction.title,
    description: interaction.description ?? null,
    schema: interaction.payload,
    status: interaction.status === "cancelled" ? "declined" : interaction.status,
    asset_id: assetId,
    response: interaction.response ?? null,
    created_at: interaction.createdAt,
    resolved_at: interaction.resolvedAt ?? null
  };
}

export function toSession(session: SessionMeta, assetId: string): PublicObject {
  return {
    id: session.id,
    object: "session",
    asset_id: assetId,
    title: session.title,
    created_at: session.createdAt,
    updated_at: session.updatedAt
  };
}

export function toHistoryEvent(event: ActivityEvent): PublicObject {
  return {
    id: event.id,
    object: "history_event",
    version: event.revision,
    // Internally an actor may be a "workflow"; externally that is just the agent
    // acting on its own.
    actor: event.actor.type === "workflow" ? "agent" : event.actor.type,
    summary: event.summary,
    created_at: event.createdAt
  };
}

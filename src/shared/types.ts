import type { PptistDocument } from "./pptist";

export type { PptistDocument };

export type ProjectKind = "ppt" | "canvas";

/**
 * JSON-safe values. Durable Object RPC type-checks return values against
 * `Rpc.Serializable`, which rejects `unknown` — so free-form blobs that cross
 * the RPC boundary must be modelled as JSON rather than `Record<string, unknown>`.
 *
 * Nesting is bounded rather than self-referential on purpose: `Serializable<T>`
 * is itself a recursive mapped type, and composing it with an unbounded JSON
 * type makes the checker give up with "type instantiation is excessively deep"
 * (TS2589). Six levels covers the deepest payload on the wire — a plan review's
 * `payload.plan.slides[].keyPoints[]`.
 */
export type JsonPrimitive = string | number | boolean | null;
type Json0 = JsonPrimitive;
type Json1 = JsonPrimitive | Json0[] | { [key: string]: Json0 };
type Json2 = JsonPrimitive | Json1[] | { [key: string]: Json1 };
type Json3 = JsonPrimitive | Json2[] | { [key: string]: Json2 };
type Json4 = JsonPrimitive | Json3[] | { [key: string]: Json3 };
export type JsonValue = JsonPrimitive | Json4[] | { [key: string]: Json4 };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Serializable projection of an AI SDK `UIMessage` part.
 *
 * Tool parts are typed `tool-${toolName}` and carry the lifecycle the client
 * needs to render generative UI: `state` moves from `input-available` (the
 * model has asked for something) to `output-available` (resolved). Dropping
 * these fields leaves the client with a bare `{ type }` it cannot render.
 */
export type ChatMessagePart = {
  type: string;
  text?: string;
  toolCallId?: string;
  state?: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: JsonValue;
  output?: JsonValue;
  errorText?: string;
};

/** Serializable projection of an AI SDK `UIMessage` for the RPC/HTTP boundary. */
export type ChatMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  parts: ChatMessagePart[];
};

export type ActorRef = {
  type: "user" | "agent" | "workflow" | "system";
  id: string;
  sessionId?: string;
};

export type EditorAwareness = {
  activeId?: string;
  ids?: string[];
  viewport?: { x: number; y: number; zoom: number };
};

export type SessionMeta = {
  id: string;
  projectId: string;
  kind: ProjectKind;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type InteractionKind =
  | "choice"
  | "multi_select"
  | "form"
  | "approval"
  | "ppt_plan_review"
  | "canvas_variant_review";

export type ProjectInteraction = {
  id: string;
  projectId: string;
  sessionId: string;
  workflowId?: string;
  source: "agent" | "workflow";
  kind: InteractionKind;
  title: string;
  description?: string;
  payload: JsonObject;
  status: "pending" | "resolved" | "cancelled";
  response?: JsonObject;
  createdAt: string;
  resolvedAt?: string;
};

export type WorkflowRun = {
  id: string;
  projectId: string;
  sessionId: string;
  type: "ppt_build" | "canvas_variants";
  status: "queued" | "running" | "waiting" | "complete" | "error" | "cancelled";
  progress: number;
  message: string;
  result?: JsonObject;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type ActivityEvent = {
  id: string;
  revision: number;
  actor: ActorRef;
  summary: string;
  createdAt: string;
};

export type ExportArtifact = {
  id: string;
  kind: "pptx" | "json" | "image";
  key: string;
  name: string;
  contentType: string;
  revision: number;
  createdAt: string;
};

export type PptTheme = {
  id: "midnight" | "editorial" | "minimal" | "sunrise";
  name: string;
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  accent: string;
  fontFamily: string;
};

/**
 * The presentation asset. `deck` is the canonical PPTist document — the same
 * JSON the embedded editor loads and emits, so there is no translation layer.
 * The surrounding fields are project metadata the agent and workflows use.
 */
export type PresentationDocument = {
  title: string;
  objective: string;
  audience: string;
  deck: PptistDocument;
};

export type CanvasNode = {
  id: string;
  type: "image" | "text" | "note" | "frame";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  title: string;
  text?: string;
  assetKey?: string;
  prompt?: string;
  status?: "ready" | "generating" | "error";
  parentId?: string;
};

export type CanvasDocument = {
  title: string;
  width: number;
  height: number;
  background: string;
  nodes: CanvasNode[];
};

export type ProjectBaseState = {
  id: string;
  kind: ProjectKind;
  name: string;
  /** Document revision — user-meaningful, only advanced by `applyMutation`. */
  revision: number;
  /**
   * Monotonic counter bumped on *every* state write, including the ones that
   * leave `revision` alone (interactions, workflow progress, sessions,
   * artifacts). Pollers must compare this, not `revision`, or a pending
   * interaction card never reaches the client.
   */
  stateVersion: number;
  sessions: SessionMeta[];
  interactions: ProjectInteraction[];
  workflows: WorkflowRun[];
  artifacts: ExportArtifact[];
  activity: ActivityEvent[];
  createdAt: string;
  updatedAt: string;
};

export type PptProjectState = ProjectBaseState & {
  kind: "ppt";
  document: PresentationDocument;
};

export type CanvasProjectState = ProjectBaseState & {
  kind: "canvas";
  document: CanvasDocument;
};

export type ProjectState = PptProjectState | CanvasProjectState;

/**
 * Presentation commands.
 *
 * Fine-grained element editing now happens inside PPTist and arrives here as a
 * whole-deck replacement, which is why the bespoke element commands are gone:
 * the editor is the source of truth for composition, and duplicating its
 * command surface here would mean two models drifting apart.
 */
export type PptCommand =
  | { type: "ppt.replace_document"; document: PresentationDocument }
  | { type: "ppt.set_deck"; deck: PptistDocument }
  | { type: "ppt.set_meta"; patch: Partial<Pick<PresentationDocument, "title" | "objective" | "audience">> };

export type CanvasCommand =
  | { type: "canvas.replace_document"; document: CanvasDocument }
  | { type: "canvas.add_node"; node: CanvasNode }
  | { type: "canvas.update_node"; nodeId: string; patch: Partial<Omit<CanvasNode, "id">> }
  | { type: "canvas.delete_node"; nodeId: string }
  | { type: "canvas.duplicate_node"; nodeId: string; duplicate: CanvasNode }
  | {
      type: "canvas.set_generated_asset";
      nodeId: string;
      assetKey: string;
      prompt: string;
      status: "ready" | "error";
    };

export type ProjectCommand = PptCommand | CanvasCommand;

export type ProjectMutation = {
  commandId: string;
  baseRevision: number;
  actor: ActorRef;
  summary: string;
  commands: ProjectCommand[];
};

export type MutationSuccess<T extends ProjectState = ProjectState> = {
  ok: true;
  state: T;
  revision: number;
};

export type RevisionConflict<T extends ProjectState = ProjectState> = {
  ok: false;
  code: "REVISION_CONFLICT";
  currentRevision: number;
  state: T;
};

export type MutationResult<T extends ProjectState = ProjectState> =
  | MutationSuccess<T>
  | RevisionConflict<T>;

export type StudioAgentConfig = {
  projectId: string;
  kind: ProjectKind;
  sessionId: string;
  title: string;
  awareness?: EditorAwareness;
};

export type PptBuildWorkflowParams = {
  projectId: string;
  sessionId: string;
  objective: string;
  audience?: string;
  slideCount?: number;
  sourceNotes?: string;
};

export type CanvasVariantsWorkflowParams = {
  projectId: string;
  sessionId: string;
  objective: string;
  count: number;
  referenceNodeId?: string;
  aspectRatio?: "1:1" | "4:5" | "9:16" | "16:9";
};

/**
 * Metadata carried on a workflow approval. `StudioAgent.resolveInteraction`
 * sends this via `approveWorkflow({ metadata })`, and `waitForApproval`
 * returns exactly this object to the workflow.
 */
export type ApprovalMetadata = {
  interactionId?: string;
  response?: JsonObject;
};

export type WorkflowProgressPayload = {
  step: string;
  status: WorkflowRun["status"];
  percent: number;
  message: string;
  interactionId?: string;
};

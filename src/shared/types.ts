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
 * Slide geometry is stored in inches, matching PptxGenJS's `LAYOUT_WIDE`.
 *
 * The editor scales inches to pixels for display; keeping the model in the
 * export's native unit means what you drag is exactly what PowerPoint renders,
 * with no rounding drift between the two.
 */
export const SLIDE_WIDTH_IN = 13.333;
export const SLIDE_HEIGHT_IN = 7.5;

export type ElementAlign = "left" | "center" | "right";
export type ElementVAlign = "top" | "middle" | "bottom";

export type SlideElementBase = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise, about the element centre. */
  rotation: number;
  /** Paint order; higher is nearer the viewer. */
  z: number;
  locked?: boolean;
};

export type TextElement = SlideElementBase & {
  type: "text";
  text: string;
  role: "title" | "body" | "caption" | "metric";
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Hex without `#`, matching the theme tokens and PptxGenJS. */
  color?: string;
  fill?: string;
  align?: ElementAlign;
  valign?: ElementVAlign;
  bullet?: boolean;
  lineSpacing?: number;
};

export type ShapeElement = SlideElementBase & {
  type: "shape";
  shape: "rect" | "roundRect" | "ellipse" | "triangle" | "line";
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** 0–1, only meaningful for `roundRect`. */
  radius?: number;
};

export type ImageElement = SlideElementBase & {
  type: "image";
  /** R2 artifact key, served through /api/artifacts. */
  assetKey: string;
  altText?: string;
};

export type TableElement = SlideElementBase & {
  type: "table";
  rows: string[][];
  headerRow?: boolean;
  fontSize?: number;
};

export type SlideElement = TextElement | ShapeElement | ImageElement | TableElement;

/**
 * A patch may target any element kind, so it is the intersection of every
 * element's optional fields. `id` and `type` are excluded: changing either
 * would make it a different element, which is an add plus a delete.
 */
export type SlideElementPatch = Partial<
  Omit<TextElement, "id" | "type"> &
  Omit<ShapeElement, "id" | "type"> &
  Omit<ImageElement, "id" | "type"> &
  Omit<TableElement, "id" | "type">
>;

export type PptSlide = {
  id: string;
  title: string;
  subtitle?: string;
  body: string[];
  notes?: string;
  layout: "title" | "statement" | "bullets" | "two_column" | "metrics";
  elements: SlideElement[];
};

export type PresentationDocument = {
  title: string;
  objective: string;
  audience: string;
  theme: PptTheme;
  slides: PptSlide[];
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

export type PptCommand =
  | { type: "ppt.replace_document"; document: PresentationDocument }
  | { type: "ppt.add_slide"; slide: PptSlide; index?: number }
  | { type: "ppt.update_slide"; slideId: string; patch: Partial<Omit<PptSlide, "id">> }
  | { type: "ppt.delete_slide"; slideId: string }
  | { type: "ppt.reorder_slides"; slideIds: string[] }
  | { type: "ppt.set_theme"; theme: PptTheme }
  | { type: "ppt.add_element"; slideId: string; element: SlideElement }
  | { type: "ppt.update_element"; slideId: string; elementId: string; patch: SlideElementPatch }
  | { type: "ppt.delete_element"; slideId: string; elementId: string }
  /** Absolute paint order; the editor computes the target `z` for send-to-back etc. */
  | { type: "ppt.set_element_order"; slideId: string; elementId: string; z: number };

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

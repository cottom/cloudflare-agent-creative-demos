import { getAgentByName } from "agents";
import { Session, Think } from "@cloudflare/think";
import { tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { PPT_THEMES } from "../shared/themes";
import { uiSpecSchema } from "../shared/ui-schema";
import {
  contractFor,
  describeSubmissionForModel,
  validateSubmission,
  type ContractViolation
} from "../shared/interaction-contract";
import { isExpired } from "../shared/interaction-expiry";

/** A submission the interaction's own declaration does not permit. */
export class InteractionContractError extends Error {
  constructor(public violations: ContractViolation[]) {
    super("Submission does not match this interaction's contract");
  }
}

/** The run behind an interaction can no longer be resumed. */
export class InteractionUnresumableError extends Error {
  constructor(interactionId: string) {
    super(`Interaction ${interactionId} can no longer be resumed`);
  }
}

/** A submission arriving after the interaction stopped waiting for one. */
export class InteractionExpiredError extends Error {
  constructor(interactionId: string) {
    super(`Interaction ${interactionId} has expired`);
  }
}
import { studioAgentName } from "../shared/policy";
import type {
  CanvasCommand,
  CanvasNode,
  CanvasVariantsWorkflowParams,
  ChatMessage,
  ChatMessagePart,
  EditorAwareness,
  JsonObject,
  JsonValue,
  PptBuildWorkflowParams,
  PptCommand,
  ProjectCommand,
  ProjectInteraction,
  ProjectKind,
  ProjectState,
  SessionMeta,
  StudioAgentConfig,
  WorkflowProgressPayload,
  WorkflowRun
} from "../shared/types";
import { savePresentationExport, saveSlideImage } from "./lib/artifacts";
import { generateImageBytes, workersLanguageModel } from "./lib/ai";
import {
  applyProjectMutation,
  getProjectStub,
  listWorkspace,
  readProject,
  readWorkspaceFile,
  syncProjectWorkspace,
  writeWorkspaceFile
} from "./lib/project-access";

/**
 * `UIMessage` carries `metadata?: unknown`, which fails the Workers RPC
 * `Serializable` check and silently collapses callers to `never`. Project the
 * message onto the JSON-safe subset the UI actually renders.
 */
function toChatMessage(message: UIMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts.map((part): ChatMessagePart => {
      const source = part as Record<string, unknown>;
      const projected: ChatMessagePart = { type: part.type };
      if (typeof source.text === "string") projected.text = source.text;
      // Tool parts drive the interactive UI: without the call id, lifecycle
      // state, and input/output payloads the client receives a bare `{ type }`
      // and has nothing to render.
      if (typeof source.toolCallId === "string") projected.toolCallId = source.toolCallId;
      if (typeof source.state === "string") projected.state = source.state as ChatMessagePart["state"];
      if (source.input !== undefined) projected.input = toJsonValue(source.input);
      if (source.output !== undefined) projected.output = toJsonValue(source.output);
      if (typeof source.errorText === "string") projected.errorText = source.errorText;
      return projected;
    })
  };
}

/**
 * Normalise an arbitrary tool payload into the JSON subset that survives the
 * Workers RPC boundary. Round-tripping also drops `undefined` and functions,
 * which `Rpc.Serializable` would otherwise reject.
 */
function toJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return null;
  }
}

/** Deterministic seed so regenerating the same prompt yields the same art. */
function stableImageSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) || 1;
}

const MAX_MUTATION_ATTEMPTS = 4;
/** Per-attempt delay in ms; index 0 is unused because the first try is immediate. */
const BACKOFF_MS = [0, 25, 75, 200];

export { studioAgentName } from "../shared/policy";

function workflowType(workflowName: string): WorkflowRun["type"] {
  return workflowName.includes("PPT") ? "ppt_build" : "canvas_variants";
}

function mapWorkflowStatus(status: string | undefined): WorkflowRun["status"] {
  if (status === "complete") return "complete";
  if (status === "error" || status === "errored") return "error";
  if (status === "pending" || status === "waiting") return "waiting";
  if (status === "cancelled" || status === "terminated") return "cancelled";
  if (status === "queued") return "queued";
  return "running";
}

/** The subset of the agent reachable over RPC when delegating. */
type StudioAgentStub = {
  resolveInteraction(interactionId: string, response: JsonObject): Promise<ProjectInteraction>;
  rejectInteraction(interactionId: string, reason: string): Promise<ProjectInteraction>;
};

export type WorkflowBindingName = "PPT_BUILD_WORKFLOW" | "CANVAS_VARIANTS_WORKFLOW";

export class StudioAgent extends Think<Env> {
  override sendReasoning = false;
  override maxSteps = 8;

  override getModel() {
    return workersLanguageModel(this.env);
  }

  getSystemPrompt(): string {
    return "You are a project-native creative agent. Read the current Project context and use tools to make precise, revision-safe edits. The Project owns the asset; the conversation does not.";
  }

  configureSession(session: Session) {
    return session
      .withContext("identity", {
        provider: {
          get: async () => [
            "You are the AI co-editor inside a long-lived creative Project.",
            "The Project is the source of truth. Never pretend a change happened: use tools.",
            "Use quick edit tools for bounded edits. Use durable workflows for multi-step generation, approval, fan-out, or expensive model calls.",
            "When the user says this/that/current, use the editor selection in Project context.",
            "Explain important changes briefly after tools finish. Ask for structured human input only when a decision materially changes cost or direction."
          ].join("\n")
        }
      })
      .withContext("project", {
        description: "Latest canonical Project state and current editor selection.",
        provider: { get: async () => this.getCurrentProjectContext() }
      })
      .withContext("session_memory", {
        description: "Preferences and decisions that apply only to this Agent session.",
        maxTokens: 1200
      });
  }

  private requireConfig(): StudioAgentConfig {
    const config = this.getConfig<StudioAgentConfig>();
    if (!config) throw new Error("Agent session is not configured for a project");
    return config;
  }

  async configureForProject(config: StudioAgentConfig): Promise<StudioAgentConfig> {
    this.configure(config);
    const stub = getProjectStub(this.env, config.kind, config.projectId);
    await stub.initialize(config.projectId);
    const now = new Date().toISOString();
    const session: SessionMeta = {
      id: config.sessionId,
      projectId: config.projectId,
      kind: config.kind,
      title: config.title,
      createdAt: now,
      updatedAt: now
    };
    await stub.addSession(session);
    return config;
  }

  async setEditorAwareness(awareness?: EditorAwareness): Promise<void> {
    const config = this.requireConfig();
    this.configure({ ...config, awareness });
  }

  async getCurrentProjectContext(): Promise<string> {
    const config = this.getConfig<StudioAgentConfig>();
    if (!config) return JSON.stringify({ project: null, note: "Agent is not configured yet" });
    const stub = getProjectStub(this.env, config.kind, config.projectId);
    return stub.getAgentContext(config.awareness);
  }

  async getProjectSnapshot(): Promise<ProjectState> {
    const config = this.requireConfig();
    return readProject(this.env, config.kind, config.projectId);
  }

  async getConversation(): Promise<ChatMessage[]> {
    return (await this.getMessages()).map(toChatMessage);
  }

  async sendUserMessage(text: string, awareness?: EditorAwareness) {
    const config = this.requireConfig();
    if (!text.trim()) throw new Error("Message is empty");
    if (awareness) this.configure({ ...config, awareness });

    const messageId = crypto.randomUUID();
    const submission = await this.submitMessages(
      [{
        id: messageId,
        role: "user",
        parts: [{ type: "text", text: text.trim() }]
      }],
      {
        submissionId: messageId,
        idempotencyKey: `${config.sessionId}:${messageId}`,
        metadata: {
          projectId: config.projectId,
          projectKind: config.kind,
          sessionId: config.sessionId
        }
      }
    );

    return {
      submissionId: messageId,
      accepted: submission.accepted,
      messages: await this.getConversation()
    };
  }

  async clearConversation(): Promise<void> {
    await this.clearMessages();
  }

  private async applyCommands(
    commands: ProjectCommand[],
    summary: string,
    actorType: "agent" | "workflow",
    workflowId?: string,
    operationId?: string
  ) {
    const config = this.requireConfig();
    const commandId = `${actorType}-${workflowId ?? config.sessionId}-${operationId ?? crypto.randomUUID()}`;
    let lastRevision = -1;
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      // Retries are immediate on the first pass, then backed off. Without this,
      // four attempts can burn through inside a few milliseconds while a user
      // drag or a sibling workflow step is still committing — losing the edit
      // to a conflict that would have cleared on its own.
      if (attempt > 0) await scheduler.wait(BACKOFF_MS[attempt] ?? 200);
      const state = await readProject(this.env, config.kind, config.projectId);
      const result = await applyProjectMutation(this.env, config.kind, config.projectId, {
        commandId,
        baseRevision: state.revision,
        actor: { type: actorType, id: workflowId ?? config.sessionId, sessionId: config.sessionId },
        summary,
        commands
      });
      if (result.ok) {
        await syncProjectWorkspace(this.env, result.state);
        return result.state;
      }
      lastRevision = result.currentRevision;
    }
    throw new Error(
      `Project changed repeatedly while the Agent was editing (latest revision ${lastRevision} ` +
      `after ${MAX_MUTATION_ATTEMPTS} attempts); retry the request`
    );
  }

  async applyWorkflowCommands(
    workflowId: string,
    commands: ProjectCommand[],
    summary: string,
    operationId: string
  ): Promise<ProjectState> {
    return this.applyCommands(commands, summary, "workflow", workflowId, operationId);
  }

  async createWorkflowInteraction(interaction: ProjectInteraction): Promise<ProjectInteraction> {
    const config = this.requireConfig();
    const stub = getProjectStub(this.env, config.kind, config.projectId);
    return stub.createInteraction(interaction);
  }

  async resolveInteraction(interactionId: string, response: JsonObject): Promise<ProjectInteraction> {
    const config = this.requireConfig();
    const stub = getProjectStub(this.env, config.kind, config.projectId);
    const interaction = await stub.getInteraction(interactionId);
    if (!interaction) throw new Error(`Interaction not found: ${interactionId}`);
    const owner = await this.delegateToOwner(interaction, (agent) =>
      agent.resolveInteraction(interactionId, response));
    if (owner) return owner;
    // Already answered. Returning the settled record rather than applying a
    // second submission is what makes an at-least-once retry safe.
    if (interaction.status !== "pending") return interaction;
    if (isExpired(interaction)) throw new InteractionExpiredError(interactionId);

    // Authoritative validation. The browser validates too, but that only helps
    // the honest caller; this is the check that decides.
    const violations = validateSubmission(contractFor(interaction), response);
    if (violations.length) throw new InteractionContractError(violations);

    if (interaction.workflowId) {
      await this.resumeOrSettle(interaction, () =>
        this.approveWorkflow(interaction.workflowId!, {
          reason: "Approved from project interaction UI",
          metadata: { interactionId, response }
        }));
    } else {
      const messageId = `interaction-response-${interactionId}`;
      await this.submitMessages([{
        id: messageId,
        role: "user",
        parts: [{
          type: "text",
          text: describeSubmissionForModel(interactionId, response)
        }]
      }], {
        submissionId: messageId,
        idempotencyKey: messageId,
        metadata: { interactionId, projectId: config.projectId, sessionId: config.sessionId }
      });
    }

    return stub.resolveInteraction(interactionId, response, "resolved");
  }

  async rejectInteraction(interactionId: string, reason: string): Promise<ProjectInteraction> {
    const config = this.requireConfig();
    const stub = getProjectStub(this.env, config.kind, config.projectId);
    const interaction = await stub.getInteraction(interactionId);
    if (!interaction) throw new Error(`Interaction not found: ${interactionId}`);
    const owner = await this.delegateToOwner(interaction, (agent) =>
      agent.rejectInteraction(interactionId, reason));
    if (owner) return owner;
    if (interaction.status !== "pending") return interaction;
    if (interaction.workflowId) {
      await this.resumeOrSettle(interaction, () =>
        this.rejectWorkflow(interaction.workflowId!, { reason }));
    }
    return stub.resolveInteraction(interactionId, { reason }, "cancelled");
  }

  /**
   * Stop a run that is still going.
   *
   * Rejecting a pending approval already ends a run that is waiting on a
   * person, but a run doing work had no stop at all — the only way out was to
   * let it finish and pay for whatever it did on the way. Terminating the
   * instance is what actually halts execution; recording the status only makes
   * it visible, so it is done second and the terminate failure is not swallowed.
   */
  /**
   * Resume the workflow behind an interaction, or retire the interaction.
   *
   * A workflow can outlive its ability to be resumed — terminated, expired, or
   * lost with the tracking state that pointed at it. That used to surface as a
   * 500 on every attempt, forever, with the approval still sitting in the UI
   * inviting the next one. An unresumable interaction is instead settled as
   * cancelled and reported as gone: the run is not coming back, and the queue
   * should stop pretending otherwise.
   */
  private async resumeOrSettle(interaction: ProjectInteraction, resume: () => Promise<unknown>): Promise<void> {
    try {
      await resume();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found in tracking table|instance not found|already (completed|terminated)/i.test(message)) {
        throw error;
      }
      const stub = getProjectStub(this.env, this.requireConfig().kind, this.requireConfig().projectId);
      await stub.resolveInteraction(
        interaction.id,
        { reason: "The run behind this request is no longer available" },
        "cancelled"
      );
      console.warn(JSON.stringify({
        event: "interaction_unresumable",
        interactionId: interaction.id,
        workflowId: interaction.workflowId,
        error: message
      }));
      throw new InteractionUnresumableError(interaction.id);
    }
  }

  /**
   * Hand an interaction to the session that can actually resume it.
   *
   * Interactions live on the project, which every session of that project can
   * see, but a workflow can only be resumed by the agent that started it —
   * resumption state is per-session. So answering a pending approval from any
   * other session (a second tab, a new chat, the demo plane's fixed session
   * name) reached the right record and then failed with "not found in tracking
   * table", surfaced as an opaque 500.
   *
   * The interaction already names its owner, so this routes by that rather than
   * by whichever session the caller happened to come through. Returns null when
   * this agent *is* the owner, which is what terminates the hop.
   */
  private async delegateToOwner(
    interaction: ProjectInteraction,
    run: (agent: StudioAgentStub) => Promise<ProjectInteraction>
  ): Promise<ProjectInteraction | null> {
    const config = this.requireConfig();
    if (!interaction.sessionId || interaction.sessionId === config.sessionId) return null;
    const agent = await getAgentByName<Env, StudioAgent>(
      this.env.STUDIO_AGENT,
      studioAgentName(config.kind, config.projectId, interaction.sessionId)
    );
    return run(agent as unknown as StudioAgentStub);
  }

  async cancelWorkflow(instanceId: string, binding: WorkflowBindingName, reason: string) {
    const workflow = this.env[binding];
    const instance = await workflow.get(instanceId);
    const status = await instance.status();
    // Terminating something already finished is not an error worth raising —
    // the caller wanted it stopped, and it is stopped.
    if (["complete", "errored", "terminated"].includes(String(status.status))) {
      return { instanceId, alreadySettled: true, status: String(status.status) };
    }
    await instance.terminate();
    await this.recordWorkflow(instanceId, workflowType(binding), "cancelled", 1, reason);
    return { instanceId, alreadySettled: false, status: "cancelled" };
  }

  async exportCurrentPpt() {
    const config = this.requireConfig();
    if (config.kind !== "ppt") throw new Error("This session is not attached to a PPT project");
    const state = await readProject(this.env, "ppt", config.projectId);
    if (state.kind !== "ppt") throw new Error("Project kind mismatch");
    return savePresentationExport(this.env, state);
  }

  async startPptBuildWorkflow(params: Omit<PptBuildWorkflowParams, "projectId" | "sessionId">) {
    const config = this.requireConfig();
    if (config.kind !== "ppt") throw new Error("PPT workflow requires a PPT project");
    const workflowId = await this.runWorkflow("PPT_BUILD_WORKFLOW", {
      ...params,
      projectId: config.projectId,
      sessionId: config.sessionId
    }, {
      agentBinding: "STUDIO_AGENT",
      metadata: { projectId: config.projectId, sessionId: config.sessionId, type: "ppt_build" }
    });
    await this.recordWorkflow(workflowId, "ppt_build", "queued", 0, "Queued presentation workflow");
    return { workflowId };
  }

  async startCanvasVariantsWorkflow(params: Omit<CanvasVariantsWorkflowParams, "projectId" | "sessionId">) {
    const config = this.requireConfig();
    if (config.kind !== "canvas") throw new Error("Canvas workflow requires a canvas project");
    const workflowId = await this.runWorkflow("CANVAS_VARIANTS_WORKFLOW", {
      ...params,
      projectId: config.projectId,
      sessionId: config.sessionId
    }, {
      agentBinding: "STUDIO_AGENT",
      metadata: { projectId: config.projectId, sessionId: config.sessionId, type: "canvas_variants" }
    });
    await this.recordWorkflow(workflowId, "canvas_variants", "queued", 0, "Queued visual variants workflow");
    return { workflowId };
  }

  private async recordWorkflow(
    id: string,
    type: WorkflowRun["type"],
    status: WorkflowRun["status"],
    progress: number,
    message: string,
    extra?: Partial<WorkflowRun>
  ) {
    const config = this.requireConfig();
    const stub = getProjectStub(this.env, config.kind, config.projectId);
    const current = (await stub.getSnapshot() as ProjectState).workflows.find((item) => item.id === id);
    const now = new Date().toISOString();
    return stub.upsertWorkflow({
      id,
      projectId: config.projectId,
      sessionId: config.sessionId,
      type,
      status,
      progress: Math.max(0, Math.min(progress, 1)),
      message,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      ...extra
    });
  }

  async onWorkflowProgress(workflowName: string, instanceId: string, progress: unknown) {
    const payload = progress as Partial<WorkflowProgressPayload>;
    await this.recordWorkflow(
      instanceId,
      workflowType(workflowName),
      mapWorkflowStatus(payload.status),
      payload.percent ?? 0,
      payload.message ?? payload.step ?? "Workflow running"
    );
  }

  async onWorkflowComplete(workflowName: string, instanceId: string, result?: unknown) {
    await this.recordWorkflow(instanceId, workflowType(workflowName), "complete", 1, "Workflow complete", {
      result: result && typeof result === "object" ? result as JsonObject : { value: String(result) }
    });
  }

  async onWorkflowError(workflowName: string, instanceId: string, error: string) {
    await this.recordWorkflow(instanceId, workflowType(workflowName), "error", 1, "Workflow failed", { error });
  }

  getTools(): ToolSet {
    const config = this.getConfig<StudioAgentConfig>();
    const common: ToolSet = {
      inspect_project: tool({
        description: "Read the latest canonical project state and current editor selection.",
        inputSchema: z.object({}),
        execute: async () => JSON.parse(await this.getCurrentProjectContext())
      }),
      list_project_files: tool({
        description: "List durable files in this Project's Cloudflare Computer workspace.",
        inputSchema: z.object({}),
        execute: async () => {
          const current = this.requireConfig();
          return listWorkspace(this.env, current.kind, current.projectId);
        }
      }),
      read_project_file: tool({
        description: "Read a UTF-8 text file from the Project's durable Cloudflare Computer workspace.",
        inputSchema: z.object({ path: z.string().startsWith("/").max(300) }),
        execute: async ({ path }) => {
          const current = this.requireConfig();
          return { path, content: await readWorkspaceFile(this.env, current.kind, current.projectId, path) };
        }
      }),
      write_project_note: tool({
        description: "Write a durable Markdown note into /scratch in the Project's Cloudflare Computer workspace.",
        inputSchema: z.object({
          filename: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
          content: z.string().max(30000)
        }),
        execute: async ({ filename, content }) => {
          const current = this.requireConfig();
          const path = `/scratch/${filename.endsWith(".md") ? filename : `${filename}.md`}`;
          await writeWorkspaceFile(this.env, current.kind, current.projectId, path, content);
          return { ok: true, path };
        }
      }),
      ask_user: tool({
        description: [
          "Render an interactive card in the chat and wait for the user's answer.",
          "Use it whenever a decision must be made before you act.",
          "Components: 'choice' (big tappable cards, 2-5 options),",
          "'radio' (compact single pick), 'select' (dropdown, good for 6+ options),",
          "'multi_select' (several picks, honours minSelected/maxSelected),",
          "'form' (typed fields), 'confirm' (yes/no gate).",
          "Form field types: text, textarea, number, email, url, date, select,",
          "radio, checkbox, multi_select, slider — with required, min, max, step,",
          "minLength, maxLength and pattern for validation.",
          "For dependent questions use showIf ({field, equals|oneOf}) to reveal a",
          "field only on a branch, and optionsBy ({field, map}) to make one",
          "select's options depend on another's value.",
          "Give an option a 'path' when it selects a branch you will follow;",
          "the chosen path is returned to you verbatim.",
          "Ask for everything you need in one card rather than several turns.",
          "Do not describe the card in prose — returning the spec renders it."
        ].join(" "),
        inputSchema: uiSpecSchema
        // No `execute` on purpose. A tool with no server-side implementation is
        // surfaced to the client as `state: "input-available"`, which renders
        // the component; the user's answer is returned via `addToolOutput` and
        // the model continues from there.
      })
    };

    if (config?.kind === "ppt") {
      return {
        ...common,
        // The PPTist controller lives in the browser, so these tools have no
        // server `execute`: the client runs them against the live editor and
        // returns the result through `addToolOutput`. That keeps one editing
        // engine rather than a server-side reimplementation of its commands.
        pptist_domains: tool({
          description: "List the PPTist editor's command domains (deck, slides, elements, text, shapes, animations, tables, charts, images, notes, view, export…). Start here to discover what you can do.",
          inputSchema: z.object({})
        }),
        pptist_describe: tool({
          description: "Describe one PPTist command: its payload shape, constraints and notes. Call before executing an unfamiliar command.",
          inputSchema: z.object({ commandType: z.string().min(3).max(80) })
        }),
        pptist_state: tool({
          description: "Read the live editor state: slide count, current slide, selection and viewport.",
          inputSchema: z.object({})
        }),
        pptist_execute: tool({
          description: [
            "Execute PPTist commands against the open deck — this is the main way to edit a presentation.",
            "Pass a list and they run as one batch.",
            "Command types look like 'slides.add', 'elements.updateProps', 'text.setContent', 'animations.add'.",
            "Use pptist_domains and pptist_describe first when unsure of a payload."
          ].join(" "),
          inputSchema: z.object({
            commands: z.array(z.object({
              type: z.string().min(3).max(80),
              payload: z.record(z.string(), z.unknown()).optional()
            })).min(1).max(24)
          })
        }),
        build_presentation_workflow: tool({
          description: "Start a durable, human-reviewed workflow to create or substantially rebuild a presentation.",
          inputSchema: z.object({
            objective: z.string().min(8),
            audience: z.string().optional(),
            slideCount: z.number().int().min(3).max(20).optional(),
            sourceNotes: z.string().optional()
          }),
          execute: async (input) => this.startPptBuildWorkflow(input)
        })
      };
    }

    if (config?.kind === "canvas") {
      return {
        ...common,
        update_canvas_node: tool({
          description: "Update position, size, title, or text of an existing canvas node.",
          inputSchema: z.object({
            nodeId: z.string(),
            title: z.string().optional(),
            text: z.string().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
            rotation: z.number().optional()
          }),
          execute: async ({ nodeId, ...patch }) => this.applyCommands([
            { type: "canvas.update_node", nodeId, patch } as CanvasCommand
          ], `Updated canvas node ${nodeId}`, "agent")
        }),
        add_canvas_note: tool({
          description: "Add an editable text or note node to the canvas.",
          inputSchema: z.object({
            title: z.string(), text: z.string(), x: z.number().default(650), y: z.number().default(80),
            width: z.number().default(320), height: z.number().default(220), type: z.enum(["text", "note"]).default("note")
          }),
          execute: async (input) => this.applyCommands([{
            type: "canvas.add_node",
            node: { id: `node-${crypto.randomUUID()}`, rotation: 0, zIndex: 10, status: "ready", ...input }
          }], `Added canvas note: ${input.title}`, "agent")
        }),
        duplicate_canvas_node: tool({
          description: "Duplicate a selected canvas node as a new independently editable node.",
          inputSchema: z.object({ nodeId: z.string(), offsetX: z.number().default(40), offsetY: z.number().default(40) }),
          execute: async ({ nodeId, offsetX, offsetY }) => {
            const state = await this.getProjectSnapshot();
            if (state.kind !== "canvas") throw new Error("Project kind mismatch");
            const source = state.document.nodes.find((node) => node.id === nodeId);
            if (!source) throw new Error(`Canvas node not found: ${nodeId}`);
            const duplicate: CanvasNode = { ...source, id: `node-${crypto.randomUUID()}`, x: source.x + offsetX, y: source.y + offsetY, title: `${source.title} copy` };
            return this.applyCommands([{ type: "canvas.duplicate_node", nodeId, duplicate }], `Duplicated canvas node ${nodeId}`, "agent");
          }
        }),
        generate_canvas_variants_workflow: tool({
          description: "Start a durable human-reviewed workflow that creates real images with Workers AI and places them on the canvas.",
          inputSchema: z.object({
            objective: z.string().min(8),
            count: z.number().int().min(1).max(6).default(4),
            referenceNodeId: z.string().optional(),
            aspectRatio: z.enum(["1:1", "4:5", "9:16", "16:9"]).default("4:5")
          }),
          execute: async (input) => this.startCanvasVariantsWorkflow(input)
        })
      };
    }
    return common;
  }
}

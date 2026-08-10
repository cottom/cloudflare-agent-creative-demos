import { Session, Think } from "@cloudflare/think";
import { tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { PPT_THEMES } from "../shared/themes";
import type {
  CanvasCommand,
  CanvasNode,
  CanvasVariantsWorkflowParams,
  ChatMessage,
  EditorAwareness,
  JsonObject,
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
import { savePresentationExport } from "./lib/artifacts";
import { workersLanguageModel } from "./lib/ai";
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
    parts: message.parts.map((part) => ({
      type: part.type,
      ...("text" in part && typeof part.text === "string" ? { text: part.text } : {})
    }))
  };
}

const MAX_MUTATION_ATTEMPTS = 4;
/** Per-attempt delay in ms; index 0 is unused because the first try is immediate. */
const BACKOFF_MS = [0, 25, 75, 200];

export function studioAgentName(kind: ProjectKind, projectId: string, sessionId: string): string {
  return `${kind}--${projectId}--${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 180);
}

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
    if (interaction.status !== "pending") return interaction;

    if (interaction.workflowId) {
      await this.approveWorkflow(interaction.workflowId, {
        reason: "Approved from project interaction UI",
        metadata: { interactionId, response }
      });
    } else {
      const messageId = `interaction-response-${interactionId}`;
      await this.submitMessages([{
        id: messageId,
        role: "user",
        parts: [{
          type: "text",
          text: `Structured UI response for interaction ${interactionId}: ${JSON.stringify(response)}. Continue the requested project work using this response.`
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
    if (interaction.status !== "pending") return interaction;
    if (interaction.workflowId) await this.rejectWorkflow(interaction.workflowId, { reason });
    return stub.resolveInteraction(interactionId, { reason }, "cancelled");
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
      request_user_choice: tool({
        description: "Create a structured choice card in the project UI when user input is necessary before proceeding.",
        inputSchema: z.object({
          title: z.string().min(3),
          description: z.string().optional(),
          options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).min(2).max(8),
          multiple: z.boolean().default(false)
        }),
        execute: async ({ title, description, options, multiple }) => {
          const current = this.requireConfig();
          const interaction: ProjectInteraction = {
            id: `agent-interaction-${crypto.randomUUID()}`,
            projectId: current.projectId,
            sessionId: current.sessionId,
            source: "agent",
            kind: multiple ? "multi_select" : "choice",
            title,
            description,
            payload: { options, multiple },
            status: "pending",
            createdAt: new Date().toISOString()
          };
          return this.createWorkflowInteraction(interaction);
        }
      })
    };

    if (config?.kind === "ppt") {
      return {
        ...common,
        update_ppt_slide: tool({
          description: "Update one existing slide. Use the selected slide when the user says this slide.",
          inputSchema: z.object({
            slideId: z.string(),
            title: z.string().optional(),
            subtitle: z.string().optional(),
            body: z.array(z.string()).optional(),
            notes: z.string().optional(),
            layout: z.enum(["title", "statement", "bullets", "two_column", "metrics"]).optional()
          }),
          execute: async ({ slideId, ...patch }) => this.applyCommands([
            { type: "ppt.update_slide", slideId, patch } as PptCommand
          ], `Updated slide ${slideId}`, "agent")
        }),
        add_ppt_slide: tool({
          description: "Add an editable slide to the current presentation.",
          inputSchema: z.object({
            title: z.string(),
            body: z.array(z.string()).min(1),
            subtitle: z.string().optional(),
            notes: z.string().optional(),
            layout: z.enum(["title", "statement", "bullets", "two_column", "metrics"]).default("bullets"),
            index: z.number().int().nonnegative().optional()
          }),
          execute: async ({ index, ...slide }) => this.applyCommands([{
            type: "ppt.add_slide",
            index,
            slide: { id: `slide-${crypto.randomUUID()}`, elements: [], ...slide }
          }], `Added slide: ${slide.title}`, "agent")
        }),
        set_ppt_theme: tool({
          description: "Change the presentation theme without changing slide content.",
          inputSchema: z.object({ themeId: z.enum(["midnight", "editorial", "minimal", "sunrise"]) }),
          execute: async ({ themeId }) => this.applyCommands([
            { type: "ppt.set_theme", theme: PPT_THEMES[themeId] }
          ], `Changed presentation theme to ${themeId}`, "agent")
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

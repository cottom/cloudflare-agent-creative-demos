import { withWorkspace } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";
import { applyMutation } from "../../shared/reducers";
import { createInitialCanvasState, createInitialPptState } from "../../shared/seeds";
import type {
  CanvasProjectState,
  ExportArtifact,
  MutationResult,
  PptProjectState,
  ProjectInteraction,
  ProjectMutation,
  ProjectState,
  SessionMeta,
  WorkflowRun
} from "../../shared/types";

const STATE_KEY = "project:state";
const commandKey = (commandId: string) => `project:command:${commandId}`;

type CommandLedgerEntry = {
  fingerprint: string;
  committedRevision: number;
};

function mutationFingerprint(mutation: ProjectMutation): string {
  return JSON.stringify({
    actor: mutation.actor,
    summary: mutation.summary,
    commands: mutation.commands
  });
}

abstract class ProjectCore<TState extends ProjectState> extends DurableObject<Env> {
  protected abstract createInitialState(projectId?: string): TState;

  async initialize(projectId: string): Promise<TState> {
    const stored = await this.ctx.storage.get<TState>(STATE_KEY);
    if (stored) return structuredClone(stored);
    const initial = this.createInitialState(projectId);
    await this.ctx.storage.put(STATE_KEY, initial);
    return structuredClone(initial);
  }

  protected async ensureState(): Promise<TState> {
    const stored = await this.ctx.storage.get<TState>(STATE_KEY);
    if (stored) return stored;
    const initial = this.createInitialState(this.ctx.id.toString());
    await this.ctx.storage.put(STATE_KEY, initial);
    return initial;
  }

  async getSnapshot(): Promise<TState> {
    return structuredClone(await this.ensureState());
  }

  async applyMutation(mutation: ProjectMutation): Promise<MutationResult<TState>> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = commandKey(mutation.commandId);
      const fingerprint = mutationFingerprint(mutation);
      const existing = await transaction.get<CommandLedgerEntry>(key);
      const state = (await transaction.get<TState>(STATE_KEY)) ?? this.createInitialState(this.ctx.id.toString());
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error(`Command identity reused with different payload: ${mutation.commandId}`);
        }
        return { ok: true, state: structuredClone(state), revision: state.revision };
      }

      const result = applyMutation(state, mutation);
      if (result.ok) {
        await transaction.put(STATE_KEY, result.state);
        await transaction.put(key, {
          fingerprint,
          committedRevision: result.revision
        } satisfies CommandLedgerEntry);
      }
      // A revision conflict is deliberately not ledgered: the same logical command may
      // retry against the latest revision while retaining its idempotency key.
      return structuredClone(result);
    });
  }

  async addSession(session: SessionMeta): Promise<TState> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get<TState>(STATE_KEY)) ?? this.createInitialState(session.projectId);
      const existing = state.sessions.some((item) => item.id === session.id);
      const sessions = existing
        ? state.sessions.map((item) =>
            item.id === session.id
              ? { ...item, updatedAt: session.updatedAt }
              : item
          )
        : [session, ...state.sessions];
      const next = { ...state, sessions, updatedAt: new Date().toISOString() } as TState;
      await transaction.put(STATE_KEY, next);
      return structuredClone(next);
    });
  }

  async renameSession(sessionId: string, title: string): Promise<TState> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get<TState>(STATE_KEY)) ?? this.createInitialState();
      const now = new Date().toISOString();
      const sessions = state.sessions.map((session) =>
        session.id === sessionId ? { ...session, title, updatedAt: now } : session
      );
      const next = { ...state, sessions, updatedAt: now } as TState;
      await transaction.put(STATE_KEY, next);
      return structuredClone(next);
    });
  }

  async createInteraction(interaction: ProjectInteraction): Promise<ProjectInteraction> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get<TState>(STATE_KEY)) ?? this.createInitialState(interaction.projectId);
      const found = state.interactions.find((item) => item.id === interaction.id);
      if (found) return structuredClone(found);
      const next = {
        ...state,
        interactions: [interaction, ...state.interactions],
        updatedAt: new Date().toISOString()
      } as TState;
      await transaction.put(STATE_KEY, next);
      return structuredClone(interaction);
    });
  }

  async resolveInteraction(
    interactionId: string,
    response: Record<string, unknown>,
    status: "resolved" | "cancelled" = "resolved"
  ): Promise<ProjectInteraction> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get<TState>(STATE_KEY)) ?? this.createInitialState();
      const index = state.interactions.findIndex((item) => item.id === interactionId);
      const existing = state.interactions[index];
      if (index < 0 || !existing) throw new Error(`Interaction not found: ${interactionId}`);
      if (existing.status !== "pending") return structuredClone(existing);
      const resolved: ProjectInteraction = {
        ...existing,
        status,
        response,
        resolvedAt: new Date().toISOString()
      };
      const interactions = [...state.interactions];
      interactions[index] = resolved;
      const next = { ...state, interactions, updatedAt: resolved.resolvedAt } as TState;
      await transaction.put(STATE_KEY, next);
      return structuredClone(resolved);
    });
  }

  async getInteraction(interactionId: string): Promise<ProjectInteraction | null> {
    const state = await this.ensureState();
    return structuredClone(state.interactions.find((item) => item.id === interactionId) ?? null);
  }

  async upsertWorkflow(workflow: WorkflowRun): Promise<WorkflowRun> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get<TState>(STATE_KEY)) ?? this.createInitialState(workflow.projectId);
      const workflows = state.workflows.some((item) => item.id === workflow.id)
        ? state.workflows.map((item) => item.id === workflow.id ? workflow : item)
        : [workflow, ...state.workflows];
      const next = {
        ...state,
        workflows: workflows.slice(0, 50),
        updatedAt: new Date().toISOString()
      } as TState;
      await transaction.put(STATE_KEY, next);
      return structuredClone(workflow);
    });
  }

  async addArtifact(artifact: ExportArtifact): Promise<TState> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get<TState>(STATE_KEY)) ?? this.createInitialState();
      const artifacts = [artifact, ...state.artifacts.filter((item) => item.id !== artifact.id)].slice(0, 100);
      const next = { ...state, artifacts, updatedAt: new Date().toISOString() } as TState;
      await transaction.put(STATE_KEY, next);
      return structuredClone(next);
    });
  }

  async getAgentContext(selection?: { ids?: string[]; activeId?: string }): Promise<string> {
    const state = await this.ensureState();
    const selectedIds = new Set(selection?.ids ?? (selection?.activeId ? [selection.activeId] : []));
    if (state.kind === "ppt") {
      const selected = selectedIds.size ? state.document.slides.filter((slide) => selectedIds.has(slide.id)) : [];
      return JSON.stringify({
        project: {
          id: state.id,
          kind: state.kind,
          name: state.name,
          revision: state.revision,
          title: state.document.title,
          objective: state.document.objective,
          audience: state.document.audience,
          theme: state.document.theme,
          slides: state.document.slides.map((slide, index) => ({
            index: index + 1,
            id: slide.id,
            title: slide.title,
            layout: slide.layout,
            bodyPreview: slide.body.slice(0, 4)
          }))
        },
        selection: selected
      });
    }
    const selected = selectedIds.size ? state.document.nodes.filter((node) => selectedIds.has(node.id)) : [];
    return JSON.stringify({
      project: {
        id: state.id,
        kind: state.kind,
        name: state.name,
        revision: state.revision,
        title: state.document.title,
        canvas: { width: state.document.width, height: state.document.height, background: state.document.background },
        nodes: state.document.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          title: node.title,
          text: node.text,
          prompt: node.prompt,
          status: node.status,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height
        }))
      },
      selection: selected
    });
  }

  async health() {
    const state = await this.ensureState();
    return { ok: true, projectId: state.id, kind: state.kind, revision: state.revision };
  }
}

class PptProjectCore extends ProjectCore<PptProjectState> {
  protected createInitialState(projectId?: string): PptProjectState {
    return createInitialPptState(projectId ?? this.ctx.id.toString());
  }
}

class CanvasProjectCore extends ProjectCore<CanvasProjectState> {
  protected createInitialState(projectId?: string): CanvasProjectState {
    return createInitialCanvasState(projectId ?? this.ctx.id.toString());
  }
}

export class PptProject extends withWorkspace(PptProjectCore, (self) => ({ storage: self.ctx.storage })) {}
export class CanvasProject extends withWorkspace(CanvasProjectCore, (self) => ({ storage: self.ctx.storage })) {}

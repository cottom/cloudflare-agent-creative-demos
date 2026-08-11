import { withWorkspace, type WorkspaceOptions } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";
import { applyMutation } from "../../shared/reducers";
import {
  pptistDeckFromLegacy,
  pptistSlideTitle,
  PPTIST_VIEWPORT_RATIO,
  PPTIST_VIEWPORT_SIZE
} from "../../shared/pptist";
import { createInitialCanvasState, createInitialPptState } from "../../shared/seeds";
import type {
  CanvasProjectState,
  ExportArtifact,
  JsonObject,
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

/** States persisted before `stateVersion` existed read back as `undefined`. */
function stateVersionOf(state: { stateVersion?: number }): number {
  return typeof state.stateVersion === "number" ? state.stateVersion : 0;
}

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

  /**
   * `withWorkspace` needs the DO's storage from outside the class, but `ctx` is
   * protected on `DurableObject`. This is the one sanctioned seam.
   */
  get workspaceStorage(): DurableObjectStorage {
    return this.ctx.storage;
  }

  /**
   * Upgrade state written before PPTist became the canonical model.
   *
   * Applied on every read path, and persisted the first time it fires, so a
   * project opened after the change is migrated exactly once.
   */
  private async migrate(state: TState): Promise<TState> {
    if (state.kind !== "ppt") return state;
    const document = state.document as { deck?: unknown };
    if (document.deck) return state;
    const migrated = {
      ...state,
      document: { ...state.document, deck: pptistDeckFromLegacy(state.document as never) }
    } as TState;
    await this.ctx.storage.put(STATE_KEY, migrated);
    return migrated;
  }

  async initialize(projectId: string): Promise<TState> {
    const stored = await this.ctx.storage.get<TState>(STATE_KEY);
    if (stored) return structuredClone(await this.migrate(stored));
    const initial = this.createInitialState(projectId);
    await this.ctx.storage.put(STATE_KEY, initial);
    return structuredClone(initial);
  }

  protected async ensureState(): Promise<TState> {
    const stored = await this.ctx.storage.get<TState>(STATE_KEY);
    if (stored) return this.migrate(stored);
    const initial = this.createInitialState(this.ctx.id.toString());
    await this.ctx.storage.put(STATE_KEY, initial);
    return initial;
  }

  async getSnapshot(): Promise<TState> {
    return structuredClone(await this.ensureState());
  }

  /**
   * Cheap change check for pollers: avoids cloning and RPC-serializing the
   * whole project just to discover nothing moved.
   *
   * Returns `stateVersion`, not `revision`. Interactions, workflow progress,
   * sessions and artifacts all change state without advancing the document
   * revision, and a poller guarding on `revision` would never see them.
   */
  async getStateVersion(): Promise<number> {
    return stateVersionOf(await this.ensureState());
  }

  /**
   * Single write path for project state. Every mutation — document edit or
   * not — advances `stateVersion` so pollers and clients observe it.
   */
  private async putState<T extends TState>(
    transaction: { put(key: string, value: unknown): Promise<void> },
    next: T
  ): Promise<T> {
    const versioned = { ...next, stateVersion: stateVersionOf(next) + 1 } as T;
    await transaction.put(STATE_KEY, versioned);
    return versioned;
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
        result.state = await this.putState(transaction, result.state);
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
      return structuredClone(await this.putState(transaction, next));
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
      return structuredClone(await this.putState(transaction, next));
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
      await this.putState(transaction, next);
      return structuredClone(interaction);
    });
  }

  async resolveInteraction(
    interactionId: string,
    response: JsonObject,
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
      await this.putState(transaction, next);
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
      await this.putState(transaction, next);
      return structuredClone(workflow);
    });
  }

  async addArtifact(artifact: ExportArtifact): Promise<TState> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get<TState>(STATE_KEY)) ?? this.createInitialState();
      const artifacts = [artifact, ...state.artifacts.filter((item) => item.id !== artifact.id)].slice(0, 100);
      const next = { ...state, artifacts, updatedAt: new Date().toISOString() } as TState;
      return structuredClone(await this.putState(transaction, next));
    });
  }

  async getAgentContext(selection?: { ids?: string[]; activeId?: string }): Promise<string> {
    const state = await this.ensureState();
    const selectedIds = new Set(selection?.ids ?? (selection?.activeId ? [selection.activeId] : []));
    if (state.kind === "ppt") {
      const deck = state.document.deck;
      const selected = selectedIds.size
        ? deck.slides.filter((slide) => selectedIds.has(slide.id))
        : [];
      return JSON.stringify({
        project: {
          id: state.id,
          kind: state.kind,
          name: state.name,
          revision: state.revision,
          title: state.document.title,
          objective: state.document.objective,
          audience: state.document.audience,
          // The deck is PPTist's model. Only a summary is sent: full element
          // JSON would dominate the context, and the agent reads live detail
          // through the PPTist bridge instead.
          editor: "pptist",
          viewport: { width: PPTIST_VIEWPORT_SIZE, ratio: PPTIST_VIEWPORT_RATIO },
          theme: deck.theme,
          slideCount: deck.slides.length,
          slides: deck.slides.map((slide, index) => ({
            index: index + 1,
            id: slide.id,
            type: slide.type,
            title: pptistSlideTitle(slide),
            elementCount: slide.elements.length,
            elementTypes: [...new Set(slide.elements.map((element) => element.type))],
            remark: slide.remark?.slice(0, 200)
          }))
        },
        selection: selected.map((slide) => ({ id: slide.id, title: pptistSlideTitle(slide) }))
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

/**
 * `@cloudflare/computer` declares `sql.exec<Row extends object>()` while the
 * runtime's `SqlStorage` constrains rows to `Record<string, SqlStorageValue>`.
 * The two are structurally compatible at runtime but not assignable in either
 * direction, so the storage handle is narrowed at this single seam.
 */
const workspaceStorageOf = (self: { workspaceStorage: DurableObjectStorage }) =>
  ({ storage: self.workspaceStorage as WorkspaceOptions["storage"] });

export class PptProject extends withWorkspace(PptProjectCore, workspaceStorageOf) {}
export class CanvasProject extends withWorkspace(CanvasProjectCore, workspaceStorageOf) {}

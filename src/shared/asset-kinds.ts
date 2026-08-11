import { applyCanvasCommands, applyPptCommands } from "./reducers";
import { createInitialCanvasState, createInitialPptState } from "./seeds";
import { pptistSlideTitle, PPTIST_VIEWPORT_RATIO, PPTIST_VIEWPORT_SIZE } from "./pptist";
import type {
  CanvasCommand,
  CanvasProjectState,
  PptCommand,
  JsonObject,
  PptProjectState,
  ProjectCommand,
  ProjectState
} from "./types";

/**
 * The asset-kind registry.
 *
 * Adding a new kind of asset used to mean editing five files — the reducer
 * switch, the seed factory, the Durable Object class list, the agent's tool
 * selection and the API's kind parser. Each was a separate place to forget.
 * A kind is now one entry here, and every layer reads this table.
 *
 * Durable Object classes are bound statically in Wrangler config and cannot be
 * created per kind at runtime, so kinds share a single Project object keyed by
 * `${kind}:${projectId}`. That is the constraint this registry is designed
 * around, not a limitation of it.
 */

export type AssetKindId = string;

export type AgentSelection = { ids?: string[]; activeId?: string };

export type AssetKindDefinition<
  TState extends ProjectState = ProjectState,
  TCommand extends ProjectCommand = ProjectCommand
> = {
  id: AssetKindId;
  /** Shown in pickers and used in generated copy. */
  label: string;
  description: string;
  /** Seed state for a brand-new project of this kind. */
  createInitialState: (projectId: string) => TState;
  /** Pure reducer for this kind's commands. */
  applyCommands: (state: TState, commands: TCommand[]) => TState;
  /** Compact, token-aware view of the asset for the agent's context window. */
  summarizeForAgent: (state: TState, selection: AgentSelection) => JsonObject;
  /** Workflow ids this kind can start. Validated by the API before dispatch. */
  workflows: string[];
  /** Prefix for this kind's R2 artifacts, so storage stays partitioned. */
  artifactPrefix: string;
};

function selectedIds(selection: AgentSelection): Set<string> {
  return new Set(selection.ids ?? (selection.activeId ? [selection.activeId] : []));
}

const pptKind: AssetKindDefinition<PptProjectState, PptCommand> = {
  id: "ppt",
  label: "Presentation",
  description: "Slide deck edited in PPTist, exportable to .pptx",
  createInitialState: createInitialPptState,
  applyCommands: applyPptCommands,
  workflows: ["ppt-build"],
  artifactPrefix: "ppt",
  summarizeForAgent: (state, selection) => {
    const deck = state.document.deck;
    const ids = selectedIds(selection);
    return {
      editor: "pptist",
      viewport: { width: PPTIST_VIEWPORT_SIZE, ratio: PPTIST_VIEWPORT_RATIO },
      title: state.document.title,
      objective: state.document.objective,
      audience: state.document.audience,
      slideCount: deck.slides.length,
      // Only a summary: full element JSON would dominate the context window,
      // and the agent reads live detail through the PPTist bridge instead.
      slides: deck.slides.map((slide, index) => ({
        index: index + 1,
        id: slide.id,
        title: pptistSlideTitle(slide),
        elementCount: slide.elements.length,
        elementTypes: [...new Set(slide.elements.map((element) => element.type))],
        selected: ids.has(slide.id)
      }))
    };
  }
};

const canvasKind: AssetKindDefinition<CanvasProjectState, CanvasCommand> = {
  id: "canvas",
  label: "Media canvas",
  description: "Freeform canvas with AI-generated imagery",
  createInitialState: createInitialCanvasState,
  applyCommands: applyCanvasCommands,
  workflows: ["canvas-variants"],
  artifactPrefix: "canvas",
  summarizeForAgent: (state, selection) => {
    const ids = selectedIds(selection);
    return {
      title: state.document.title,
      canvas: {
        width: state.document.width,
        height: state.document.height,
        background: state.document.background
      },
      nodes: state.document.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        text: node.text ?? null,
        status: node.status ?? null,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        selected: ids.has(node.id)
      }))
    };
  }
};

const REGISTRY = new Map<AssetKindId, AssetKindDefinition>([
  [pptKind.id, pptKind as AssetKindDefinition],
  [canvasKind.id, canvasKind as AssetKindDefinition]
]);

export function registerAssetKind(definition: AssetKindDefinition): void {
  REGISTRY.set(definition.id, definition);
}

export function getAssetKind(id: string): AssetKindDefinition | undefined {
  return REGISTRY.get(id);
}

/** Throwing variant for request paths, where an unknown kind is a 404. */
export function requireAssetKind(id: string): AssetKindDefinition {
  const kind = REGISTRY.get(id);
  if (!kind) throw new Error(`Unknown asset kind: ${id}`);
  return kind;
}

export function listAssetKinds(): AssetKindDefinition[] {
  return [...REGISTRY.values()];
}

export function isAssetKind(id: string): boolean {
  return REGISTRY.has(id);
}

/**
 * Durable Object name for a project.
 *
 * Tenant first so one tenant can never address another's object, kind second
 * so the same project id may exist independently per kind.
 */
export function projectObjectName(tenantId: string, kind: string, projectId: string): string {
  return `${tenantId}:${kind}:${projectId}`;
}

/** Whether a kind can start a given workflow — checked before dispatch. */
export function kindSupportsWorkflow(kind: string, workflowId: string): boolean {
  return REGISTRY.get(kind)?.workflows.includes(workflowId) ?? false;
}

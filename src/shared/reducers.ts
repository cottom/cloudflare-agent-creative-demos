import type {
  ActivityEvent,
  CanvasCommand,
  CanvasProjectState,
  MutationResult,
  PptCommand,
  PptProjectState,
  ProjectMutation,
  ProjectState
} from "./types";

function assertNever(value: never): never {
  throw new Error(`Unhandled command: ${JSON.stringify(value)}`);
}

function appendActivity<T extends ProjectState>(
  state: T,
  mutation: ProjectMutation,
  revision: number,
  now: string
): T {
  const event: ActivityEvent = {
    id: mutation.commandId,
    revision,
    actor: mutation.actor,
    summary: mutation.summary,
    createdAt: now
  };
  return {
    ...state,
    revision,
    updatedAt: now,
    activity: [event, ...state.activity].slice(0, 100)
  } as T;
}

export function applyPptCommands(state: PptProjectState, commands: PptCommand[]): PptProjectState {
  const next = structuredClone(state);
  for (const command of commands) {
    switch (command.type) {
      case "ppt.replace_document":
        next.document = structuredClone(command.document);
        break;
      case "ppt.set_deck": {
        // PPTist owns composition. The editor hands back a whole deck, so this
        // is a wholesale swap rather than a per-element patch.
        if (!command.deck.slides.length) throw new Error("A presentation must contain at least one slide");
        next.document.deck = structuredClone(command.deck);
        if (command.deck.title) next.document.title = command.deck.title;
        break;
      }
      case "ppt.set_meta":
        next.document = { ...next.document, ...structuredClone(command.patch) };
        if (command.patch.title) next.document.deck.title = command.patch.title;
        break;
      default:
        assertNever(command);
    }
  }
  return next;
}

export function applyCanvasCommands(state: CanvasProjectState, commands: CanvasCommand[]): CanvasProjectState {
  const next = structuredClone(state);
  for (const command of commands) {
    switch (command.type) {
      case "canvas.replace_document":
        next.document = structuredClone(command.document);
        break;
      case "canvas.add_node":
        if (next.document.nodes.some((node) => node.id === command.node.id)) throw new Error(`Canvas node exists: ${command.node.id}`);
        next.document.nodes.push(structuredClone(command.node));
        break;
      case "canvas.update_node": {
        const index = next.document.nodes.findIndex((node) => node.id === command.nodeId);
        const current = next.document.nodes[index];
        if (index < 0 || !current) throw new Error(`Canvas node not found: ${command.nodeId}`);
        next.document.nodes[index] = { ...current, ...structuredClone(command.patch), id: current.id };
        break;
      }
      case "canvas.delete_node":
        next.document.nodes = next.document.nodes.filter((node) => node.id !== command.nodeId && node.parentId !== command.nodeId);
        break;
      case "canvas.duplicate_node":
        if (!next.document.nodes.some((node) => node.id === command.nodeId)) throw new Error(`Canvas node not found: ${command.nodeId}`);
        if (next.document.nodes.some((node) => node.id === command.duplicate.id)) throw new Error(`Canvas node exists: ${command.duplicate.id}`);
        next.document.nodes.push(structuredClone(command.duplicate));
        break;
      case "canvas.set_generated_asset": {
        const index = next.document.nodes.findIndex((node) => node.id === command.nodeId);
        const current = next.document.nodes[index];
        if (index < 0 || !current) throw new Error(`Canvas node not found: ${command.nodeId}`);
        next.document.nodes[index] = {
          ...current,
          type: "image",
          assetKey: command.assetKey,
          prompt: command.prompt,
          status: command.status
        };
        break;
      }
      default:
        assertNever(command);
    }
  }
  return next;
}

export function applyMutation<T extends ProjectState>(state: T, mutation: ProjectMutation, now = new Date().toISOString()): MutationResult<T> {
  if (mutation.baseRevision !== state.revision) {
    return { ok: false, code: "REVISION_CONFLICT", currentRevision: state.revision, state };
  }
  const nextRevision = state.revision + 1;
  if (state.kind === "ppt") {
    const next = appendActivity(applyPptCommands(state, mutation.commands as PptCommand[]), mutation, nextRevision, now);
    return { ok: true, state: next as T, revision: nextRevision };
  }
  const next = appendActivity(applyCanvasCommands(state, mutation.commands as CanvasCommand[]), mutation, nextRevision, now);
  return { ok: true, state: next as T, revision: nextRevision };
}

import {
  SLIDE_HEIGHT_IN,
  SLIDE_WIDTH_IN
} from "./types";
import type {
  ActivityEvent,
  CanvasCommand,
  CanvasProjectState,
  MutationResult,
  PptCommand,
  PptProjectState,
  ProjectMutation,
  ProjectState,
  SlideElement
} from "./types";

function assertNever(value: never): never {
  throw new Error(`Unhandled command: ${JSON.stringify(value)}`);
}

function requireSlide(state: PptProjectState, slideId: string) {
  const slide = state.document.slides.find((item) => item.id === slideId);
  if (!slide) throw new Error(`Slide not found: ${slideId}`);
  return slide;
}

/**
 * Keep an element inside the slide and at a usable size.
 *
 * A drag or a model-authored value can otherwise place an element off-canvas
 * where it is unreachable in the editor but still present in the export.
 */
function clampElement(element: SlideElement): SlideElement {
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  const w = Math.min(Math.max(finite(element.w, 1), MIN_ELEMENT_IN), SLIDE_WIDTH_IN);
  const h = Math.min(Math.max(finite(element.h, 0.5), MIN_ELEMENT_IN), SLIDE_HEIGHT_IN);
  return {
    ...element,
    w,
    h,
    x: Math.min(Math.max(finite(element.x, 0), -w / 2), SLIDE_WIDTH_IN - w / 2),
    y: Math.min(Math.max(finite(element.y, 0), -h / 2), SLIDE_HEIGHT_IN - h / 2),
    rotation: finite(element.rotation, 0) % 360,
    z: Math.round(finite(element.z, 0))
  };
}

/** Smallest element the resize handles can still be grabbed on. */
const MIN_ELEMENT_IN = 0.15;

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
      case "ppt.add_slide": {
        const index = command.index ?? next.document.slides.length;
        next.document.slides.splice(Math.max(0, Math.min(index, next.document.slides.length)), 0, structuredClone(command.slide));
        break;
      }
      case "ppt.update_slide": {
        const index = next.document.slides.findIndex((slide) => slide.id === command.slideId);
        const current = next.document.slides[index];
        if (index < 0 || !current) throw new Error(`Slide not found: ${command.slideId}`);
        next.document.slides[index] = { ...current, ...structuredClone(command.patch), id: current.id };
        break;
      }
      case "ppt.delete_slide":
        next.document.slides = next.document.slides.filter((slide) => slide.id !== command.slideId);
        if (next.document.slides.length === 0) throw new Error("A presentation must contain at least one slide");
        break;
      case "ppt.reorder_slides": {
        if (command.slideIds.length !== next.document.slides.length || new Set(command.slideIds).size !== command.slideIds.length) {
          throw new Error("Reorder must include every slide exactly once");
        }
        const byId = new Map(next.document.slides.map((slide) => [slide.id, slide]));
        next.document.slides = command.slideIds.map((id) => {
          const found = byId.get(id);
          if (!found) throw new Error(`Slide not found in reorder: ${id}`);
          return found;
        });
        break;
      }
      case "ppt.set_theme":
        next.document.theme = structuredClone(command.theme);
        break;
      case "ppt.add_element": {
        const slide = requireSlide(next, command.slideId);
        if (slide.elements.some((element) => element.id === command.element.id)) {
          throw new Error(`Slide element exists: ${command.element.id}`);
        }
        slide.elements.push(structuredClone(command.element));
        break;
      }
      case "ppt.update_element": {
        const slide = requireSlide(next, command.slideId);
        const index = slide.elements.findIndex((element) => element.id === command.elementId);
        const current = slide.elements[index];
        if (index < 0 || !current) throw new Error(`Slide element not found: ${command.elementId}`);
        // `id` and `type` are re-pinned: a patch may not turn a text box into
        // an image, and geometry stays finite so a bad drag cannot corrupt state.
        slide.elements[index] = clampElement({
          ...current,
          ...structuredClone(command.patch),
          id: current.id,
          type: current.type
        } as SlideElement);
        break;
      }
      case "ppt.delete_element": {
        const slide = requireSlide(next, command.slideId);
        const before = slide.elements.length;
        slide.elements = slide.elements.filter((element) => element.id !== command.elementId);
        if (slide.elements.length === before) throw new Error(`Slide element not found: ${command.elementId}`);
        break;
      }
      case "ppt.set_element_order": {
        const slide = requireSlide(next, command.slideId);
        const target = slide.elements.find((element) => element.id === command.elementId);
        if (!target) throw new Error(`Slide element not found: ${command.elementId}`);
        target.z = command.z;
        break;
      }
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

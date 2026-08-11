import { describe, expect, it } from "vitest";
import { applyMutation } from "../src/shared/reducers";
import { createInitialCanvasState, createInitialPptState } from "../src/shared/seeds";
import type { ProjectMutation } from "../src/shared/types";

function mutation(overrides: Partial<ProjectMutation>): ProjectMutation {
  return {
    commandId: "command-1",
    baseRevision: 1,
    actor: { type: "user", id: "test-user" },
    summary: "Test mutation",
    commands: [],
    ...overrides
  };
}

describe("project mutation contract", () => {
  it("applies a PPT edit without mutating the previous state", () => {
    const state = createInitialPptState("ppt-test");
    const result = applyMutation(state, mutation({
      commands: [{
        type: "ppt.update_slide",
        slideId: "slide-1",
        patch: { title: "A revised claim" }
      }]
    }), "2026-08-10T00:00:00.000Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.revision).toBe(2);
    expect(result.state.document.slides[0]?.title).toBe("A revised claim");
    expect(state.document.slides[0]?.title).not.toBe("A revised claim");
    expect(result.state.activity[0]?.summary).toBe("Test mutation");
  });

  it("rejects stale revisions with the latest state", () => {
    const state = createInitialPptState("ppt-test");
    const result = applyMutation(state, mutation({ baseRevision: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("REVISION_CONFLICT");
    expect(result.currentRevision).toBe(1);
    expect(result.state.id).toBe("ppt-test");
  });

  it("duplicates and then deletes independent canvas nodes", () => {
    const state = createInitialCanvasState("canvas-test");
    const source = state.document.nodes.find((node) => node.id === "note-brief");
    expect(source).toBeTruthy();
    if (!source) return;

    const duplicate = {
      ...source,
      id: "note-brief-copy",
      x: source.x + 40,
      y: source.y + 40,
      parentId: undefined
    };
    const duplicated = applyMutation(state, mutation({
      commands: [{ type: "canvas.duplicate_node", nodeId: source.id, duplicate }]
    }));
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.state.document.nodes.some((node) => node.id === duplicate.id)).toBe(true);

    const deleted = applyMutation(duplicated.state, mutation({
      commandId: "command-2",
      baseRevision: 2,
      commands: [{ type: "canvas.delete_node", nodeId: duplicate.id }]
    }));
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.state.document.nodes.some((node) => node.id === duplicate.id)).toBe(false);
    expect(deleted.state.document.nodes.some((node) => node.id === source.id)).toBe(true);
  });

  it("does not allow deleting the final presentation slide", () => {
    const state = createInitialPptState("ppt-test");
    state.document.slides = [state.document.slides[0]!];
    expect(() => applyMutation(state, mutation({
      commands: [{ type: "ppt.delete_slide", slideId: "slide-1" }]
    }))).toThrow("at least one slide");
  });
});

describe("slide element editing", () => {
  const seed = () => {
    const state = createInitialPptState("ppt-elements");
    const slide = state.document.slides[0]!;
    slide.elements = [
      { id: "el-a", type: "shape", shape: "rect", x: 1, y: 1, w: 2, h: 1, rotation: 0, z: 1, fill: "5B6CFF" },
      { id: "el-b", type: "text", text: "Hello", role: "body", fontSize: 18, x: 2, y: 2, w: 4, h: 1, rotation: 0, z: 2 }
    ];
    return { state, slideId: slide.id };
  };

  it("adds an element and rejects a duplicate id", () => {
    const { state, slideId } = seed();
    const added = applyMutation(state, mutation({
      commands: [{
        type: "ppt.add_element",
        slideId,
        element: { id: "el-c", type: "text", text: "New", role: "body", fontSize: 12, x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 3 }
      }]
    }));
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.state.document.slides[0]?.elements).toHaveLength(3);

    expect(() => applyMutation(added.state, mutation({
      commandId: "command-dup",
      baseRevision: 2,
      commands: [{
        type: "ppt.add_element",
        slideId,
        element: { id: "el-c", type: "text", text: "Dup", role: "body", fontSize: 12, x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 4 }
      }]
    }))).toThrow("Slide element exists");
  });

  it("patches an element without changing its id or type", () => {
    const { state, slideId } = seed();
    const result = applyMutation(state, mutation({
      commands: [{ type: "ppt.update_element", slideId, elementId: "el-b", patch: { text: "Edited", bold: true, type: "shape" } as never }]
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.state.document.slides[0]?.elements.find((item) => item.id === "el-b");
    expect(element?.type).toBe("text");
    if (element?.type !== "text") return;
    expect(element.text).toBe("Edited");
    expect(element.bold).toBe(true);
  });

  it("clamps geometry so an element cannot be dragged off the slide", () => {
    const { state, slideId } = seed();
    const result = applyMutation(state, mutation({
      commands: [{ type: "ppt.update_element", slideId, elementId: "el-a", patch: { x: 999, y: -999, w: 0.01 } }]
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.state.document.slides[0]?.elements.find((item) => item.id === "el-a")!;
    expect(element.w).toBeGreaterThanOrEqual(0.15);
    expect(element.x).toBeLessThanOrEqual(13.333);
    expect(element.y).toBeGreaterThanOrEqual(-element.h / 2);
  });

  it("reorders and deletes elements", () => {
    const { state, slideId } = seed();
    const ordered = applyMutation(state, mutation({
      commands: [{ type: "ppt.set_element_order", slideId, elementId: "el-a", z: 9 }]
    }));
    expect(ordered.ok).toBe(true);
    if (!ordered.ok) return;
    expect(ordered.state.document.slides[0]?.elements.find((item) => item.id === "el-a")?.z).toBe(9);

    const deleted = applyMutation(ordered.state, mutation({
      commandId: "command-del", baseRevision: 2,
      commands: [{ type: "ppt.delete_element", slideId, elementId: "el-a" }]
    }));
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.state.document.slides[0]?.elements).toHaveLength(1);

    expect(() => applyMutation(deleted.state, mutation({
      commandId: "command-del2", baseRevision: 3,
      commands: [{ type: "ppt.delete_element", slideId, elementId: "missing" }]
    }))).toThrow("Slide element not found");
  });
});

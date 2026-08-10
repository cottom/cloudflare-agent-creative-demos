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

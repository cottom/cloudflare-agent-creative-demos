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
  it("replaces the PPTist deck without mutating the previous state", () => {
    const state = createInitialPptState("ppt-test");
    const before = state.document.deck.slides.length;
    const deck = structuredClone(state.document.deck);
    deck.slides = deck.slides.slice(0, 1);
    deck.title = "Trimmed deck";

    const result = applyMutation(state, mutation({
      commands: [{ type: "ppt.set_deck", deck }]
    }), "2026-08-10T00:00:00.000Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.revision).toBe(2);
    expect(result.state.document.deck.slides).toHaveLength(1);
    expect(result.state.document.title).toBe("Trimmed deck");
    // The reducer must clone: the input state keeps its original deck.
    expect(state.document.deck.slides).toHaveLength(before);
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

  it("refuses a deck with no slides", () => {
    const state = createInitialPptState("ppt-test");
    const deck = structuredClone(state.document.deck);
    deck.slides = [];
    expect(() => applyMutation(state, mutation({
      commands: [{ type: "ppt.set_deck", deck }]
    }))).toThrow("at least one slide");
  });

  it("updates project metadata and keeps the deck title in step", () => {
    const state = createInitialPptState("ppt-test");
    const result = applyMutation(state, mutation({
      commands: [{ type: "ppt.set_meta", patch: { title: "Renamed", audience: "Board" } }]
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.document.title).toBe("Renamed");
    expect(result.state.document.audience).toBe("Board");
    expect(result.state.document.deck.title).toBe("Renamed");
  });
});


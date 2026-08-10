import { describe, expect, it } from "vitest";
import { createInitialCanvasState, createInitialPptState } from "../src/shared/seeds";

describe("demo project seeds", () => {
  it("creates a project-owned presentation and session", () => {
    const project = createInitialPptState("ppt-seed");
    expect(project.id).toBe("ppt-seed");
    expect(project.kind).toBe("ppt");
    expect(project.document.slides.length).toBeGreaterThanOrEqual(3);
    expect(project.sessions[0]?.projectId).toBe(project.id);
    expect(project.artifacts).toEqual([]);
  });

  it("creates an editable canvas with a brief", () => {
    const project = createInitialCanvasState("canvas-seed");
    expect(project.document.nodes.some((node) => node.id === "note-brief")).toBe(true);
    expect(project.document.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });
});

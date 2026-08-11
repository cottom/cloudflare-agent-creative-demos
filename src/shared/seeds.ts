import { PPT_THEMES } from "./themes";
import type { CanvasProjectState, PptProjectState, PptSlide, SessionMeta } from "./types";

const now = () => new Date().toISOString();

export function createInitialSession(
  projectId: string,
  kind: "ppt" | "canvas",
  id = `${kind}-session-main`
): SessionMeta {
  const timestamp = now();
  return {
    id,
    projectId,
    kind,
    title: "Main Agent Session",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function slide(id: string, title: string, body: string[], layout: PptSlide["layout"]): PptSlide {
  return { id, title, body, layout, elements: [] };
}

export function createInitialPptState(id = "ppt-demo"): PptProjectState {
  const timestamp = now();
  return {
    id,
    kind: "ppt",
    name: "AI Product Strategy Deck",
    revision: 1,
    stateVersion: 1,
    sessions: [createInitialSession(id, "ppt")],
    interactions: [],
    workflows: [],
    artifacts: [],
    activity: [{
      id: crypto.randomUUID(),
      revision: 1,
      actor: { type: "system", id: "bootstrap" },
      summary: "Created presentation project",
      createdAt: timestamp
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
    document: {
      title: "AI Product Strategy",
      objective: "Explain the opportunity and align the team on execution",
      audience: "Product and executive team",
      theme: PPT_THEMES.midnight,
      slides: [
        slide("slide-1", "AI-native creation is becoming a workspace", [
          "Projects persist longer than conversations",
          "Agents, workflows, and humans edit one canonical asset",
          "Every change is versioned and reversible"
        ], "statement"),
        slide("slide-2", "The operating model", [
          "Agent chooses the right action or workflow",
          "Workflow owns retries, waits, approvals, and fan-out",
          "Project owns the editable result"
        ], "bullets"),
        slide("slide-3", "Cloudflare-native control plane", [
          "Durable Objects for project and session state",
          "Workflows for long-running generation",
          "Computer Workspace for project files",
          "Workers AI and R2 for real generation and artifacts"
        ], "two_column")
      ]
    }
  };
}

export function createInitialCanvasState(id = "canvas-demo"): CanvasProjectState {
  const timestamp = now();
  return {
    id,
    kind: "canvas",
    name: "Creative Campaign Canvas",
    revision: 1,
    stateVersion: 1,
    sessions: [createInitialSession(id, "canvas")],
    interactions: [],
    workflows: [],
    artifacts: [],
    activity: [{
      id: crypto.randomUUID(),
      revision: 1,
      actor: { type: "system", id: "bootstrap" },
      summary: "Created media canvas project",
      createdAt: timestamp
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
    document: {
      title: "Launch Campaign Concepts",
      width: 1800,
      height: 1200,
      background: "#edf1f7",
      nodes: [
        {
          id: "frame-brief",
          type: "frame",
          x: 80,
          y: 80,
          width: 480,
          height: 430,
          rotation: 0,
          zIndex: 0,
          title: "Creative brief",
          status: "ready"
        },
        {
          id: "note-brief",
          type: "note",
          x: 115,
          y: 130,
          width: 410,
          height: 230,
          rotation: 0,
          zIndex: 2,
          title: "Launch direction",
          text: "Create a bold launch campaign for an AI video editor. Audience: small creative teams. Outcome: four distinct visual territories.",
          status: "ready",
          parentId: "frame-brief"
        },
        {
          id: "note-agent",
          type: "text",
          x: 115,
          y: 390,
          width: 410,
          height: 70,
          rotation: 0,
          zIndex: 2,
          title: "Try the Agent",
          text: "Ask: Generate four premium 4:5 launch concepts from this brief.",
          status: "ready",
          parentId: "frame-brief"
        }
      ]
    }
  };
}

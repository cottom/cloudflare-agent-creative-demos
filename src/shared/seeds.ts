import {
  createPptistTheme,
  pptistElementId,
  pptistSlideId,
  PPTIST_VIEWPORT_SIZE,
  type PptistSlide
} from "./pptist";
import type { CanvasProjectState, PptProjectState, SessionMeta } from "./types";

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

/** Stage is 1000 x 562.5 px; these offsets keep the seed inside it. */
const STAGE_W = PPTIST_VIEWPORT_SIZE;

function textSlide(title: string, body: string[]): PptistSlide {
  return {
    id: pptistSlideId(),
    type: "content",
    elements: [
      {
        id: pptistElementId(),
        type: "text",
        left: 70,
        top: 68,
        width: STAGE_W - 140,
        height: 78,
        rotate: 0,
        // PPTist stores rich text as HTML.
        content: `<p style="font-size:32px"><strong>${title}</strong></p>`,
        defaultFontName: "Aptos",
        defaultColor: "#111827"
      },
      {
        id: pptistElementId(),
        type: "text",
        left: 70,
        top: 175,
        width: STAGE_W - 140,
        height: 250,
        rotate: 0,
        content: body.map((line) => `<li>${line}</li>`).join(""),
        defaultFontName: "Aptos",
        defaultColor: "#334155"
      }
    ]
  };
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
      deck: {
        title: "AI Product Strategy",
        theme: createPptistTheme(),
        slides: [
          textSlide("AI-native creation is becoming a workspace", [
            "Projects persist longer than conversations",
            "Agents, workflows, and humans edit one canonical asset",
            "Every change is versioned and reversible"
          ]),
          textSlide("The operating model", [
            "Agent chooses the right action or workflow",
            "Workflow owns retries, waits, approvals, and fan-out",
            "Project owns the editable result"
          ]),
          textSlide("Cloudflare-native control plane", [
            "Durable Objects for project and session state",
            "Workflows for long-running generation",
            "Computer Workspace for project files",
            "Workers AI and R2 for real generation and artifacts"
          ])
        ]
      }
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

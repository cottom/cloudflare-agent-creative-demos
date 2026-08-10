import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CanvasCommand,
  CanvasProjectState,
  EditorAwareness,
  JsonObject,
  PptCommand,
  PptProjectState,
  ProjectCommand,
  ProjectKind,
  ProjectState
} from "../shared/types";
import { AgentPanel } from "./components/AgentPanel";
import { CanvasStudio } from "./components/CanvasStudio";
import { PptStudio } from "./components/PptStudio";
import { api, type ClientMessage } from "./lib/api";
import { usePolling } from "./lib/usePolling";

type ProjectMap = { ppt: PptProjectState; canvas: CanvasProjectState };
type WorkspaceEntry = { path: string; name: string; isDirectory: boolean };

export default function App() {
  const [activeKind, setActiveKind] = useState<ProjectKind>("ppt");
  const [projects, setProjects] = useState<ProjectMap | null>(null);
  const [activeSessions, setActiveSessions] = useState<Record<ProjectKind, string>>({ ppt: "ppt-session-main", canvas: "canvas-session-main" });
  const [selected, setSelected] = useState<Record<ProjectKind, string | undefined>>({ ppt: undefined, canvas: undefined });
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [models, setModels] = useState({ llm: "Workers AI", image: "Workers AI" });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<Record<ProjectKind, WorkspaceEntry[]>>({ ppt: [], canvas: [] });
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  const activeProject = projects?.[activeKind];
  const activeSessionId = activeSessions[activeKind];
  const awareness: EditorAwareness | undefined = selected[activeKind] ? { activeId: selected[activeKind], ids: [selected[activeKind]!] } : undefined;

  const refreshProject = useCallback(async (kind: ProjectKind) => {
    const current = projects?.[kind];
    if (!current) return;
    const state = await api.getProject(kind, current.id);
    setProjects((existing) => existing ? { ...existing, [kind]: state } as ProjectMap : existing);
  }, [projects]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const result = await api.bootstrap();
        const ppt = result.projects.ppt as PptProjectState;
        const canvas = result.projects.canvas as CanvasProjectState;
        setProjects({ ppt, canvas });
        setActiveSessions({ ppt: result.defaults.ppt.sessionId, canvas: result.defaults.canvas.sessionId });
        setSelected({ ppt: ppt.document.slides[0]?.id, canvas: canvas.document.nodes[0]?.id });
        setModels(result.models);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeProject || !activeSessionId) return;
    void api.getMessages(activeKind, activeProject.id, activeSessionId)
      .then((result) => setMessages(result.messages))
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [activeKind, activeSessionId, activeProject?.id]);

  usePolling(async () => {
    if (!activeProject || busy) return;
    const next = await api.getProjectSince(activeKind, activeProject.id, activeProject.revision);
    if ("unchanged" in next) return;
    setProjects((existing) => existing ? { ...existing, [activeKind]: next } as ProjectMap : existing);
  }, 1600, Boolean(activeProject));

  usePolling(async () => {
    if (!activeProject || !activeSessionId) return;
    const result = await api.getMessages(activeKind, activeProject.id, activeSessionId);
    setMessages(result.messages);
  }, 1200, Boolean(activeProject && activeSessionId));

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      if (activeProject) await refreshProject(activeKind).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (kind: ProjectKind, commands: ProjectCommand[], summary: string) => {
    const project = projects?.[kind];
    if (!project) return;
    await run(async () => {
      const result = await api.mutate(kind, project.id, {
        commandId: `user-${crypto.randomUUID()}`,
        baseRevision: project.revision,
        actor: { type: "user", id: "demo-user", sessionId: activeSessions[kind] },
        summary,
        commands
      });
      if (!result.ok) throw new Error(`Revision conflict. Project advanced to ${result.currentRevision}; refreshed latest state.`);
      setProjects((current) => current ? { ...current, [kind]: result.state } as ProjectMap : current);
    });
  };

  const createSession = async () => {
    if (!activeProject) return;
    await run(async () => {
      const result = await api.createSession(activeKind, activeProject.id);
      setProjects((current) => current ? { ...current, [activeKind]: result.project } as ProjectMap : current);
      setActiveSessions((current) => ({ ...current, [activeKind]: result.sessionId }));
      setMessages([]);
    });
  };

  const clearSession = async () => {
    if (!activeProject) return;
    await run(async () => {
      await api.clearMessages(activeKind, activeProject.id, activeSessionId);
      setMessages([]);
    });
  };

  const sendMessage = async (text: string) => {
    if (!activeProject) return;
    await run(async () => {
      const result = await api.sendMessage(activeKind, activeProject.id, activeSessionId, text, awareness);
      setMessages(result.messages);
      setProjects((current) => current ? { ...current, [activeKind]: result.project } as ProjectMap : current);
    });
  };

  const resolveInteraction = async (sessionId: string, interactionId: string, response: JsonObject) => {
    if (!activeProject) return;
    await run(async () => {
      await api.resolveInteraction(activeKind, activeProject.id, sessionId, interactionId, response);
      await refreshProject(activeKind);
    });
  };

  const rejectInteraction = async (sessionId: string, interactionId: string, reason: string) => {
    if (!activeProject) return;
    await run(async () => {
      await api.rejectInteraction(activeKind, activeProject.id, sessionId, interactionId, reason);
      await refreshProject(activeKind);
    });
  };

  const refreshWorkspace = async () => {
    if (!activeProject) return;
    setWorkspaceLoading(true);
    try {
      const result = await api.workspace(activeKind, activeProject.id);
      setWorkspaceFiles((current) => ({ ...current, [activeKind]: result.files }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const activeWorkflows = useMemo(() => activeProject?.workflows.filter((workflow) => ["queued", "running", "waiting"].includes(workflow.status)).length ?? 0, [activeProject?.workflows]);

  if (loading || !projects || !activeProject) {
    return <div className="loading-screen"><div className="loader-orb" /><h1>Bootstrapping durable creative projects</h1><p>Initializing Durable Objects, Agent sessions, and Computer workspaces…</p></div>;
  }

  return (
    <div className="app-shell">
      <nav className="product-nav">
        <div className="brand"><div>CF</div><span>Creative<br />Agent Lab</span></div>
        <div className="demo-switcher">
          <button className={activeKind === "ppt" ? "demo-card active" : "demo-card"} onClick={() => setActiveKind("ppt")}>
            <span className="demo-icon">P</span><div><strong>PPT Project Agent</strong><small>Editable deck + sessions + workflow</small></div>
          </button>
          <button className={activeKind === "canvas" ? "demo-card active" : "demo-card"} onClick={() => setActiveKind("canvas")}>
            <span className="demo-icon canvas">C</span><div><strong>Media Canvas Agent</strong><small>Canvas edits + real image generation</small></div>
          </button>
        </div>
        <div className="runtime-card">
          <span className="eyebrow">Live stack</span>
          <div><i className="status-dot" />Cloudflare-native</div>
          <small>Durable Objects</small><small>Agents + Think</small><small>Workflows + HITL</small><small>Workers AI</small><small>Computer Workspace</small><small>R2 artifacts</small>
        </div>
        <div className="model-card"><span>LLM</span><strong>{models.llm.split("/").at(-1)}</strong><span>Image</span><strong>{models.image.split("/").at(-1)}</strong></div>
        <div className="nav-footer"><span>{activeWorkflows} active workflow{activeWorkflows === 1 ? "" : "s"}</span><span>Project rev {activeProject.revision}</span></div>
      </nav>

      <div className="content-shell">
        {activeKind === "ppt" ? (
          <PptStudio
            project={projects.ppt}
            selectedId={selected.ppt}
            busy={busy}
            workspaceFiles={workspaceFiles.ppt}
            workspaceLoading={workspaceLoading}
            onSelect={(id) => setSelected((current) => ({ ...current, ppt: id }))}
            onMutate={(commands: PptCommand[], summary) => mutate("ppt", commands, summary)}
            onStartWorkflow={(params) => run(async () => {
              await api.startPptBuild(projects.ppt.id, activeSessions.ppt, params);
              await refreshProject("ppt");
            })}
            onExport={() => run(async () => {
              const result = await api.exportPpt(projects.ppt.id);
              window.location.assign(result.url);
              await refreshProject("ppt");
            })}
            onRefreshWorkspace={refreshWorkspace}
          />
        ) : (
          <CanvasStudio
            project={projects.canvas}
            selectedId={selected.canvas}
            busy={busy}
            workspaceFiles={workspaceFiles.canvas}
            workspaceLoading={workspaceLoading}
            onSelect={(id) => setSelected((current) => ({ ...current, canvas: id }))}
            onMutate={(commands: CanvasCommand[], summary) => mutate("canvas", commands, summary)}
            onStartWorkflow={(params) => run(async () => {
              await api.startCanvasVariants(projects.canvas.id, activeSessions.canvas, params);
              await refreshProject("canvas");
            })}
            onRefreshWorkspace={refreshWorkspace}
          />
        )}
      </div>

      <AgentPanel
        project={activeProject}
        activeSessionId={activeSessionId}
        messages={messages}
        busy={busy}
        awareness={awareness}
        onSelectSession={(sessionId) => setActiveSessions((current) => ({ ...current, [activeKind]: sessionId }))}
        onCreateSession={createSession}
        onClearSession={clearSession}
        onSend={sendMessage}
        onApproveInteraction={resolveInteraction}
        onRejectInteraction={rejectInteraction}
      />

      {error && <div className="error-toast"><strong>Action failed</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    </div>
  );
}

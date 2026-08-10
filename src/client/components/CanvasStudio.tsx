import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasCommand, CanvasNode, CanvasProjectState } from "../../shared/types";
import { assetUrl } from "../lib/api";
import { WorkspacePanel } from "./WorkspacePanel";

type Props = {
  project: CanvasProjectState;
  selectedId?: string;
  busy: boolean;
  workspaceFiles: Array<{ path: string; name: string; isDirectory: boolean }>;
  workspaceLoading: boolean;
  onSelect: (id?: string) => void;
  onMutate: (commands: CanvasCommand[], summary: string) => Promise<void>;
  onStartWorkflow: (params: { objective: string; count: number; referenceNodeId?: string; aspectRatio: "1:1" | "4:5" | "9:16" | "16:9" }) => Promise<void>;
  onRefreshWorkspace: () => Promise<void>;
};

type DragState = { nodeId: string; startX: number; startY: number; nodeX: number; nodeY: number };

export function CanvasStudio(props: Props) {
  const scale = 0.56;
  const selected = props.project.document.nodes.find((node) => node.id === props.selectedId);
  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({});
  const drag = useRef<DragState | null>(null);
  const [draft, setDraft] = useState<CanvasNode | null>(selected ? structuredClone(selected) : null);
  const [objective, setObjective] = useState("Create premium launch imagery for an AI video editing product, designed for social ads and small creative teams.");
  const [count, setCount] = useState(4);
  const [aspectRatio, setAspectRatio] = useState<"1:1" | "4:5" | "9:16" | "16:9">("4:5");
  const [workflowOpen, setWorkflowOpen] = useState(false);

  useEffect(() => {
    setDraft(selected ? structuredClone(selected) : null);
  }, [selected?.id, props.project.revision]);

  const orderedNodes = useMemo(() => [...props.project.document.nodes].sort((a, b) => a.zIndex - b.zIndex), [props.project.document.nodes]);

  const beginDrag = (event: React.PointerEvent, node: CanvasNode) => {
    if ((event.target as HTMLElement).closest("button,input,textarea")) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    props.onSelect(node.id);
    const position = localPositions[node.id] ?? { x: node.x, y: node.y };
    drag.current = { nodeId: node.id, startX: event.clientX, startY: event.clientY, nodeX: position.x, nodeY: position.y };
  };

  const moveDrag = (event: React.PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    setLocalPositions((positions) => ({
      ...positions,
      [current.nodeId]: {
        x: Math.max(0, current.nodeX + (event.clientX - current.startX) / scale),
        y: Math.max(0, current.nodeY + (event.clientY - current.startY) / scale)
      }
    }));
  };

  const endDrag = async () => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    const position = localPositions[current.nodeId];
    if (!position) return;
    await props.onMutate([{ type: "canvas.update_node", nodeId: current.nodeId, patch: position }], `Moved canvas node ${current.nodeId}`);
    setLocalPositions((positions) => {
      const next = { ...positions };
      delete next[current.nodeId];
      return next;
    });
  };

  const saveInspector = async () => {
    if (!draft || !selected) return;
    await props.onMutate([{
      type: "canvas.update_node",
      nodeId: selected.id,
      patch: {
        title: draft.title,
        text: draft.text,
        x: draft.x,
        y: draft.y,
        width: draft.width,
        height: draft.height,
        rotation: draft.rotation
      }
    }], `Updated canvas node ${selected.id}`);
  };

  const duplicate = async () => {
    if (!selected) return;
    const duplicateNode: CanvasNode = {
      ...selected,
      id: `node-${crypto.randomUUID()}`,
      x: selected.x + 50,
      y: selected.y + 50,
      title: `${selected.title} copy`,
      zIndex: Math.max(...props.project.document.nodes.map((node) => node.zIndex), 0) + 1
    };
    await props.onMutate([{ type: "canvas.duplicate_node", nodeId: selected.id, duplicate: duplicateNode }], `Duplicated ${selected.title}`);
    props.onSelect(duplicateNode.id);
  };

  return (
    <main className="studio-main canvas-studio">
      <header className="studio-toolbar">
        <div><span className="eyebrow">Long-lived Media Canvas</span><h1>{props.project.document.title}</h1><p>Revision {props.project.revision} · {props.project.document.nodes.length} nodes · Agent-aware selection context</p></div>
        <div className="toolbar-actions">
          <button className="button ghost" onClick={() => setWorkflowOpen((open) => !open)}>AI generate</button>
          <button className="button primary" disabled={!selected} onClick={() => void duplicate()}>Duplicate selected</button>
        </div>
      </header>

      {workflowOpen && (
        <section className="workflow-composer canvas-composer">
          <div><span className="eyebrow">Durable workflow</span><h3>Generate real image variants</h3></div>
          <label className="wide">Creative objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
          <label>Count<input type="number" min={1} max={6} value={count} onChange={(event) => setCount(Number(event.target.value))} /></label>
          <label>Aspect ratio<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as typeof aspectRatio)}><option>1:1</option><option>4:5</option><option>9:16</option><option>16:9</option></select></label>
          <div className="workflow-context">Reference: {selected ? selected.title : "whole canvas brief"}</div>
          <button className="button primary" disabled={props.busy || objective.trim().length < 8} onClick={() => void props.onStartWorkflow({ objective, count, referenceNodeId: selected?.id, aspectRatio })}>Plan prompts & request approval</button>
        </section>
      )}

      <div className="canvas-workspace">
        <section className="canvas-column">
          <div className="canvas-viewport" onPointerMove={moveDrag} onPointerUp={() => void endDrag()} onPointerCancel={() => void endDrag()}>
            <div className="canvas-scale-box" style={{ width: props.project.document.width * scale, height: props.project.document.height * scale }}>
              <div className="canvas-surface" style={{
                width: props.project.document.width,
                height: props.project.document.height,
                background: props.project.document.background,
                transform: `scale(${scale})`
              }} onPointerDown={(event) => { if (event.target === event.currentTarget) props.onSelect(undefined); }}>
                {orderedNodes.map((node) => {
                  const position = localPositions[node.id] ?? { x: node.x, y: node.y };
                  const className = ["canvas-node", node.type, node.status ?? "ready", node.id === selected?.id ? "selected" : ""].join(" ");
                  return (
                    <div
                      key={node.id}
                      className={className}
                      style={{ left: position.x, top: position.y, width: node.width, height: node.height, zIndex: node.zIndex, transform: `rotate(${node.rotation}deg)` }}
                      onPointerDown={(event) => beginDrag(event, node)}
                      onClick={(event) => { event.stopPropagation(); props.onSelect(node.id); }}
                    >
                      {node.type === "image" && node.assetKey && <img src={assetUrl(node.assetKey)} alt={node.title} draggable={false} />}
                      {node.type === "image" && !node.assetKey && <div className="generating-placeholder"><span /><strong>{node.status === "error" ? "Generation failed" : "Generating with Workers AI"}</strong><small>{node.title}</small></div>}
                      {(node.type === "note" || node.type === "text") && <div className="node-text"><strong>{node.title}</strong><p>{node.text}</p></div>}
                      {node.type === "frame" && <div className="frame-label">{node.title}</div>}
                      <span className="node-handle" />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <WorkspacePanel kind="canvas" files={props.workspaceFiles} loading={props.workspaceLoading} onRefresh={props.onRefreshWorkspace} />
        </section>

        <aside className="inspector canvas-inspector">
          <div className="inspector-title"><div><span className="eyebrow">Node inspector</span><h3>{selected?.title ?? "Nothing selected"}</h3></div></div>
          {draft && selected ? (
            <>
              <label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
              {(draft.type === "text" || draft.type === "note") && <label>Text<textarea className="large" value={draft.text ?? ""} onChange={(event) => setDraft({ ...draft, text: event.target.value })} /></label>}
              {draft.prompt && <label>Generation prompt<textarea className="large" value={draft.prompt} readOnly /></label>}
              <div className="field-grid"><label>X<input type="number" value={Math.round(draft.x)} onChange={(event) => setDraft({ ...draft, x: Number(event.target.value) })} /></label><label>Y<input type="number" value={Math.round(draft.y)} onChange={(event) => setDraft({ ...draft, y: Number(event.target.value) })} /></label><label>W<input type="number" value={Math.round(draft.width)} onChange={(event) => setDraft({ ...draft, width: Number(event.target.value) })} /></label><label>H<input type="number" value={Math.round(draft.height)} onChange={(event) => setDraft({ ...draft, height: Number(event.target.value) })} /></label></div>
              <button className="button primary wide-button" disabled={props.busy} onClick={() => void saveInspector()}>Save node revision</button>
              <button className="button ghost wide-button" disabled={props.busy} onClick={() => void duplicate()}>Duplicate</button>
              <button className="button danger wide-button" disabled={props.busy} onClick={() => void props.onMutate([{ type: "canvas.delete_node", nodeId: selected.id }], `Deleted canvas node ${selected.id}`)}>Delete</button>
              {selected.assetKey && <a className="button ghost wide-button" href={`/api/artifacts?key=${encodeURIComponent(selected.assetKey)}&download=1`}>Download image</a>}
            </>
          ) : <div className="inspector-empty">Select a node, then edit it directly or refer to “this” in the Agent chat.</div>}
          <div className="artifact-list"><span className="eyebrow">Generated assets</span>{props.project.artifacts.filter((artifact) => artifact.kind === "image").slice(0, 8).map((artifact) => <a key={artifact.id} href={`/api/artifacts?key=${encodeURIComponent(artifact.key)}&download=1`}>{artifact.name}<small>Workers AI</small></a>)}</div>
        </aside>
      </div>
    </main>
  );
}

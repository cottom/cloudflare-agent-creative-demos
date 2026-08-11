import { useEffect, useRef, useState } from "react";
import { mountPptist, unmountPptist, type PptistDocument as EmbedDocument, type PptistMountResult } from "@lofcz/pptist";
import "@lofcz/pptist/embed.css";
import type { PptistDocument } from "../../shared/pptist";
import type { PptCommand, PptProjectState } from "../../shared/types";
import { setPptistController } from "../lib/pptist-bridge";
import { WorkspacePanel } from "./WorkspacePanel";

type Props = {
  project: PptProjectState;
  busy: boolean;
  workspaceFiles: Array<{ path: string; name: string; isDirectory: boolean }>;
  workspaceLoading: boolean;
  onMutate: (commands: PptCommand[], summary: string) => Promise<void>;
  onStartWorkflow: (params: { objective: string; audience?: string; slideCount?: number; sourceNotes?: string }) => Promise<void>;
  onExport: () => Promise<void>;
  onRefreshWorkspace: () => Promise<void>;
};

export function PptStudio(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<PptistMountResult | null>(null);
  const [ready, setReady] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [objective, setObjective] = useState(props.project.document.objective);
  const [audience, setAudience] = useState(props.project.document.audience);
  const [slideCount, setSlideCount] = useState(8);
  const [sourceNotes, setSourceNotes] = useState("");

  // `onChange` fires from inside the editor and must not close over a stale
  // handler, so the latest one lives in a ref rather than in the mount deps.
  const saveRef = useRef(props.onMutate);
  saveRef.current = props.onMutate;

  // The deck the editor was last loaded with, so our own save is not echoed
  // back into the editor as if it were an external change.
  const lastDeckRef = useRef<string>("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    void (async () => {
      const initial = props.project.document.deck as unknown as EmbedDocument;
      lastDeckRef.current = JSON.stringify(initial);
      const result = await mountPptist(host, {
        locale: "en",
        document: initial,
        showLoadingData: false,
        // PPTist's in-editor export pulls a prebuilt 57 MB chunk of base64 CJK
        // fonts, and Cloudflare rejects any single asset over 25 MB. The tabs
        // are disabled so that chunk is never requested; export runs
        // server-side instead via the toolbar's Export PPTX.
        exportTabs: { pptx: false, image: false, json: false, pdf: false, pptist: false },
        onChangeDebounceMs: 600,
        onChange: (document) => {
          const serialized = JSON.stringify(document);
          if (serialized === lastDeckRef.current) return;
          lastDeckRef.current = serialized;
          void saveRef.current(
            [{ type: "ppt.set_deck", deck: document as unknown as PptistDocument }],
            `Edited deck (${document.slides.length} slides)`
          );
        }
      });
      if (disposed) {
        await unmountPptist(result);
        return;
      }
      mountRef.current = result;
      setPptistController(result.controller);
      setReady(true);
    })();

    return () => {
      disposed = true;
      setPptistController(null);
      const result = mountRef.current;
      mountRef.current = null;
      if (result) void unmountPptist(result);
    };
    // Mounted once per project: remounting on every deck change would throw
    // away the user's selection, undo history and scroll position.
  }, [props.project.id]);

  // Adopt decks written by the agent or a workflow, but never the echo of our
  // own save — that would fight the user mid-edit.
  useEffect(() => {
    const controller = mountRef.current?.controller;
    if (!controller || !ready) return;
    const incoming = JSON.stringify(props.project.document.deck);
    if (incoming === lastDeckRef.current) return;
    lastDeckRef.current = incoming;
    controller.setDocument(props.project.document.deck as unknown as EmbedDocument);
  }, [props.project.document.deck, ready]);

  return (
    <main className="studio-main ppt-studio">
      <header className="studio-toolbar">
        <div>
          <span className="eyebrow">Long-lived Presentation Project</span>
          <h1>{props.project.document.title}</h1>
          <p>
            Revision {props.project.revision} · {props.project.document.deck.slides.length} slides · PPTist editor
          </p>
        </div>
        <div className="toolbar-actions">
          <button className="button ghost" onClick={() => setWorkflowOpen((open) => !open)}>AI rebuild</button>
          <button className="button primary" disabled={props.busy} onClick={() => void props.onExport()}>Export PPTX</button>
        </div>
      </header>

      {workflowOpen && (
        <section className="workflow-composer">
          <div><span className="eyebrow">Durable workflow</span><h3>Rebuild the presentation with human review</h3></div>
          <label>Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
          <label>Audience<input value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
          <label>Slides<input type="number" min={3} max={20} value={slideCount} onChange={(event) => setSlideCount(Number(event.target.value))} /></label>
          <label className="wide">Source notes<textarea value={sourceNotes} onChange={(event) => setSourceNotes(event.target.value)} placeholder="Optional facts or source material. The demo will not fabricate missing statistics." /></label>
          <button className="button primary" disabled={props.busy || objective.trim().length < 8} onClick={() => void props.onStartWorkflow({ objective, audience, slideCount, sourceNotes })}>
            Start reviewed workflow
          </button>
        </section>
      )}

      <div className="pptist-shell">
        {!ready && <div className="pptist-loading">Loading the PPTist editor…</div>}
        <div className="pptist-host" ref={hostRef} />
      </div>

      <WorkspacePanel kind="ppt" files={props.workspaceFiles} loading={props.workspaceLoading} onRefresh={props.onRefreshWorkspace} />
    </main>
  );
}

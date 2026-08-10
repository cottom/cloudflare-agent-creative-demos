import { useEffect, useMemo, useState } from "react";
import { PPT_THEMES } from "../../shared/themes";
import type { PptCommand, PptProjectState, PptSlide } from "../../shared/types";
import { WorkspacePanel } from "./WorkspacePanel";

type Props = {
  project: PptProjectState;
  selectedId?: string;
  busy: boolean;
  workspaceFiles: Array<{ path: string; name: string; isDirectory: boolean }>;
  workspaceLoading: boolean;
  onSelect: (id: string) => void;
  onMutate: (commands: PptCommand[], summary: string) => Promise<void>;
  onStartWorkflow: (params: { objective: string; audience?: string; slideCount?: number; sourceNotes?: string }) => Promise<void>;
  onExport: () => Promise<void>;
  onRefreshWorkspace: () => Promise<void>;
};

export function PptStudio(props: Props) {
  const selected = props.project.document.slides.find((slide) => slide.id === props.selectedId)
    ?? props.project.document.slides[0];
  const [draft, setDraft] = useState<PptSlide | null>(selected ? structuredClone(selected) : null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [objective, setObjective] = useState(props.project.document.objective);
  const [audience, setAudience] = useState(props.project.document.audience);
  const [slideCount, setSlideCount] = useState(8);
  const [sourceNotes, setSourceNotes] = useState("");

  useEffect(() => {
    if (selected) setDraft(structuredClone(selected));
  }, [selected?.id, props.project.revision]);

  useEffect(() => {
    if (!props.selectedId && selected) props.onSelect(selected.id);
  }, [props.selectedId, selected?.id]);

  const selectedIndex = selected ? props.project.document.slides.findIndex((slide) => slide.id === selected.id) : -1;
  const theme = props.project.document.theme;
  const previewStyle = useMemo(() => ({
    background: `#${theme.background}`,
    color: `#${theme.foreground}`,
    fontFamily: theme.fontFamily
  }), [theme]);

  const save = async () => {
    if (!draft || !selected) return;
    await props.onMutate([{
      type: "ppt.update_slide",
      slideId: selected.id,
      patch: {
        title: draft.title,
        subtitle: draft.subtitle,
        body: draft.body.filter(Boolean),
        notes: draft.notes,
        layout: draft.layout
      }
    }], `Updated slide ${selectedIndex + 1}: ${draft.title}`);
  };

  const addSlide = async () => {
    const slide: PptSlide = {
      id: `slide-${crypto.randomUUID()}`,
      title: "New slide",
      body: ["Add a clear claim or supporting point"],
      layout: "bullets",
      elements: []
    };
    await props.onMutate([{ type: "ppt.add_slide", slide, index: selectedIndex + 1 }], "Added a new slide");
    props.onSelect(slide.id);
  };

  const move = async (direction: -1 | 1) => {
    if (selectedIndex < 0) return;
    const target = selectedIndex + direction;
    if (target < 0 || target >= props.project.document.slides.length) return;
    const ids = props.project.document.slides.map((slide) => slide.id);
    [ids[selectedIndex], ids[target]] = [ids[target]!, ids[selectedIndex]!];
    await props.onMutate([{ type: "ppt.reorder_slides", slideIds: ids }], `Moved slide ${selectedIndex + 1}`);
  };

  return (
    <main className="studio-main ppt-studio">
      <header className="studio-toolbar">
        <div>
          <span className="eyebrow">Long-lived Presentation Project</span>
          <h1>{props.project.document.title}</h1>
          <p>Revision {props.project.revision} · {props.project.document.slides.length} slides · Asset survives every Agent session</p>
        </div>
        <div className="toolbar-actions">
          <select
            value={theme.id}
            onChange={(event) => void props.onMutate([{
              type: "ppt.set_theme",
              theme: PPT_THEMES[event.target.value as keyof typeof PPT_THEMES]
            }], `Changed theme to ${event.target.value}`)}
          >
            {Object.values(PPT_THEMES).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
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

      <div className="ppt-workspace">
        <aside className="slide-rail">
          <div className="rail-actions"><button onClick={() => void addSlide()}>＋ Slide</button><span>{props.project.document.slides.length}</span></div>
          {props.project.document.slides.map((slide, index) => (
            <button key={slide.id} className={slide.id === selected?.id ? "slide-thumb active" : "slide-thumb"} onClick={() => props.onSelect(slide.id)}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div style={{ background: `#${theme.background}`, color: `#${theme.foreground}` }}><strong>{slide.title}</strong><small>{slide.body[0]}</small></div>
            </button>
          ))}
        </aside>

        <section className="slide-canvas-column">
          {selected && (
            <div className="slide-preview" style={previewStyle}>
              <span className="slide-number" style={{ color: `#${theme.accent}` }}>{String(selectedIndex + 1).padStart(2, "0")}</span>
              <h2>{draft?.title || selected.title}</h2>
              {draft?.subtitle && <h3 style={{ color: `#${theme.muted}` }}>{draft.subtitle}</h3>}
              <div className={`preview-body ${draft?.layout ?? selected.layout}`}>
                {(draft?.body ?? selected.body).map((item, index) => <p key={`${index}-${item}`}><span style={{ color: `#${theme.accent}` }}>•</span>{item}</p>)}
              </div>
              <small style={{ color: `#${theme.muted}` }}>{props.project.document.title}</small>
            </div>
          )}
          <WorkspacePanel kind="ppt" files={props.workspaceFiles} loading={props.workspaceLoading} onRefresh={props.onRefreshWorkspace} />
        </section>

        <aside className="inspector">
          <div className="inspector-title"><div><span className="eyebrow">Slide inspector</span><h3>Slide {selectedIndex + 1}</h3></div><div><button onClick={() => void move(-1)}>↑</button><button onClick={() => void move(1)}>↓</button></div></div>
          {draft && selected && (
            <>
              <label>Title<textarea value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
              <label>Subtitle<input value={draft.subtitle ?? ""} onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} /></label>
              <label>Layout<select value={draft.layout} onChange={(event) => setDraft({ ...draft, layout: event.target.value as PptSlide["layout"] })}>
                <option value="title">Title</option><option value="statement">Statement</option><option value="bullets">Bullets</option><option value="two_column">Two column</option><option value="metrics">Metrics</option>
              </select></label>
              <label>Body<textarea className="large" value={draft.body.join("\n")} onChange={(event) => setDraft({ ...draft, body: event.target.value.split("\n") })} /></label>
              <label>Speaker notes<textarea value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
              <button className="button primary wide-button" disabled={props.busy} onClick={() => void save()}>Save slide revision</button>
              <button className="button danger wide-button" disabled={props.project.document.slides.length <= 1 || props.busy} onClick={() => void props.onMutate([{ type: "ppt.delete_slide", slideId: selected.id }], `Deleted slide ${selectedIndex + 1}`)}>Delete slide</button>
            </>
          )}
          <div className="artifact-list">
            <span className="eyebrow">Exports</span>
            {props.project.artifacts.filter((artifact) => artifact.kind === "pptx").slice(0, 4).map((artifact) => (
              <a key={artifact.id} href={`/api/artifacts?key=${encodeURIComponent(artifact.key)}&download=1`}>{artifact.name}<small>Revision {artifact.revision}</small></a>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}

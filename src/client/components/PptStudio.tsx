import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  centeredAt,
  createShapeElement,
  createTableElement,
  createTextElement,
  elementsFromLayout,
  isFreeform,
  newElementId,
  nextZ
} from "../../shared/slide-elements";
import { PPT_THEMES } from "../../shared/themes";
import {
  SLIDE_WIDTH_IN,
  type PptCommand,
  type PptProjectState,
  type PptSlide,
  type SlideElement,
  type SlideElementPatch
} from "../../shared/types";
import { ElementInspector } from "./ElementInspector";
import { SlideCanvas } from "./SlideCanvas";
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

/**
 * The canvas scales to whatever width its column gets, so the editor works at
 * any window size instead of overflowing a fixed 760px board.
 */
function useCanvasScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(48);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width <= 0) return;
      // Resizing the canvas can nudge the column's scrollbar, which resizes the
      // probe again. Leaving a gutter and ignoring sub-pixel deltas stops that
      // feedback loop from pegging the main thread.
      const next = Math.floor(width - 8) / SLIDE_WIDTH_IN;
      setScale((current) => (Math.abs(current - next) > 0.5 ? next : current));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, scale };
}

export function PptStudio(props: Props) {
  const slides = props.project.document.slides;
  const selected = slides.find((slide) => slide.id === props.selectedId) ?? slides[0];
  const theme = props.project.document.theme;

  const [selectedElementId, setSelectedElementId] = useState<string | undefined>();
  const [snap, setSnap] = useState(true);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [objective, setObjective] = useState(props.project.document.objective);
  const [audience, setAudience] = useState(props.project.document.audience);
  const [slideCount, setSlideCount] = useState(8);
  const [sourceNotes, setSourceNotes] = useState("");
  const [notesDraft, setNotesDraft] = useState(selected?.notes ?? "");
  const canvas = useCanvasScale();

  const selectedIndex = selected ? slides.findIndex((slide) => slide.id === selected.id) : -1;
  const freeform = selected ? isFreeform(selected) : false;
  const element = selected?.elements.find((item) => item.id === selectedElementId);

  useEffect(() => {
    if (!props.selectedId && selected) props.onSelect(selected.id);
  }, [props.selectedId, selected?.id]);

  useEffect(() => {
    setSelectedElementId(undefined);
    setNotesDraft(selected?.notes ?? "");
  }, [selected?.id]);

  const mutate = props.onMutate;

  const patchElement = useCallback(
    (elementId: string, patch: SlideElementPatch, summary: string) => {
      if (!selected) return;
      void mutate([{ type: "ppt.update_element", slideId: selected.id, elementId, patch }], summary);
    },
    [mutate, selected?.id]
  );

  const addElement = async (factory: () => SlideElement) => {
    if (!selected) return;
    const base = factory();
    const element: SlideElement = { ...base, z: nextZ(selected.elements) };
    await mutate([{ type: "ppt.add_element", slideId: selected.id, element }], `Added ${element.type} element`);
    setSelectedElementId(element.id);
  };

  const convertToFreeform = async () => {
    if (!selected) return;
    const elements = elementsFromLayout(selected, theme);
    await mutate(
      elements.map((element) => ({ type: "ppt.add_element", slideId: selected.id, element }) as PptCommand),
      `Converted slide ${selectedIndex + 1} to editable elements`
    );
  };

  const reorder = (direction: "front" | "back" | "forward" | "backward") => {
    if (!selected || !element) return;
    const zs = selected.elements.map((item) => item.z);
    const min = Math.min(...zs);
    const max = Math.max(...zs);
    const z =
      direction === "front" ? max + 1
        : direction === "back" ? min - 1
        : direction === "forward" ? element.z + 1.5
        : element.z - 1.5;
    void mutate([{ type: "ppt.set_element_order", slideId: selected.id, elementId: element.id, z }], `Reordered ${element.type}`);
  };

  const duplicateElement = () => {
    if (!selected || !element) return;
    const copy: SlideElement = {
      ...structuredClone(element),
      id: newElementId(),
      x: element.x + 0.25,
      y: element.y + 0.25,
      z: nextZ(selected.elements)
    };
    void mutate([{ type: "ppt.add_element", slideId: selected.id, element: copy }], `Duplicated ${element.type}`);
    setSelectedElementId(copy.id);
  };

  const deleteElement = () => {
    if (!selected || !element) return;
    void mutate([{ type: "ppt.delete_element", slideId: selected.id, elementId: element.id }], `Deleted ${element.type}`);
    setSelectedElementId(undefined);
  };

  // Keyboard: arrows nudge, Delete removes, Cmd/Ctrl+D duplicates. Ignored
  // while typing so shortcuts never eat input in a field or a contentEditable.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (!selected || !element) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteElement();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateElement();
        return;
      }
      const step = event.shiftKey ? 0.5 : 0.05;
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]
      };
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();
      patchElement(element.id, { x: element.x + delta[0], y: element.y + delta[1] }, "Nudged element");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected?.id, element?.id, element?.x, element?.y, patchElement]);

  const addSlide = async () => {
    const slide: PptSlide = {
      id: `slide-${crypto.randomUUID()}`,
      title: "New slide",
      body: ["Add a clear claim or supporting point"],
      layout: "bullets",
      elements: []
    };
    await mutate([{ type: "ppt.add_slide", slide, index: selectedIndex + 1 }], "Added a new slide");
    props.onSelect(slide.id);
  };

  const move = async (direction: -1 | 1) => {
    if (selectedIndex < 0) return;
    const target = selectedIndex + direction;
    if (target < 0 || target >= slides.length) return;
    const ids = slides.map((slide) => slide.id);
    [ids[selectedIndex], ids[target]] = [ids[target]!, ids[selectedIndex]!];
    await mutate([{ type: "ppt.reorder_slides", slideIds: ids }], `Moved slide ${selectedIndex + 1}`);
  };

  const imageAssets = useMemo(
    () => props.project.artifacts.filter((artifact) => artifact.kind === "image").slice(0, 12),
    [props.project.artifacts]
  );

  return (
    <main className="studio-main ppt-studio">
      <header className="studio-toolbar">
        <div>
          <span className="eyebrow">Long-lived Presentation Project</span>
          <h1>{props.project.document.title}</h1>
          <p>Revision {props.project.revision} · {slides.length} slides · Asset survives every Agent session</p>
        </div>
        <div className="toolbar-actions">
          <select
            value={theme.id}
            onChange={(event) => void mutate([{
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
          <div className="rail-actions"><button onClick={() => void addSlide()}>＋ Slide</button><span>{slides.length}</span></div>
          {slides.map((slide, index) => (
            <button key={slide.id} className={slide.id === selected?.id ? "slide-thumb active" : "slide-thumb"} onClick={() => props.onSelect(slide.id)}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div style={{ background: `#${theme.background}`, color: `#${theme.foreground}` }}>
                <strong>{slide.title}</strong>
                <small>{isFreeform(slide) ? `${slide.elements.length} elements` : slide.body[0]}</small>
              </div>
            </button>
          ))}
        </aside>

        <section className="slide-canvas-column">
          <div className="element-toolbar">
            <button disabled={props.busy || !freeform} onClick={() => void addElement(() => createTextElement({ ...centeredAt(5, 1) }))}>＋ Text</button>
            <button disabled={props.busy || !freeform} onClick={() => void addElement(() => createShapeElement({ ...centeredAt(3, 2), fill: theme.accent }))}>＋ Shape</button>
            <button disabled={props.busy || !freeform} onClick={() => void addElement(() => createTableElement({ ...centeredAt(8, 2) }))}>＋ Table</button>
            <select
              disabled={props.busy || !freeform || imageAssets.length === 0}
              value=""
              onChange={(event) => {
                if (!event.target.value) return;
                void addElement(() => ({ ...createShapeElement(), type: "image", assetKey: event.target.value, ...centeredAt(4, 3), w: 4, h: 3 } as SlideElement));
                event.target.value = "";
              }}
            >
              <option value="">＋ Image{imageAssets.length === 0 ? " (generate one on the canvas first)" : ""}</option>
              {imageAssets.map((artifact) => <option key={artifact.id} value={artifact.key}>{artifact.name}</option>)}
            </select>
            <label className="snap-toggle">
              <input type="checkbox" checked={snap} onChange={(event) => setSnap(event.target.checked)} />
              Snap
            </label>
            <span className="toolbar-hint">{freeform ? "Drag to move · handles to resize · double-click text to edit" : "Layout mode"}</span>
          </div>

          <div className="canvas-measure" ref={canvas.ref} />
          {selected && freeform && (
            <SlideCanvas
              elements={selected.elements}
              theme={theme}
              scale={canvas.scale}
              snap={snap}
              selectedId={selectedElementId}
              onSelect={setSelectedElementId}
              onCommit={(id, geometry) => patchElement(id, geometry, "Moved element")}
              onEditText={(id, text) => patchElement(id, { text }, "Edited text")}
            />
          )}

          {selected && !freeform && (
            <div className="slide-preview" style={{ background: `#${theme.background}`, color: `#${theme.foreground}`, fontFamily: theme.fontFamily }}>
              <span className="slide-number" style={{ color: `#${theme.accent}` }}>{String(selectedIndex + 1).padStart(2, "0")}</span>
              <h2>{selected.title}</h2>
              {selected.subtitle && <h3 style={{ color: `#${theme.muted}` }}>{selected.subtitle}</h3>}
              <div className={`preview-body ${selected.layout}`}>
                {selected.body.map((item, index) => <p key={`${index}-${item}`}><span style={{ color: `#${theme.accent}` }}>•</span>{item}</p>)}
              </div>
              <small style={{ color: `#${theme.muted}` }}>{props.project.document.title}</small>
            </div>
          )}

          {selected && !freeform && (
            <div className="convert-strip">
              <div>
                <strong>This slide uses the fixed layout.</strong>
                <span>Convert it to elements to move, resize, restyle and layer everything freely.</span>
              </div>
              <button className="button primary" disabled={props.busy} onClick={() => void convertToFreeform()}>Convert to editable elements</button>
            </div>
          )}

          <WorkspacePanel kind="ppt" files={props.workspaceFiles} loading={props.workspaceLoading} onRefresh={props.onRefreshWorkspace} />
        </section>

        <aside className="inspector">
          <div className="inspector-title">
            <div><span className="eyebrow">Slide inspector</span><h3>Slide {selectedIndex + 1}</h3></div>
            <div><button onClick={() => void move(-1)}>↑</button><button onClick={() => void move(1)}>↓</button></div>
          </div>

          {selected && element && (
            <ElementInspector
              element={element}
              theme={theme}
              busy={props.busy}
              onPatch={(patch, summary) => patchElement(element.id, patch, summary)}
              onOrder={reorder}
              onDuplicate={duplicateElement}
              onDelete={deleteElement}
            />
          )}

          {selected && !element && freeform && (
            <div className="inspector-empty">Select an element on the slide to edit its text, style, size and layer.</div>
          )}

          {selected && !freeform && (
            <>
              <label>Title<textarea value={selected.title} onChange={(event) => void mutate([{ type: "ppt.update_slide", slideId: selected.id, patch: { title: event.target.value } }], "Updated title")} /></label>
              <label>Subtitle<input value={selected.subtitle ?? ""} onChange={(event) => void mutate([{ type: "ppt.update_slide", slideId: selected.id, patch: { subtitle: event.target.value } }], "Updated subtitle")} /></label>
              <label>Layout<select value={selected.layout} onChange={(event) => void mutate([{ type: "ppt.update_slide", slideId: selected.id, patch: { layout: event.target.value as PptSlide["layout"] } }], "Updated layout")}>
                <option value="title">Title</option><option value="statement">Statement</option><option value="bullets">Bullets</option><option value="two_column">Two column</option><option value="metrics">Metrics</option>
              </select></label>
              <label>Body<textarea className="large" value={selected.body.join("\n")} onChange={(event) => void mutate([{ type: "ppt.update_slide", slideId: selected.id, patch: { body: event.target.value.split("\n") } }], "Updated body")} /></label>
            </>
          )}

          {selected && (
            <label>
              Speaker notes
              <textarea
                value={notesDraft}
                onChange={(event) => setNotesDraft(event.target.value)}
                onBlur={() => {
                  if (notesDraft !== (selected.notes ?? "")) {
                    void mutate([{ type: "ppt.update_slide", slideId: selected.id, patch: { notes: notesDraft } }], "Updated speaker notes");
                  }
                }}
              />
            </label>
          )}

          {selected && (
            <button className="button danger wide-button" disabled={slides.length <= 1 || props.busy} onClick={() => void mutate([{ type: "ppt.delete_slide", slideId: selected.id }], `Deleted slide ${selectedIndex + 1}`)}>
              Delete slide
            </button>
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

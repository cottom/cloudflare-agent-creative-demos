import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SLIDE_HEIGHT_IN, SLIDE_WIDTH_IN, type PptTheme, type SlideElement } from "../../shared/types";
import { assetUrl } from "../lib/api";

type Geometry = { x: number; y: number; w: number; h: number; rotation: number };

type Props = {
  elements: SlideElement[];
  theme: PptTheme;
  selectedId?: string;
  /** Pixels per inch — the canvas scales to its container. */
  scale: number;
  snap: boolean;
  onSelect: (id?: string) => void;
  /** Fires once per gesture, on pointer release. */
  onCommit: (id: string, geometry: Geometry) => void;
  onEditText: (id: string, text: string) => void;
};

type Handle = "nw" | "ne" | "se" | "sw" | "n" | "e" | "s" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type Drag = {
  id: string;
  mode: "move" | "resize" | "rotate";
  handle?: Handle;
  startX: number;
  startY: number;
  origin: Geometry;
  centerX: number;
  centerY: number;
};

/** Grid step in inches when snapping is on. */
const SNAP_IN = 0.125;

export function SlideCanvas(props: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // Live geometry during a gesture. Committing only on release keeps one
  // undoable revision per drag instead of one per pointer-move event.
  const [preview, setPreview] = useState<{ id: string; geometry: Geometry } | null>(null);

  const snap = (value: number) => (props.snap ? Math.round(value / SNAP_IN) * SNAP_IN : value);

  const geometryOf = (element: SlideElement): Geometry =>
    preview && preview.id === element.id
      ? preview.geometry
      : { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation };

  const begin = (
    event: ReactPointerEvent,
    element: SlideElement,
    mode: Drag["mode"],
    handle?: Handle
  ) => {
    if (element.locked) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    props.onSelect(element.id);
    const rect = surfaceRef.current?.getBoundingClientRect();
    const origin = geometryOf(element);
    drag.current = {
      id: element.id,
      mode,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      centerX: (rect?.left ?? 0) + (origin.x + origin.w / 2) * props.scale,
      centerY: (rect?.top ?? 0) + (origin.y + origin.h / 2) * props.scale
    };
    setPreview({ id: element.id, geometry: origin });
  };

  const move = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const dx = (event.clientX - current.startX) / props.scale;
    const dy = (event.clientY - current.startY) / props.scale;
    const origin = current.origin;
    let next: Geometry = { ...origin };

    if (current.mode === "move") {
      next.x = snap(origin.x + dx);
      next.y = snap(origin.y + dy);
    } else if (current.mode === "resize" && current.handle) {
      const handle = current.handle;
      if (handle.includes("e")) next.w = Math.max(SNAP_IN, snap(origin.w + dx));
      if (handle.includes("s")) next.h = Math.max(SNAP_IN, snap(origin.h + dy));
      if (handle.includes("w")) {
        const width = Math.max(SNAP_IN, snap(origin.w - dx));
        next.x = snap(origin.x + (origin.w - width));
        next.w = width;
      }
      if (handle.includes("n")) {
        const height = Math.max(SNAP_IN, snap(origin.h - dy));
        next.y = snap(origin.y + (origin.h - height));
        next.h = height;
      }
    } else if (current.mode === "rotate") {
      const angle = Math.atan2(event.clientY - current.centerY, event.clientX - current.centerX);
      const degrees = (angle * 180) / Math.PI + 90;
      // Shift constrains to 15° detents, the usual convention for rotation.
      next.rotation = event.shiftKey ? Math.round(degrees / 15) * 15 : Math.round(degrees);
    }

    setPreview({ id: current.id, geometry: next });
  };

  const end = () => {
    const current = drag.current;
    drag.current = null;
    if (!current || !preview) return;
    const geometry = preview.geometry;
    setPreview(null);
    const origin = current.origin;
    const unchanged =
      geometry.x === origin.x && geometry.y === origin.y &&
      geometry.w === origin.w && geometry.h === origin.h &&
      geometry.rotation === origin.rotation;
    if (!unchanged) props.onCommit(current.id, geometry);
  };

  const ordered = [...props.elements].sort((a, b) => a.z - b.z);

  return (
    <div
      className="slide-canvas"
      style={{ width: SLIDE_WIDTH_IN * props.scale, height: SLIDE_HEIGHT_IN * props.scale, background: `#${props.theme.background}` }}
      ref={surfaceRef}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerDown={(event) => { if (event.target === event.currentTarget) props.onSelect(undefined); }}
    >
      {ordered.map((element) => {
        const geometry = geometryOf(element);
        const selected = element.id === props.selectedId;
        return (
          <div
            key={element.id}
            className={`slide-element${selected ? " selected" : ""}${element.locked ? " locked" : ""}`}
            style={{
              left: geometry.x * props.scale,
              top: geometry.y * props.scale,
              width: geometry.w * props.scale,
              height: geometry.h * props.scale,
              transform: `rotate(${geometry.rotation}deg)`,
              zIndex: element.z
            }}
            onPointerDown={(event) => begin(event, element, "move")}
          >
            <ElementBody element={element} theme={props.theme} scale={props.scale} onEditText={props.onEditText} />

            {selected && !element.locked && (
              <>
                <span
                  className="rotate-handle"
                  onPointerDown={(event) => begin(event, element, "rotate")}
                  title="Drag to rotate (hold Shift for 15° steps)"
                />
                {HANDLES.map((handle) => (
                  <span
                    key={handle}
                    className={`resize-handle ${handle}`}
                    onPointerDown={(event) => begin(event, element, "resize", handle)}
                  />
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ElementBody({
  element,
  theme,
  scale,
  onEditText
}: {
  element: SlideElement;
  theme: PptTheme;
  scale: number;
  onEditText: (id: string, text: string) => void;
}) {
  if (element.type === "text") {
    return (
      <div
        className="element-text"
        // Inches → CSS px: fontSize is in points, and 1in = 72pt.
        style={{
          fontSize: (element.fontSize / 72) * scale,
          fontFamily: theme.fontFamily,
          color: `#${element.color ?? theme.foreground}`,
          background: element.fill ? `#${element.fill}` : "transparent",
          fontWeight: element.bold ? 700 : 400,
          fontStyle: element.italic ? "italic" : "normal",
          textDecoration: element.underline ? "underline" : "none",
          textAlign: element.align ?? "left",
          justifyContent: element.valign === "middle" ? "center" : element.valign === "bottom" ? "flex-end" : "flex-start"
        }}
        // Double-click to edit in place, which is what users expect from a
        // slide tool; a single click keeps the drag gesture intact.
        onDoubleClick={(event) => {
          const node = event.currentTarget;
          node.contentEditable = "true";
          node.focus();
        }}
        onBlur={(event) => {
          const node = event.currentTarget;
          if (node.contentEditable !== "true") return;
          node.contentEditable = "false";
          const value = node.innerText.replace(/\n$/, "");
          if (value !== element.text) onEditText(element.id, value);
        }}
        suppressContentEditableWarning
      >
        {element.bullet
          ? element.text.split("\n").map((line, index) => <div key={index}>• {line}</div>)
          : element.text}
      </div>
    );
  }

  if (element.type === "shape") {
    const fill = element.fill ? `#${element.fill}` : "transparent";
    const stroke = element.stroke ? `#${element.stroke}` : "none";
    if (element.shape === "line") {
      return <div className="element-line" style={{ background: element.stroke ? `#${element.stroke}` : `#${theme.muted}`, height: Math.max(1, (element.strokeWidth ?? 1)) }} />;
    }
    return (
      <div
        className="element-shape"
        style={{
          background: fill,
          border: element.stroke ? `${element.strokeWidth ?? 1}px solid ${stroke}` : "none",
          borderRadius:
            element.shape === "ellipse" ? "50%" : element.shape === "roundRect" ? `${(element.radius ?? 0.2) * 100}px` : 0,
          clipPath: element.shape === "triangle" ? "polygon(50% 0%, 100% 100%, 0% 100%)" : undefined
        }}
      />
    );
  }

  if (element.type === "table") {
    return (
      <table className="element-table" style={{ fontSize: ((element.fontSize ?? 12) / 72) * scale, color: `#${theme.foreground}` }}>
        <tbody>
          {element.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={element.headerRow && rowIndex === 0 ? "header" : undefined}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} style={element.headerRow && rowIndex === 0 ? { background: `#${theme.accent}`, color: `#${theme.background}` } : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return <img className="element-image" src={assetUrl(element.assetKey)} alt={element.altText ?? ""} draggable={false} />;
}

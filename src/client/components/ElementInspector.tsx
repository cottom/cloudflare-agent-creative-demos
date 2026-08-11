import type { PptTheme, SlideElement, SlideElementPatch } from "../../shared/types";

type Props = {
  element: SlideElement;
  theme: PptTheme;
  busy: boolean;
  onPatch: (patch: SlideElementPatch, summary: string) => void;
  onOrder: (direction: "front" | "back" | "forward" | "backward") => void;
  onDuplicate: () => void;
  onDelete: () => void;
};

const SWATCHES = ["FFFFFF", "111827", "5B6CFF", "7CFFB2", "E34B35", "FF6B35", "F4F0E8", "667085"];

export function ElementInspector({ element, theme, busy, onPatch, onOrder, onDuplicate, onDelete }: Props) {
  const number = (label: string, key: "x" | "y" | "w" | "h" | "rotation", step = 0.05) => (
    <label>
      {label}
      <input
        type="number"
        step={step}
        value={Math.round(element[key] * 100) / 100}
        disabled={busy}
        onChange={(event) => onPatch({ [key]: Number(event.target.value) } as SlideElementPatch, `Set ${label}`)}
      />
    </label>
  );

  return (
    <div className="element-inspector">
      <div className="inspector-row">
        <span className="eyebrow">{element.type} element</span>
        <button className="text-button" onClick={() => onPatch({ locked: !element.locked }, element.locked ? "Unlocked element" : "Locked element")}>
          {element.locked ? "Unlock" : "Lock"}
        </button>
      </div>

      {element.type === "text" && (
        <>
          <label>
            Text
            <textarea
              className="large"
              value={element.text}
              disabled={busy}
              onChange={(event) => onPatch({ text: event.target.value }, "Edited text")}
            />
          </label>
          <div className="field-grid">
            <label>
              Size
              <input
                type="number"
                min={6}
                max={200}
                value={element.fontSize}
                disabled={busy}
                onChange={(event) => onPatch({ fontSize: Number(event.target.value) }, "Set font size")}
              />
            </label>
            <label>
              Align
              <select value={element.align ?? "left"} disabled={busy} onChange={(event) => onPatch({ align: event.target.value as "left" }, "Set alignment")}>
                <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
              </select>
            </label>
            <label>
              Vertical
              <select value={element.valign ?? "top"} disabled={busy} onChange={(event) => onPatch({ valign: event.target.value as "top" }, "Set vertical alignment")}>
                <option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>
              </select>
            </label>
            <label>
              Role
              <select value={element.role} disabled={busy} onChange={(event) => onPatch({ role: event.target.value as "body" }, "Set role")}>
                <option value="title">Title</option><option value="body">Body</option><option value="caption">Caption</option><option value="metric">Metric</option>
              </select>
            </label>
          </div>
          <div className="style-toggles">
            <button className={element.bold ? "toggle active" : "toggle"} disabled={busy} onClick={() => onPatch({ bold: !element.bold }, "Toggled bold")}><strong>B</strong></button>
            <button className={element.italic ? "toggle active" : "toggle"} disabled={busy} onClick={() => onPatch({ italic: !element.italic }, "Toggled italic")}><em>I</em></button>
            <button className={element.underline ? "toggle active" : "toggle"} disabled={busy} onClick={() => onPatch({ underline: !element.underline }, "Toggled underline")}><u>U</u></button>
            <button className={element.bullet ? "toggle active" : "toggle"} disabled={busy} onClick={() => onPatch({ bullet: !element.bullet }, "Toggled bullets")}>•</button>
          </div>
          <ColorRow label="Text color" value={element.color ?? theme.foreground} busy={busy} onPick={(color) => onPatch({ color }, "Set text color")} />
        </>
      )}

      {element.type === "shape" && (
        <>
          <label>
            Shape
            <select value={element.shape} disabled={busy} onChange={(event) => onPatch({ shape: event.target.value as "rect" }, "Changed shape")}>
              <option value="rect">Rectangle</option>
              <option value="roundRect">Rounded rectangle</option>
              <option value="ellipse">Ellipse</option>
              <option value="triangle">Triangle</option>
              <option value="line">Line</option>
            </select>
          </label>
          <ColorRow label="Fill" value={element.fill ?? theme.accent} busy={busy} onPick={(fill) => onPatch({ fill }, "Set fill")} />
          <ColorRow label="Stroke" value={element.stroke ?? theme.muted} busy={busy} onPick={(stroke) => onPatch({ stroke }, "Set stroke")} />
          <label>
            Stroke width
            <input type="number" min={0} max={12} value={element.strokeWidth ?? 0} disabled={busy}
              onChange={(event) => onPatch({ strokeWidth: Number(event.target.value) }, "Set stroke width")} />
          </label>
        </>
      )}

      {element.type === "table" && (
        <label>
          Rows (one per line, cells separated by |)
          <textarea
            className="large"
            value={element.rows.map((row) => row.join(" | ")).join("\n")}
            disabled={busy}
            onChange={(event) =>
              onPatch(
                { rows: event.target.value.split("\n").map((line) => line.split("|").map((cell) => cell.trim())) },
                "Edited table"
              )
            }
          />
        </label>
      )}

      {element.type === "image" && (
        <label>
          Alt text
          <input value={element.altText ?? ""} disabled={busy} onChange={(event) => onPatch({ altText: event.target.value }, "Set alt text")} />
        </label>
      )}

      <div className="field-grid">
        {number("X (in)", "x")}
        {number("Y (in)", "y")}
        {number("W (in)", "w")}
        {number("H (in)", "h")}
        {number("Rotation", "rotation", 1)}
      </div>

      <div className="order-row">
        <button className="text-button" disabled={busy} onClick={() => onOrder("back")}>Send to back</button>
        <button className="text-button" disabled={busy} onClick={() => onOrder("backward")}>Backward</button>
        <button className="text-button" disabled={busy} onClick={() => onOrder("forward")}>Forward</button>
        <button className="text-button" disabled={busy} onClick={() => onOrder("front")}>Bring to front</button>
      </div>

      <button className="button ghost wide-button" disabled={busy} onClick={onDuplicate}>Duplicate element</button>
      <button className="button danger wide-button" disabled={busy} onClick={onDelete}>Delete element</button>
    </div>
  );
}

function ColorRow({
  label,
  value,
  busy,
  onPick
}: {
  label: string;
  value: string;
  busy: boolean;
  onPick: (hex: string) => void;
}) {
  return (
    <div className="color-row">
      <span>{label}</span>
      <div>
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            className={swatch.toUpperCase() === value.toUpperCase() ? "swatch active" : "swatch"}
            style={{ background: `#${swatch}` }}
            disabled={busy}
            title={`#${swatch}`}
            onClick={() => onPick(swatch)}
          />
        ))}
        <input
          type="color"
          value={`#${value}`}
          disabled={busy}
          onChange={(event) => onPick(event.target.value.replace("#", "").toUpperCase())}
        />
      </div>
    </div>
  );
}

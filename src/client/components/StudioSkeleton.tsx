/**
 * Placeholder shown while the editor bundle streams in.
 *
 * It mirrors the real editor's layout — rail, stage, side panel — rather than
 * showing a spinner, so the page does not visibly reflow when the editor
 * arrives and the wait reads as "loading this thing" rather than "stuck".
 */
export function StudioSkeleton({ kind }: { kind: "ppt" | "canvas" }) {
  return (
    <main className="studio-main skeleton-studio" aria-busy="true" aria-live="polite">
      <header className="studio-toolbar">
        <div>
          <span className="eyebrow">{kind === "ppt" ? "Long-lived Presentation Project" : "Long-lived Media Canvas"}</span>
          <div className="sk-line sk-title" />
          <div className="sk-line sk-sub" />
        </div>
        <div className="toolbar-actions">
          <div className="sk-btn" />
          <div className="sk-btn wide" />
        </div>
      </header>

      <div className="skeleton-body">
        <aside className="skeleton-rail">
          {Array.from({ length: 5 }, (_, index) => <div className="sk-thumb" key={index} />)}
        </aside>
        <div className="skeleton-stage">
          <div className="sk-stage-inner" />
          <span className="skeleton-note">Loading the editor…</span>
        </div>
      </div>
    </main>
  );
}

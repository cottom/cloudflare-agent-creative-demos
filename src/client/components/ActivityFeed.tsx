import type { ActivityEvent } from "../../shared/types";

/**
 * Live revision history.
 *
 * This replaces a static "live stack" list of product claims. The claims were
 * true but unfalsifiable from the UI; the same nav space now shows the actual
 * revisions as they land, which demonstrates the durable-project story instead
 * of asserting it — and gives the user an answer to "what did the agent just
 * change?" without reading the chat.
 */
export function ActivityFeed({ activity, revision }: { activity: ActivityEvent[]; revision: number }) {
  const recent = activity.slice(0, 8);

  return (
    <div className="activity-feed">
      <div className="activity-head">
        <span className="eyebrow">Project history</span>
        <span className="revision-pill">rev {revision}</span>
      </div>

      {recent.length === 0 && <p className="activity-empty">Edits will appear here as they happen.</p>}

      <ol>
        {recent.map((event) => (
          <li key={`${event.id}-${event.revision}`} className={`activity-row ${event.actor.type}`}>
            <span className="activity-actor" title={event.actor.type}>{actorGlyph(event.actor.type)}</span>
            <span className="activity-text">
              <strong>{event.summary}</strong>
              <small>rev {event.revision} · {relativeTime(event.createdAt)}</small>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function actorGlyph(type: ActivityEvent["actor"]["type"]): string {
  if (type === "agent") return "AI";
  if (type === "workflow") return "WF";
  if (type === "system") return "SY";
  return "You";
}

/** Short relative time; the exact timestamp is rarely what the user wants. */
function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

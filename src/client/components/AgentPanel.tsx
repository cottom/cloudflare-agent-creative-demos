import { FormEvent, useEffect, useRef, useState } from "react";
import type { EditorAwareness, ProjectState, SessionMeta } from "../../shared/types";
import type { ClientMessage } from "../lib/api";
import { messageText } from "../lib/api";
import { InteractionCard } from "./InteractionCard";

type Props = {
  project: ProjectState;
  activeSessionId: string;
  messages: ClientMessage[];
  busy: boolean;
  awareness?: EditorAwareness;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => Promise<void>;
  onClearSession: () => Promise<void>;
  onSend: (text: string) => Promise<void>;
  onApproveInteraction: (sessionId: string, interactionId: string, response: Record<string, unknown>) => Promise<void>;
  onRejectInteraction: (sessionId: string, interactionId: string, reason: string) => Promise<void>;
};

export function AgentPanel(props: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentSession = props.project.sessions.find((session) => session.id === props.activeSessionId);
  const interactions = props.project.interactions.filter((interaction) => interaction.status === "pending");
  const workflows = props.project.workflows.slice(0, 4);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [props.messages.length, interactions.length]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value || props.busy) return;
    setDraft("");
    await props.onSend(value);
  };

  const starters = props.project.kind === "ppt"
    ? ["Make the selected slide more decisive.", "Change the whole deck to editorial style.", "Rebuild this as an 8-slide investor deck with approval."]
    : ["Duplicate the selected node.", "Add a note summarizing this direction.", "Generate four premium 4:5 launch concepts with approval."];

  return (
    <aside className="agent-panel">
      <header className="agent-header">
        <div>
          <span className="eyebrow">Project Agent</span>
          <h2>{currentSession?.title ?? "Agent Session"}</h2>
        </div>
        <button className="icon-button" title="New session" onClick={() => void props.onCreateSession()}>＋</button>
      </header>

      <div className="session-strip">
        {props.project.sessions.map((session: SessionMeta) => (
          <button
            key={session.id}
            className={session.id === props.activeSessionId ? "session-pill active" : "session-pill"}
            onClick={() => props.onSelectSession(session.id)}
          >
            {session.title}
          </button>
        ))}
      </div>

      {workflows.length > 0 && (
        <div className="workflow-stack">
          {workflows.map((workflow) => (
            <div className={`workflow-chip ${workflow.status}`} key={workflow.id}>
              <div><strong>{workflow.type === "ppt_build" ? "Presentation workflow" : "Image variants workflow"}</strong><span>{workflow.message}</span></div>
              <div className="progress-track"><span style={{ width: `${Math.round(workflow.progress * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef}>
        {props.messages.length === 0 && (
          <div className="chat-empty">
            <div className="agent-orb">AI</div>
            <h3>Fresh session, same project.</h3>
            <p>The chat history is empty, but the Agent reads the latest project revision and current editor selection every turn.</p>
            <div className="starter-list">
              {starters.map((starter) => <button key={starter} onClick={() => setDraft(starter)}>{starter}</button>)}
            </div>
          </div>
        )}
        {props.messages.map((message) => (
          <div className={`message ${message.role}`} key={message.id}>
            <span>{message.role === "user" ? "You" : "Agent"}</span>
            <div>{messageText(message) || "Completed a tool action."}</div>
          </div>
        ))}
        {interactions.map((interaction) => (
          <InteractionCard
            key={interaction.id}
            interaction={interaction}
            busy={props.busy}
            onApprove={(response) => props.onApproveInteraction(interaction.sessionId, interaction.id, response)}
            onReject={(reason) => props.onRejectInteraction(interaction.sessionId, interaction.id, reason)}
          />
        ))}
      </div>

      <form className="chat-form" onSubmit={submit}>
        {props.awareness?.activeId && <div className="selection-context">Editing context: {props.awareness.activeId}</div>}
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask the Agent to edit this project…" rows={3} />
        <div>
          <button type="button" className="text-button" onClick={() => void props.onClearSession()}>Clear chat</button>
          <button className="button primary" disabled={props.busy || !draft.trim()}>{props.busy ? "Working…" : "Send"}</button>
        </div>
      </form>
    </aside>
  );
}

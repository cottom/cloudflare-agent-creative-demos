import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "agents/chat/react";
import type { UIMessage } from "ai";
import { studioAgentName } from "../../shared/policy";
import type { EditorAwareness, JsonObject, ProjectState, SessionMeta } from "../../shared/types";
import { describeUiResponse, parseUiSpec, type UiResponse } from "../../shared/ui-schema";
import { api } from "../lib/api";
import { isPptistTool, runPptistTool } from "../lib/pptist-bridge";
import { GenerativeUi } from "./GenerativeUi";
import { InteractionCard } from "./InteractionCard";

type Props = {
  project: ProjectState;
  activeSessionId: string;
  busy: boolean;
  awareness?: EditorAwareness;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => Promise<void>;
  onProjectChanged: () => Promise<void>;
  onApproveInteraction: (sessionId: string, interactionId: string, response: JsonObject) => Promise<void>;
  onRejectInteraction: (sessionId: string, interactionId: string, reason: string) => Promise<void>;
};

/** Distinguish same-named sessions without making the pill unreadable. */
function sessionLabel(session: SessionMeta, index: number): string {
  const title = session.title.trim();
  const generic = /^(new .*agent session|main agent session)$/i.test(title);
  if (!generic) return title.length > 18 ? `${title.slice(0, 17)}…` : title;
  return index === 0 ? "Current session" : `Session ${index + 1}`;
}

/** Human-readable name for the selected object, falling back to a short id. */
function selectionLabel(project: ProjectState, id: string): string {
  if (project.kind === "canvas") {
    const node = project.document.nodes.find((item) => item.id === id);
    if (node) return node.title || node.type;
  }
  const slideIndex = project.kind === "ppt"
    ? project.document.deck.slides.findIndex((slide) => slide.id === id)
    : -1;
  if (slideIndex >= 0) return `slide ${slideIndex + 1}`;
  return `${id.slice(0, 8)}…`;
}

/** The tool whose input is an interactive UI spec for the client to render. */
const UI_TOOL_PART = "tool-ask_user";

export function AgentPanel(props: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentSession = props.project.sessions.find((session) => session.id === props.activeSessionId);
  const interactions = props.project.interactions.filter((interaction) => interaction.status === "pending");
  // Only work still in flight belongs here. Finished runs are in the project
  // history feed, so repeating them turns the action area into noise.
  const workflows = props.project.workflows
    .filter((workflow) => ["queued", "running", "waiting"].includes(workflow.status))
    .slice(0, 3);

  // One WebSocket per Agent session. `name` must match the worker's own
  // convention exactly, which is why it comes from shared code.
  const agent = useAgent({
    agent: "studio-agent",
    name: studioAgentName(props.project.kind, props.project.id, props.activeSessionId)
  });

  const { messages, sendMessage, addToolOutput, clearHistory, status, isStreaming } = useAgentChat({
    agent,
    // PPTist tools have no server implementation: they run here, against the
    // editor mounted in this page, and the result is handed back to the model.
    onToolCall: async ({ toolCall }) => {
      if (!isPptistTool(toolCall.toolName)) return;
      const output = await runPptistTool(toolCall.toolName, toolCall.input);
      addToolOutput({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, output });
    }
  });

  const streaming = isStreaming || status === "streaming" || status === "submitted";

  // Sessions accumulate over a demo and mostly share a default name. Keep the
  // active one plus the few most recent, and count the rest.
  const ordered = [...props.project.sessions].sort((a, b) =>
    a.id === props.activeSessionId ? -1 : b.id === props.activeSessionId ? 1 : 0
  );
  const visibleSessions = ordered.slice(0, 4);
  const hiddenSessionCount = ordered.length - visibleSessions.length;

  // The agent's tools mutate the project, so refresh it once a turn settles.
  const settledCount = streaming ? -1 : messages.length;
  useEffect(() => {
    if (settledCount <= 0) return;
    void props.onProjectChanged();
  }, [settledCount]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, streaming, interactions.length]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value || streaming) return;
    setDraft("");
    // Selection is agent config, not chat content, so it is pushed before the
    // turn rather than smuggled into the prompt.
    if (props.awareness) {
      await api.setAwareness(props.project.kind, props.project.id, props.activeSessionId, props.awareness)
        .catch(() => undefined);
    }
    sendMessage({ text: value });
  };

  const starters = props.project.kind === "ppt"
    ? ["Change the deck theme.", "Make the selected slide more decisive.", "Rebuild this as an 8-slide investor deck with approval."]
    : ["Duplicate the selected node.", "Add a note summarizing this direction.", "Generate four premium 4:5 launch concepts with approval."];

  return (
    <aside className="agent-panel">
      <header className="agent-header">
        <div>
          <span className="eyebrow">Project Agent</span>
          <h2>{currentSession?.title ?? "Agent Session"}</h2>
        </div>
        <button className="icon-button" title="New session" aria-label="Start a new agent session" onClick={() => void props.onCreateSession()}>＋</button>
      </header>

      <div className="session-strip" role="tablist" aria-label="Agent sessions">
        {visibleSessions.map((session: SessionMeta, index: number) => (
          <button
            key={session.id}
            className={session.id === props.activeSessionId ? "session-pill active" : "session-pill"}
            role="tab"
            aria-selected={session.id === props.activeSessionId}
            title={session.title}
            onClick={() => props.onSelectSession(session.id)}
          >
            {sessionLabel(session, index)}
          </button>
        ))}
        {hiddenSessionCount > 0 && (
          <span className="session-more" title={`${hiddenSessionCount} older sessions`}>+{hiddenSessionCount}</span>
        )}
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

      <div className="chat-scroll" ref={scrollRef} role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && !streaming && (
          <div className="chat-empty">
            <div className="agent-orb">AI</div>
            <h3>Fresh session, same project.</h3>
            <p>The chat history is empty, but the Agent reads the latest project revision and current editor selection every turn.</p>
            <div className="starter-list">
              {starters.map((starter) => <button key={starter} onClick={() => setDraft(starter)}>{starter}</button>)}
            </div>
          </div>
        )}

        {messages.map((message: UIMessage) => (
          <MessageBubble
            key={message.id}
            message={message}
            streaming={streaming}
            onUiResponse={(toolCallId, response) =>
              addToolOutput({ toolCallId, toolName: "ask_user", output: response })
            }
          />
        ))}

        {streaming && <div className="typing-indicator"><span /><span /><span /></div>}

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
        {props.awareness?.activeId && (
          <div className="selection-context">
            {/* The raw id is the agent's handle, not the user's — show what they
                actually selected and keep the id in the tooltip for debugging. */}
            <i />Agent is looking at <strong>{selectionLabel(props.project, props.awareness.activeId)}</strong>
            <span title={props.awareness.activeId} aria-hidden>ⓘ</span>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask the Agent to edit this project…"
          rows={3}
        />
        <div>
          <button type="button" className="text-button" onClick={() => clearHistory()}>Clear chat</button>
          <button className="button primary" disabled={streaming || !draft.trim()}>
            {streaming ? "Working…" : "Send"}
          </button>
        </div>
      </form>
    </aside>
  );
}

function MessageBubble({
  message,
  streaming,
  onUiResponse
}: {
  message: UIMessage;
  streaming: boolean;
  onUiResponse: (toolCallId: string, response: UiResponse) => void;
}) {
  const text = useMemo(
    () =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => ("text" in part ? String(part.text) : ""))
        .join("\n")
        .trim(),
    [message.parts]
  );

  const toolActivity = message.parts
    .filter((part) => part.type.startsWith("tool-") && part.type !== UI_TOOL_PART)
    .map((part) => part.type.replace(/^tool-/, ""));

  return (
    <>
      {(text || toolActivity.length > 0) && (
        <div className={`message ${message.role}`}>
          <span>{message.role === "user" ? "You" : "Agent"}</span>
          <div>
            {text || (streaming ? "Working…" : "Completed a tool action.")}
            {toolActivity.length > 0 && (
              <div className="tool-trace">
                {toolActivity.map((name, index) => <code key={`${name}-${index}`}>{name}</code>)}
              </div>
            )}
          </div>
        </div>
      )}

      {message.parts.map((part, index) => {
        if (part.type !== UI_TOOL_PART) return null;
        const source = part as { toolCallId?: string; state?: string; input?: unknown; output?: unknown };
        // A spec the client cannot render must still say so. Returning null
        // here is what made the agent look like it had hung.
        if (!source.toolCallId) return null;
        const spec = parseUiSpec(source.input);
        if (!spec) {
          return (
            <div key={`${message.id}-ui-${index}`} className="generative-slot">
              <section className="generative-card invalid">
                <div className="interaction-kicker">Couldn’t render this card</div>
                <p>The agent asked a question this app can’t display. Ask it to rephrase, or answer in the chat.</p>
              </section>
            </div>
          );
        }
        const answered = source.state === "output-available" || source.state === "output-error";
        return (
          <div key={`${message.id}-ui-${index}`} className="generative-slot">
            <GenerativeUi
              spec={spec}
              active={!answered && !streaming}
              onSubmit={(response) => onUiResponse(source.toolCallId!, response)}
            />
            {answered && (
              <div className="generative-answer">
                Answered: {describeUiResponse((source.output ?? {}) as UiResponse)}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

import {
  mountPptist,
  unmountPptist,
  type PptistDocument as EmbedDocument,
  type PptistMountResult
} from "@lofcz/pptist";
import "@lofcz/pptist/embed.css";

/**
 * The embeddable editor.
 *
 * Loaded in an iframe by a host application, authenticated by an embed session
 * token in the query string. It talks to the public API only — the same routes
 * a third party could call themselves — so nothing here has privileges the
 * integrator's own key does not.
 *
 * The host communicates over `postMessage` rather than by reaching into the
 * frame: cross-origin DOM access is impossible by design, and a message
 * protocol is the contract that survives us changing what is inside.
 */

type HostCommand =
  | { type: "save" }
  | { type: "getContent" }
  | { type: "setContent"; content: unknown }
  | { type: "sendMessage"; content: string }
  | { type: "startRun"; flow: string; input?: Record<string, unknown> };

type EmbedEvent =
  | { type: "ready"; assetId: string; version: number }
  | { type: "change"; dirty: boolean }
  | { type: "saved"; version: number }
  | { type: "content"; content: unknown; version: number }
  | { type: "run"; run: unknown }
  | { type: "message"; message: unknown }
  | { type: "error"; code: string; message: string };

const NAMESPACE = "creative-agent";

/**
 * Every frame the host might legitimately be on is unknown to us, so events go
 * to "*" and the *host* verifies `event.origin`. The SDK does exactly that.
 * Nothing secret is ever posted — the token stays inside this frame.
 */
function emit(event: EmbedEvent): void {
  window.parent?.postMessage({ source: NAMESPACE, ...event }, "*");
}

class EmbedApi {
  constructor(private token: string) {}

  async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
        authorization: `Bearer ${this.token}`
      }
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({ code: "unknown", detail: response.statusText })) as {
        code?: string;
        detail?: string;
      };
      throw new Error(`${problem.code ?? "error"}: ${problem.detail ?? response.statusText}`);
    }
    return response;
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>;
  }
}

function decodeAssetId(token: string): string | null {
  // The token's claims are a base64url JSON payload. Reading the asset id from
  // it saves a round trip; it is not trusted for anything — the server
  // re-verifies the signature on every call.
  try {
    const payload = token.split(".")[0];
    if (!payload) return null;
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(padded)) as { projectId?: string };
    return claims.projectId ?? null;
  } catch {
    return null;
  }
}

export async function mountEmbed(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  root.replaceChildren();
  root.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;";

  if (!token) {
    root.textContent = "Missing embed token.";
    emit({ type: "error", code: "missing_token", message: "No embed token was supplied." });
    return;
  }

  const assetId = decodeAssetId(token);
  if (!assetId) {
    root.textContent = "Malformed embed token.";
    emit({ type: "error", code: "invalid_token", message: "The embed token could not be read." });
    return;
  }

  const api = new EmbedApi(token);
  let version = 0;
  let dirty = false;
  let mounted: PptistMountResult | null = null;
  // The echo of our own save must not be mistaken for a host edit.
  let lastDeck = "";

  try {
    const content = await api.json<{ version: number; content: { deck?: EmbedDocument } }>(
      `/v1/assets/${assetId}/content`
    );
    version = content.version;
    const deck = content.content.deck;
    lastDeck = JSON.stringify(deck ?? null);

    const stage = document.createElement("div");
    stage.style.cssText = "flex:1;min-height:0;";
    root.appendChild(stage);

    mounted = await mountPptist(stage, {
      locale: "en",
      document: deck,
      showLoadingData: false,
      // The in-editor exporters pull a prebuilt chunk far larger than the
      // platform's per-asset limit; export runs server-side instead.
      exportTabs: { pptx: false, image: false, json: false, pdf: false, pptist: false },
      onChangeDebounceMs: 600,
      onChange: (next) => {
        const serialized = JSON.stringify(next);
        if (serialized === lastDeck) return;
        lastDeck = serialized;
        dirty = true;
        emit({ type: "change", dirty: true });
      }
    });

    // Re-baseline from the editor's own document, not the payload we sent it.
    // PPTist normalises on load (filling defaults), so its first change event
    // carries a document that differs from the stored JSON even though nobody
    // edited anything — and comparing the two shapes reports the asset dirty
    // the moment it opens, which would warn the user about unsaved work on a
    // file they have not touched.
    lastDeck = JSON.stringify(mounted.controller.getDocument());

    emit({ type: "ready", assetId, version });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.textContent = `Could not open this asset: ${message}`;
    emit({ type: "error", code: "load_failed", message });
    return;
  }

  async function save(): Promise<void> {
    const deck = mounted?.controller.getDocument();
    if (!deck) return;
    const saved = await api.json<{ version: number }>(`/v1/assets/${assetId}/content`, {
      method: "PUT",
      body: JSON.stringify({ content: { deck }, version })
    });
    version = saved.version;
    lastDeck = JSON.stringify(deck);
    dirty = false;
    emit({ type: "saved", version });
  }

  window.addEventListener("message", (event: MessageEvent) => {
    const command = event.data as HostCommand & { source?: string };
    // Ignore our own outbound events and anything not addressed to us.
    if (!command || typeof command !== "object" || command.source === NAMESPACE) return;

    void (async () => {
      try {
        switch (command.type) {
          case "save":
            await save();
            break;
          case "getContent":
            emit({ type: "content", content: { deck: mounted?.controller.getDocument() }, version });
            break;
          case "setContent": {
            const deck = (command.content as { deck?: EmbedDocument })?.deck;
            if (deck) {
              lastDeck = JSON.stringify(deck);
              mounted?.controller.setDocument(deck);
            }
            break;
          }
          case "sendMessage": {
            const sessions = await api.json<{ data: Array<{ id: string }> }>(`/v1/assets/${assetId}/sessions`);
            const sessionId =
              sessions.data[0]?.id ??
              (await api.json<{ id: string }>(`/v1/assets/${assetId}/sessions`, {
                method: "POST",
                body: JSON.stringify({ title: "Embedded session" })
              })).id;
            const message = await api.json(
              `/v1/assets/${assetId}/sessions/${sessionId}/messages`,
              { method: "POST", body: JSON.stringify({ content: command.content }) }
            );
            emit({ type: "message", message });
            break;
          }
          case "startRun": {
            const run = await api.json(`/v1/assets/${assetId}/runs`, {
              method: "POST",
              body: JSON.stringify({ flow: command.flow, input: command.input ?? {} })
            });
            emit({ type: "run", run });
            break;
          }
        }
      } catch (error) {
        emit({
          type: "error",
          code: "command_failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    })();
  });

  // A host that navigates away mid-edit should not lose work silently.
  window.addEventListener("beforeunload", (event) => {
    if (dirty) event.preventDefault();
  });

  window.addEventListener("pagehide", () => {
    const result = mounted;
    mounted = null;
    if (result) void unmountPptist(result);
  });
}

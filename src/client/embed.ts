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
 * Loaded in an iframe by a host application and authenticated by an embed
 * session token the host hands over after load — never through the URL. It
 * talks to the public API only, with the same routes and the same `Authorization`
 * header a third party would use, so nothing here has privileges the
 * integrator's own key does not.
 *
 * The host communicates over `postMessage` rather than by reaching into the
 * frame: cross-origin DOM access is impossible by design, and a message
 * protocol is the contract that survives us changing what is inside.
 */

type HostCommand =
  | { type: "auth"; token: string }
  | { type: "save" }
  | { type: "getContent" }
  | { type: "setContent"; content: unknown }
  | { type: "sendMessage"; content: string }
  | { type: "startRun"; flow: string; input?: Record<string, unknown> };

type EmbedEvent =
  | { type: "auth_required" }
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

/**
 * Obtain the embed token without ever putting it in a request URL.
 *
 * Preferred path: the host asks for it. The frame loads with no credential,
 * announces itself, and the host replies with the token over `postMessage`.
 * Nothing reaches an access log, a `Referer` header, or browser history.
 *
 * Fallback for hosts not using the SDK: a URL *fragment*. Fragments are never
 * sent to the server, and it is stripped from history immediately on read, so
 * the exposure is one entry in the embedding page's own memory rather than a
 * line in every log between here and the origin.
 */
function acquireToken(timeoutMs = 15_000): Promise<string | null> {
  const fragment = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (fragment) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return Promise.resolve(fragment);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      // Only the embedding window may supply a credential. Its origin is
      // unknown to us by design — a host may embed from anywhere — but a token
      // from an unrelated frame is worthless anyway: it would be that sender's
      // own token, granting no access it did not already have.
      if (event.source !== window.parent) return;
      const data = event.data as { type?: string; token?: string } | null;
      if (!data || data.type !== "auth" || typeof data.token !== "string" || !data.token) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data.token);
    }

    window.addEventListener("message", onMessage);
    emit({ type: "auth_required" });
  });
}

export async function mountEmbed(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  root.replaceChildren();
  root.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;";

  const token = await acquireToken();
  if (!token) {
    root.textContent = "This editor was not given a token.";
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
  /**
   * "Dirty" means a person changed something, so it is gated on a person having
   * touched the editor. The editor keeps settling after mount resolves — layout
   * measurement and auto-fit rewrite the document asynchronously — and those
   * writes are indistinguishable from edits by content comparison alone.
   * Re-baselining after mount narrowed the window but did not close it; an
   * interaction gate closes it, and states the actual rule.
   */
  let userInteracted = false;

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
    for (const kind of ["pointerdown", "keydown"] as const) {
      stage.addEventListener(kind, () => { userInteracted = true; }, { capture: true, once: false });
    }

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
        // Settling writes still move the baseline forward, so a later real
        // edit is still detected — they just do not raise the flag.
        if (!userInteracted) return;
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

/**
 * Creative Agent browser SDK.
 *
 * Two things a host page needs and should not have to write itself:
 *
 *   CreativeAgent.mount(el, {token})   — an editor in an iframe, with a typed
 *                                        message bridge instead of raw
 *                                        postMessage plumbing.
 *   CreativeAgent.client({token})      — the REST surface, scoped to whatever
 *                                        the embed session was granted.
 *
 * Served as plain ES-module JavaScript with no build step, so it can be dropped
 * into any stack:
 *
 *   <script type="module">
 *     import { CreativeAgent } from "https://…/sdk.js";
 *     const editor = CreativeAgent.mount(document.querySelector("#editor"), {
 *       token: embedSession.token
 *     });
 *     editor.on("saved", ({version}) => console.log("saved v" + version));
 *   </script>
 *
 * Embed session tokens are short-lived and pinned to one asset, which is what
 * makes them safe to put in a browser. API keys are not: minting a session is a
 * server-side call, and this SDK deliberately provides no way to do it.
 */

const NAMESPACE = "creative-agent";

class ApiError extends Error {
  constructor(problem, status) {
    super(problem.detail || problem.title || `Request failed with ${status}`);
    this.name = "ApiError";
    this.code = problem.code || "unknown";
    this.status = status;
    this.requestId = problem.request_id;
    this.errors = problem.errors || [];
  }
}

function createClient({ token, origin = "" }) {
  if (!token) throw new Error("CreativeAgent: a token is required.");

  async function request(path, { method = "GET", body, idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    // Retries of a create are otherwise indistinguishable from two creates.
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(payload, response.status);
    return payload;
  }

  return {
    request,
    capabilities: () => request("/v1/capabilities"),
    me: () => request("/v1/me"),

    assets: {
      list: (params = {}) => request(`/v1/assets?${new URLSearchParams(params)}`),
      create: (body, idempotencyKey) => request("/v1/assets", { method: "POST", body, idempotencyKey }),
      get: (id) => request(`/v1/assets/${id}`),
      update: (id, body) => request(`/v1/assets/${id}`, { method: "PATCH", body }),
      delete: (id) => request(`/v1/assets/${id}`, { method: "DELETE" }),
      getContent: (id) => request(`/v1/assets/${id}/content`),
      // `version` is required: a blind write would silently discard whatever
      // the agent changed while the caller was editing.
      setContent: (id, content, version) =>
        request(`/v1/assets/${id}/content`, { method: "PUT", body: { content, version } }),
      history: (id) => request(`/v1/assets/${id}/history`),
      files: (id) => request(`/v1/assets/${id}/files`),
      fileUrl: (id, fileId) => `${origin}/v1/assets/${id}/files/${fileId}/content`
    },

    sessions: {
      list: (assetId) => request(`/v1/assets/${assetId}/sessions`),
      create: (assetId, body = {}) => request(`/v1/assets/${assetId}/sessions`, { method: "POST", body }),
      messages: (assetId, sessionId) => request(`/v1/assets/${assetId}/sessions/${sessionId}/messages`),
      send: (assetId, sessionId, content) =>
        request(`/v1/assets/${assetId}/sessions/${sessionId}/messages`, { method: "POST", body: { content } })
    },

    runs: {
      start: (assetId, flow, input = {}, idempotencyKey) =>
        request(`/v1/assets/${assetId}/runs`, { method: "POST", body: { flow, input }, idempotencyKey }),
      list: (assetId) => request(`/v1/assets/${assetId}/runs`),
      get: (assetId, runId) => request(`/v1/assets/${assetId}/runs/${runId}`),
      respond: (assetId, runId, actionId, response) =>
        request(`/v1/assets/${assetId}/runs/${runId}/actions/${actionId}`, { method: "POST", body: { response } }),
      decline: (assetId, runId, actionId, reason) =>
        request(`/v1/assets/${assetId}/runs/${runId}/actions/${actionId}`, {
          method: "POST",
          body: { decline: true, reason }
        }),

      /**
       * Poll a run to completion, surfacing pauses that need a human answer.
       *
       * Flows stop and wait rather than guessing, so a caller that only polls
       * for "succeeded" waits forever. `onAction` is where the host decides;
       * returning a value answers the pause, returning nothing leaves it for a
       * person to handle in the UI.
       */
      async wait(assetId, runId, { onProgress, onAction, intervalMs = 3000, timeoutMs = 900000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        let answered = new Set();
        while (Date.now() < deadline) {
          const run = await this.get(assetId, runId);
          onProgress?.(run);
          if (run.status === "requires_action" && run.required_action) {
            const action = run.required_action.action;
            if (onAction && !answered.has(action.id)) {
              answered.add(action.id);
              const response = await onAction(action);
              if (response !== undefined && response !== null) {
                await this.respond(assetId, runId, action.id, response);
              }
            }
          }
          if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms`);
      }
    }
  };
}

function mount(container, { token, origin = "", readonly = false, theme = "light", className } = {}) {
  if (!container) throw new Error("CreativeAgent.mount: a container element is required.");
  if (!token) throw new Error("CreativeAgent.mount: a token is required.");

  const frameOrigin = origin || window.location.origin;
  const iframe = document.createElement("iframe");
  // No credential in the frame URL. The editor announces itself once loaded and
  // is handed the token over postMessage, so it never reaches an access log, a
  // Referer header or browser history.
  const params = new URLSearchParams({ theme });
  if (readonly) params.set("readonly", "true");
  iframe.src = `${frameOrigin}/embed?${params}`;
  iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
  if (className) iframe.className = className;
  iframe.setAttribute("title", "Creative Agent editor");
  // The editor needs scripts and same-origin for its own API calls; it is not
  // granted top-level navigation, so it cannot navigate the host away.
  iframe.setAttribute("allow", "clipboard-write");
  container.replaceChildren(iframe);

  const listeners = new Map();
  const ready = { resolved: false, resolve: null, promise: null };
  ready.promise = new Promise((resolve) => {
    ready.resolve = resolve;
  });

  function onMessage(event) {
    // Only trust frames we created, and only messages that name our protocol.
    if (event.source !== iframe.contentWindow) return;
    if (new URL(frameOrigin).origin !== event.origin) return;
    const data = event.data;
    if (!data || data.source !== NAMESPACE) return;
    if (data.type === "auth_required") {
      // Targeted at the frame's own origin, never "*", so no other document can
      // receive the token even if one is listening.
      iframe.contentWindow?.postMessage({ type: "auth", token }, frameOrigin);
      return;
    }
    if (data.type === "ready" && !ready.resolved) {
      ready.resolved = true;
      ready.resolve(data);
    }
    for (const listener of listeners.get(data.type) ?? []) listener(data);
    for (const listener of listeners.get("*") ?? []) listener(data);
  }
  window.addEventListener("message", onMessage);

  function post(command) {
    iframe.contentWindow?.postMessage(command, frameOrigin);
  }

  return {
    iframe,
    ready: ready.promise,
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type)?.delete(listener);
    },
    save: () => post({ type: "save" }),
    getContent: () => post({ type: "getContent" }),
    setContent: (content) => post({ type: "setContent", content }),
    sendMessage: (content) => post({ type: "sendMessage", content }),
    startRun: (flow, input) => post({ type: "startRun", flow, input }),
    destroy() {
      window.removeEventListener("message", onMessage);
      iframe.remove();
      listeners.clear();
    }
  };
}

export const CreativeAgent = { mount, client: createClient, ApiError };
export default CreativeAgent;

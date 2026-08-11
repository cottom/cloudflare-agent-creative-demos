import type {
  CanvasVariantsWorkflowParams,
  ChatMessage,
  EditorAwareness,
  JsonObject,
  MutationResult,
  PptBuildWorkflowParams,
  ProjectKind,
  ProjectMutation,
  ProjectState
} from "../../shared/types";

/** The wire shape is defined once, in shared/types, and served by the agent. */
export type ClientMessage = ChatMessage;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error ?? `Request failed: ${response.status}`);
  return payload;
}

export const api = {
  bootstrap: () => request<{
    projects: { ppt: ProjectState; canvas: ProjectState };
    defaults: Record<ProjectKind, { projectId: string; sessionId: string; title: string }>;
    models: { llm: string; image: string };
  }>("/api/bootstrap", { method: "POST" }),

  getProject: (kind: ProjectKind, projectId: string) =>
    request<ProjectState>(`/api/projects/${kind}/${encodeURIComponent(projectId)}`),

  /** Poll variant: returns `{ unchanged: true }` when nothing in the project moved. */
  getProjectSince: (kind: ProjectKind, projectId: string, since: number) =>
    request<ProjectState | { unchanged: true; stateVersion: number }>(
      `/api/projects/${kind}/${encodeURIComponent(projectId)}?since=${since}`
    ),

  mutate: (kind: ProjectKind, projectId: string, mutation: ProjectMutation) =>
    request<MutationResult>(`/api/projects/${kind}/${encodeURIComponent(projectId)}/mutate`, {
      method: "POST",
      body: JSON.stringify(mutation)
    }),

  createSession: (kind: ProjectKind, projectId: string, title?: string) =>
    request<{ sessionId: string; project: ProjectState }>(`/api/projects/${kind}/${encodeURIComponent(projectId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({ title })
    }),

  renameSession: (kind: ProjectKind, projectId: string, sessionId: string, title: string) =>
    request<ProjectState>(`/api/projects/${kind}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title })
    }),

  getMessages: (kind: ProjectKind, projectId: string, sessionId: string) =>
    request<{ messages: ClientMessage[] }>(`/api/projects/${kind}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`),

  sendMessage: (kind: ProjectKind, projectId: string, sessionId: string, text: string, awareness?: EditorAwareness) =>
    request<{ submissionId: string; accepted: boolean; messages: ClientMessage[]; project: ProjectState }>(`/api/projects/${kind}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, awareness })
    }),

  setAwareness: (kind: ProjectKind, projectId: string, sessionId: string, awareness?: EditorAwareness) =>
    request<{ ok: true }>(`/api/projects/${kind}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/awareness`, {
      method: "POST",
      body: JSON.stringify({ awareness })
    }),

  clearMessages: (kind: ProjectKind, projectId: string, sessionId: string) =>
    request<{ ok: true; messages: ClientMessage[] }>(`/api/projects/${kind}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/clear`, {
      method: "POST",
      body: JSON.stringify({})
    }),

  startPptBuild: (projectId: string, sessionId: string, params: Omit<PptBuildWorkflowParams, "projectId" | "sessionId">) =>
    request<{ workflowId: string }>(`/api/projects/ppt/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/workflows/ppt-build`, {
      method: "POST",
      body: JSON.stringify(params)
    }),

  startCanvasVariants: (projectId: string, sessionId: string, params: Omit<CanvasVariantsWorkflowParams, "projectId" | "sessionId">) =>
    request<{ workflowId: string }>(`/api/projects/canvas/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/workflows/canvas-variants`, {
      method: "POST",
      body: JSON.stringify(params)
    }),

  resolveInteraction: (kind: ProjectKind, projectId: string, sessionId: string, interactionId: string, response: JsonObject) =>
    request(`/api/projects/${kind}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ response })
    }),

  rejectInteraction: (kind: ProjectKind, projectId: string, sessionId: string, interactionId: string, reason: string) =>
    request(`/api/projects/${kind}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason })
    }),

  generateSlideImage: (projectId: string, slideId: string, prompt: string) =>
    request<{ assetKey: string; artifact: { key: string; name: string } }>(`/api/projects/ppt/${encodeURIComponent(projectId)}/generate-image`, {
      method: "POST",
      body: JSON.stringify({ slideId, prompt })
    }),

  exportPpt: (projectId: string) =>
    request<{ artifact: { key: string; name: string }; url: string }>(`/api/projects/ppt/${encodeURIComponent(projectId)}/export`, {
      method: "POST",
      body: JSON.stringify({})
    }),

  workspace: (kind: ProjectKind, projectId: string) =>
    request<{ files: Array<{ path: string; name: string; isDirectory: boolean }> }>(`/api/projects/${kind}/${encodeURIComponent(projectId)}/workspace`)
};

export function messageText(message: ClientMessage): string {
  return message.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

export function assetUrl(key: string): string {
  return `/api/artifacts?key=${encodeURIComponent(key)}`;
}

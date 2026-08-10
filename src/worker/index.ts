import { getAgentByName, routeAgentRequest } from "agents";
import type {
  CanvasVariantsWorkflowParams,
  EditorAwareness,
  PptBuildWorkflowParams,
  ProjectKind,
  ProjectMutation,
  ProjectState,
  SessionMeta,
  StudioAgentConfig
} from "../shared/types";
import { getProjectStub, listWorkspace, readProject, syncProjectWorkspace } from "./lib/project-access";
import { savePresentationExport } from "./lib/artifacts";
import { StudioAgent, studioAgentName } from "./studio-agent";

export { PptProject, CanvasProject } from "./project/project-do";
export { StudioAgent } from "./studio-agent";
export { PptBuildWorkflow } from "./workflows/ppt-build";
export { CanvasVariantsWorkflow } from "./workflows/canvas-variants";

const DEMOS = {
  ppt: { projectId: "ppt-demo", sessionId: "ppt-session-main", title: "Main PPT Agent" },
  canvas: { projectId: "canvas-demo", sessionId: "canvas-session-main", title: "Main Canvas Agent" }
} as const;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

async function readJson<T>(request: Request): Promise<T> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new HttpError(415, "Expected application/json");
  return request.json() as Promise<T>;
}

function parseKind(value: string | undefined): ProjectKind {
  if (value === "ppt" || value === "canvas") return value;
  throw new HttpError(404, "Unknown project kind");
}

async function getStudioAgent(env: Env, kind: ProjectKind, projectId: string, sessionId: string) {
  return getAgentByName<Env, StudioAgent>(
    env.STUDIO_AGENT,
    studioAgentName(kind, projectId, sessionId)
  );
}

async function configureAgent(
  env: Env,
  kind: ProjectKind,
  projectId: string,
  sessionId: string,
  title: string
) {
  const agent = await getStudioAgent(env, kind, projectId, sessionId);
  const config: StudioAgentConfig = { projectId, kind, sessionId, title };
  await agent.configureForProject(config);
  return agent;
}

async function bootstrapDemo(env: Env) {
  const pptStub = getProjectStub(env, "ppt", DEMOS.ppt.projectId);
  const canvasStub = getProjectStub(env, "canvas", DEMOS.canvas.projectId);
  const ppt = await pptStub.initialize(DEMOS.ppt.projectId) as ProjectState;
  const canvas = await canvasStub.initialize(DEMOS.canvas.projectId) as ProjectState;
  await Promise.all([
    syncProjectWorkspace(env, ppt),
    syncProjectWorkspace(env, canvas),
    configureAgent(env, "ppt", DEMOS.ppt.projectId, DEMOS.ppt.sessionId, DEMOS.ppt.title),
    configureAgent(env, "canvas", DEMOS.canvas.projectId, DEMOS.canvas.sessionId, DEMOS.canvas.title)
  ]);
  return {
    projects: {
      ppt: await readProject(env, "ppt", DEMOS.ppt.projectId),
      canvas: await readProject(env, "canvas", DEMOS.canvas.projectId)
    },
    defaults: DEMOS,
    models: {
      llm: (env as Env & { LLM_MODEL?: string }).LLM_MODEL ?? "@cf/moonshotai/kimi-k2.6",
      image: (env as Env & { IMAGE_MODEL?: string }).IMAGE_MODEL ?? "@cf/black-forest-labs/flux-1-schnell"
    }
  };
}

async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, service: "cloudflare-creative-agent-demos", at: new Date().toISOString() });
  }
  if (method === "POST" && url.pathname === "/api/bootstrap") {
    return json(await bootstrapDemo(env));
  }
  if (method === "GET" && url.pathname === "/api/artifacts") {
    const key = url.searchParams.get("key");
    if (!key) throw new HttpError(400, "Missing artifact key");
    const object = await env.ARTIFACTS.get(key);
    if (!object) throw new HttpError(404, "Artifact not found");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, max-age=300");
    if (url.searchParams.get("download") === "1") {
      headers.set("content-disposition", `attachment; filename="${key.split("/").at(-1) ?? "artifact"}"`);
    }
    return new Response(object.body, { headers });
  }

  // /api/projects/:kind/:projectId
  if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3]) {
    const kind = parseKind(parts[2]);
    const projectId = decodeURIComponent(parts[3]);
    const projectStub = getProjectStub(env, kind, projectId);
    await projectStub.initialize(projectId);

    if (parts.length === 4 && method === "GET") {
      return json(await projectStub.getSnapshot());
    }
    if (parts.length === 5 && parts[4] === "mutate" && method === "POST") {
      const mutation = await readJson<ProjectMutation>(request);
      const result = await projectStub.applyMutation(mutation);
      if (!result.ok) return json(result, 409);
      await syncProjectWorkspace(env, result.state);
      return json(result);
    }
    if (parts.length === 5 && parts[4] === "workspace" && method === "GET") {
      return json({ files: await listWorkspace(env, kind, projectId) });
    }
    if (parts.length === 5 && parts[4] === "export" && kind === "ppt" && method === "POST") {
      const state = await readProject(env, "ppt", projectId);
      if (state.kind !== "ppt") throw new HttpError(400, "Not a PPT project");
      const artifact = await savePresentationExport(env, state);
      return json({ artifact, url: `/api/artifacts?key=${encodeURIComponent(artifact.key)}&download=1` });
    }

    // /api/projects/:kind/:projectId/sessions
    if (parts[4] === "sessions") {
      if (parts.length === 5 && method === "POST") {
        const body = await readJson<{ title?: string }>(request);
        const sessionId = `${kind}-session-${crypto.randomUUID()}`;
        const title = body.title?.trim() || `New ${kind === "ppt" ? "PPT" : "Canvas"} Agent Session`;
        await configureAgent(env, kind, projectId, sessionId, title);
        return json({ sessionId, project: await projectStub.getSnapshot() }, 201);
      }
      const sessionId = parts[5];
      if (!sessionId) throw new HttpError(404, "Missing session id");
      const agent = await getStudioAgent(env, kind, projectId, sessionId);

      if (parts.length === 6 && method === "PATCH") {
        const body = await readJson<{ title: string }>(request);
        await projectStub.renameSession(sessionId, body.title);
        await agent.configureForProject({ projectId, kind, sessionId, title: body.title });
        return json(await projectStub.getSnapshot());
      }
      if (parts[6] === "messages" && parts.length === 7 && method === "GET") {
        return json({ messages: await agent.getConversation() });
      }
      if (parts[6] === "messages" && parts.length === 7 && method === "POST") {
        const body = await readJson<{ text: string; awareness?: EditorAwareness }>(request);
        const turn = await agent.sendUserMessage(body.text, body.awareness);
        return json({ ...turn, project: await projectStub.getSnapshot() });
      }
      if (parts[6] === "clear" && parts.length === 7 && method === "POST") {
        await agent.clearConversation();
        return json({ ok: true, messages: [] });
      }
      if (parts[6] === "workflows" && parts[7] === "ppt-build" && method === "POST") {
        if (kind !== "ppt") throw new HttpError(400, "PPT workflow requires a PPT project");
        const body = await readJson<Omit<PptBuildWorkflowParams, "projectId" | "sessionId">>(request);
        return json(await agent.startPptBuildWorkflow(body), 202);
      }
      if (parts[6] === "workflows" && parts[7] === "canvas-variants" && method === "POST") {
        if (kind !== "canvas") throw new HttpError(400, "Canvas workflow requires a canvas project");
        const body = await readJson<Omit<CanvasVariantsWorkflowParams, "projectId" | "sessionId">>(request);
        return json(await agent.startCanvasVariantsWorkflow(body), 202);
      }
      if (parts[6] === "interactions" && parts[7] && parts[8] === "resolve" && method === "POST") {
        const body = await readJson<{ response: Record<string, unknown> }>(request);
        return json(await agent.resolveInteraction(decodeURIComponent(parts[7]), body.response));
      }
      if (parts[6] === "interactions" && parts[7] && parts[8] === "reject" && method === "POST") {
        const body = await readJson<{ reason?: string }>(request);
        return json(await agent.rejectInteraction(decodeURIComponent(parts[7]), body.reason ?? "Rejected by user"));
      }
    }
  }

  throw new HttpError(404, "API route not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const api = await handleApi(request, env);
      if (api) return api;

      const agentResponse = await routeAgentRequest(request, env, { prefix: "agents" });
      if (agentResponse) return agentResponse;

      return env.ASSETS.fetch(request);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      console.error(error);
      return json({ error: message }, status);
    }
  }
} satisfies ExportedHandler<Env>;

import { getAgentByName } from "agents";
import {
  isAssetKind,
  listAssetKinds,
  projectObjectName,
  requireAssetKind
} from "../../shared/asset-kinds";
import {
  canAccessProject,
  generateApiKey,
  hasScope,
  signEmbedToken,
  timingSafeEqualUtf8,
  type Principal,
  type Scope
} from "./auth";
import { resolvePrincipal } from "./principal";
import { getWorkflow, listWorkflows, validateWorkflowParams, workflowsForKind } from "./workflows";
import { StudioAgent, studioAgentName } from "../studio-agent";
import type { EditorAwareness, JsonObject, ProjectKind, ProjectMutation } from "../../shared/types";

/**
 * Versioned, tenant-scoped API.
 *
 * `/api/*` remains the single-tenant demo plane and is left untouched; `/v1/*`
 * is the integration surface. They address different Durable Object names on
 * purpose — a demo project and a tenant's project of the same id are different
 * documents — so the two planes cannot collide.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

async function readJson<T>(request: Request): Promise<T> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    throw new ApiError(415, "Expected application/json");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, "Malformed JSON body");
  }
}

function requireScope(principal: Principal, scope: Scope): void {
  if (!hasScope(principal, scope)) throw new ApiError(403, `Missing required scope: ${scope}`);
}

function tenantStub(env: Env, tenantId: string) {
  return env.TENANT.get(env.TENANT.idFromName(tenantId));
}

/**
 * Project object handle, namespaced by tenant.
 *
 * The name is the entire isolation boundary: tenant A literally cannot
 * construct the id of tenant B's object, because the tenant segment comes from
 * the verified principal rather than from anything the caller sent.
 */
function projectStub(env: Env, principal: Principal, kind: string, projectId: string) {
  const name = projectObjectName(principal.tenantId, kind, projectId);
  const namespace = kind === "ppt" ? env.PPT_PROJECT : env.CANVAS_PROJECT;
  return namespace.get(namespace.idFromName(name)) as unknown as {
    initialize(projectId: string): Promise<JsonObject>;
    getSnapshot(): Promise<JsonObject>;
    getStateVersion(): Promise<number>;
    applyMutation(mutation: ProjectMutation): Promise<JsonObject & { ok: boolean }>;
    renameSession(sessionId: string, title: string): Promise<JsonObject>;
  };
}

function agentFor(env: Env, principal: Principal, kind: string, projectId: string, sessionId: string) {
  return getAgentByName<Env, StudioAgent>(
    env.STUDIO_AGENT,
    studioAgentName(kind as ProjectKind, projectObjectName(principal.tenantId, kind, projectId), sessionId)
  );
}

function validKind(value: string | undefined): string {
  if (!value || !isAssetKind(value)) throw new ApiError(404, `Unknown asset kind: ${value ?? "(none)"}`);
  return value;
}

/**
 * Reject ids that would be ambiguous inside a composed Durable Object name.
 *
 * `projectObjectName` joins on ":", so an id containing ":" could be crafted to
 * resolve to a different tenant's object. Constraining the alphabet closes that
 * rather than escaping it, because escaping has to be right everywhere.
 */
function validId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(value)) {
    throw new ApiError(400, `Invalid ${label}: must be 1-63 chars of [A-Za-z0-9_-]`);
  }
  return value;
}

/**
 * Per-tenant rate limiting.
 *
 * Keyed by tenant rather than IP: this is a server-to-server API, so every
 * request from one integrator shares an address and IP keying would be
 * meaningless. Fails open if the binding is absent so a config gap degrades
 * throughput control rather than availability.
 */
async function enforceRateLimit(env: Env, principal: Principal, cost: "read" | "write"): Promise<void> {
  const limiter = cost === "write" ? env.WRITE_RATE_LIMITER : env.READ_RATE_LIMITER;
  if (!limiter) return;
  const { success } = await limiter.limit({ key: `${principal.tenantId}:${cost}` });
  if (!success) throw new ApiError(429, "Rate limit exceeded for this tenant");
}

/** Self-describing surface: integrators read this instead of our docs drifting. */
function metaResponse(): Response {
  return json({
    version: "v1",
    kinds: listAssetKinds().map((kind) => ({
      id: kind.id,
      label: kind.label,
      description: kind.description,
      workflows: workflowsForKind(kind.id).map((workflow) => workflow.id)
    })),
    workflows: listWorkflows().map((workflow) => ({
      id: workflow.id,
      label: workflow.label,
      description: workflow.description,
      kinds: workflow.kinds,
      requiresApproval: workflow.requiresApproval,
      params: workflow.params
    })),
    scopes: ["projects:read", "projects:write", "agent:chat", "workflows:run", "admin"]
  });
}

export async function handleV1(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) return null;
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const method = request.method.toUpperCase();

  // Unauthenticated: lets an integrator discover the surface before holding a key.
  if (method === "GET" && parts[0] === "meta") return metaResponse();

  /**
   * Provisioning plane.
   *
   * Creating the first key for a tenant cannot itself require a key, so this
   * one route authenticates against a deployment secret instead. It is
   * separated from the tenant-scoped API precisely because it is the only
   * credential that crosses tenant boundaries.
   */
  if (parts[0] === "admin") {
    const adminSecret = env.PLATFORM_ADMIN_SECRET;
    // Absent secret disables the route entirely rather than leaving it open.
    if (!adminSecret) throw new ApiError(501, "PLATFORM_ADMIN_SECRET is not configured");
    const presented = request.headers.get("x-admin-secret") ?? "";
    if (presented.length !== adminSecret.length || !timingSafeEqualUtf8(presented, adminSecret)) {
      throw new ApiError(401, "Invalid admin secret");
    }

    if (parts[1] === "tenants" && parts[3] === "keys" && method === "POST") {
      const tenantId = validId(decodeURIComponent(parts[2] ?? ""), "tenant id");
      const body = await readJson<{ name?: string; scopes?: Scope[] }>(request).catch(
        () => ({}) as { name?: string; scopes?: Scope[] }
      );
      const key = generateApiKey(tenantId);
      const record = await tenantStub(env, tenantId).addApiKey(
        key,
        body.name?.trim() || "default",
        body.scopes ?? (["projects:read", "projects:write", "agent:chat", "workflows:run"] as Scope[])
      );
      // The plaintext key is returned exactly once; only its digest is stored.
      return json({ ...record, key }, 201);
    }
    if (parts[1] === "tenants" && parts[3] === "keys" && method === "GET") {
      const tenantId = validId(decodeURIComponent(parts[2] ?? ""), "tenant id");
      return json({ keys: await tenantStub(env, tenantId).listApiKeys() });
    }
    if (parts[1] === "tenants" && parts[3] === "keys" && parts[4] && method === "DELETE") {
      const tenantId = validId(decodeURIComponent(parts[2] ?? ""), "tenant id");
      return json({ revoked: await tenantStub(env, tenantId).revokeApiKey(decodeURIComponent(parts[4])) });
    }
    if (parts[1] === "tenants" && parts[2] && parts[3] === "stats" && method === "GET") {
      const tenantId = validId(decodeURIComponent(parts[2]), "tenant id");
      return json(await tenantStub(env, tenantId).stats());
    }
    throw new ApiError(404, "Unknown admin route");
  }

  const principal = await resolvePrincipal(request, env);
  if (!principal) {
    return json({ error: "Unauthorized" }, 401, {
      "www-authenticate": 'Bearer realm="creative-agent", charset="UTF-8"'
    });
  }

  if (parts[0] === "whoami" && method === "GET") {
    return json({
      tenantId: principal.tenantId,
      scopes: principal.scopes,
      via: principal.via,
      ...(principal.projectId ? { pinnedTo: { kind: principal.kind, projectId: principal.projectId } } : {})
    });
  }

  if (parts[0] !== "projects") throw new ApiError(404, "Unknown v1 route");

  // ---- Collection: /v1/projects ---------------------------------------

  if (parts.length === 1 && method === "GET") {
    requireScope(principal, "projects:read");
    await enforceRateLimit(env, principal, "read");
    const kindFilter = url.searchParams.get("kind");
    if (kindFilter) validKind(kindFilter);
    const result = await tenantStub(env, principal.tenantId).listProjects({
      kind: kindFilter ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "1",
      cursor: url.searchParams.get("cursor"),
      limit: Number(url.searchParams.get("limit")) || undefined
    });
    return json(result);
  }

  if (parts.length === 1 && method === "POST") {
    requireScope(principal, "projects:write");
    await enforceRateLimit(env, principal, "write");
    const body = await readJson<{ kind: string; name?: string; id?: string; metadata?: Record<string, string> }>(request);
    const kind = validKind(body.kind);
    const definition = requireAssetKind(kind);
    const projectId = validId(body.id ?? `${kind}-${crypto.randomUUID()}`, "project id");
    const record = await tenantStub(env, principal.tenantId).createProject({
      id: projectId,
      kind,
      name: body.name?.trim() || `Untitled ${definition.label}`,
      metadata: body.metadata
    });
    // Index first, then materialise the document object. The reverse order can
    // leave an addressable project that no listing will ever return.
    await projectStub(env, principal, kind, projectId).initialize(projectId);
    return json(record, 201);
  }

  // ---- Item: /v1/projects/:kind/:projectId ----------------------------

  const kind = validKind(parts[1]);
  const projectId = validId(decodeURIComponent(parts[2] ?? ""), "project id");
  if (!canAccessProject(principal, kind, projectId)) {
    throw new ApiError(403, "This token is scoped to a different project");
  }
  const tenant = tenantStub(env, principal.tenantId);
  const stub = projectStub(env, principal, kind, projectId);

  if (parts.length === 3 && method === "GET") {
    requireScope(principal, "projects:read");
    await enforceRateLimit(env, principal, "read");
    const record = await tenant.getProject(projectId);
    if (!record) throw new ApiError(404, "Project not found");
    const since = Number(url.searchParams.get("since"));
    if (Number.isInteger(since)) {
      const stateVersion = await stub.getStateVersion();
      if (stateVersion === since) return json({ unchanged: true, stateVersion });
    }
    return json({ project: record, state: await stub.getSnapshot() });
  }

  if (parts.length === 3 && method === "PATCH") {
    requireScope(principal, "projects:write");
    await enforceRateLimit(env, principal, "write");
    const body = await readJson<{ name?: string }>(request);
    if (!body.name?.trim()) throw new ApiError(400, "name is required");
    await tenant.touchProject(projectId, body.name.trim());
    const record = await tenant.getProject(projectId);
    if (!record) throw new ApiError(404, "Project not found");
    return json(record);
  }

  if (parts.length === 3 && method === "DELETE") {
    requireScope(principal, "projects:write");
    await enforceRateLimit(env, principal, "write");
    const archived = await tenant.archiveProject(projectId);
    return json({ archived, projectId });
  }

  const segment = parts[3];

  if (segment === "restore" && method === "POST") {
    requireScope(principal, "projects:write");
    return json({ restored: await tenant.restoreProject(projectId) });
  }

  if (segment === "mutate" && method === "POST") {
    requireScope(principal, "projects:write");
    await enforceRateLimit(env, principal, "write");
    const mutation = await readJson<ProjectMutation>(request);
    const result = await stub.applyMutation(mutation);
    if (!result.ok) return json(result, 409);
    // The index's ordering is derived from document activity, so it is updated
    // after the authoritative write rather than inside its latency budget.
    ctx.waitUntil(tenant.touchProject(projectId).catch(() => {}));
    return json(result);
  }

  /**
   * Mint a browser-safe token for an embedded editor.
   *
   * Scopes are intersected with the caller's, never widened, so an integrator
   * cannot mint a token more powerful than the key that requested it.
   */
  if (segment === "embed-token" && method === "POST") {
    requireScope(principal, "projects:write");
    const secret = env.EMBED_TOKEN_SECRET;
    if (!secret) throw new ApiError(501, "EMBED_TOKEN_SECRET is not configured");
    if (principal.via === "embed-token") throw new ApiError(403, "Embed tokens cannot mint further tokens");
    const body = await readJson<{ ttlSeconds?: number; scopes?: Scope[] }>(request).catch(() => ({}) as { ttlSeconds?: number; scopes?: Scope[] });
    const requested = body.scopes ?? (["projects:read", "projects:write", "agent:chat"] as Scope[]);
    const granted = hasScope(principal, "admin") ? requested : requested.filter((scope) => principal.scopes.includes(scope));
    if (!granted.length) throw new ApiError(403, "None of the requested scopes are held by this key");
    const ttl = Math.min(Math.max(body.ttlSeconds ?? 3600, 60), 86_400);
    const token = await signEmbedToken(secret, {
      tenantId: principal.tenantId,
      projectId,
      kind,
      scopes: granted,
      exp: Math.floor(Date.now() / 1000) + ttl
    });
    return json({ token, expiresIn: ttl, scopes: granted }, 201);
  }

  // ---- Sessions: /v1/projects/:kind/:id/sessions/... -------------------

  if (segment === "sessions") {
    if (parts.length === 4 && method === "POST") {
      requireScope(principal, "agent:chat");
      await enforceRateLimit(env, principal, "write");
      const body = await readJson<{ title?: string }>(request).catch(() => ({}) as { title?: string });
      const sessionId = `${kind}-session-${crypto.randomUUID()}`;
      const agent = await agentFor(env, principal, kind, projectId, sessionId);
      await agent.configureForProject({
        projectId: projectObjectName(principal.tenantId, kind, projectId),
        kind: kind as ProjectKind,
        sessionId,
        title: body.title?.trim() || `New ${requireAssetKind(kind).label} session`
      });
      return json({ sessionId }, 201);
    }

    const sessionId = validId(decodeURIComponent(parts[4] ?? ""), "session id");
    const agent = await agentFor(env, principal, kind, projectId, sessionId);
    const action = parts[5];

    if (action === "messages" && method === "GET") {
      requireScope(principal, "agent:chat");
      return json({ messages: await agent.getConversation() });
    }
    if (action === "messages" && method === "POST") {
      requireScope(principal, "agent:chat");
      await enforceRateLimit(env, principal, "write");
      const body = await readJson<{ text: string; awareness?: EditorAwareness }>(request);
      if (!body.text?.trim()) throw new ApiError(400, "text is required");
      return json(await agent.sendUserMessage(body.text, body.awareness));
    }
    if (action === "clear" && method === "POST") {
      requireScope(principal, "agent:chat");
      await agent.clearConversation();
      return json({ ok: true });
    }
    if (action === "awareness" && method === "POST") {
      requireScope(principal, "agent:chat");
      const body = await readJson<{ awareness?: EditorAwareness }>(request);
      await agent.setEditorAwareness(body.awareness);
      return json({ ok: true });
    }

    // Registry-driven: adding a workflow needs no change to this router.
    if (action === "workflows" && method === "POST") {
      requireScope(principal, "workflows:run");
      await enforceRateLimit(env, principal, "write");
      const workflowId = parts[6];
      const workflow = workflowId ? getWorkflow(workflowId) : undefined;
      if (!workflow) throw new ApiError(404, `Unknown workflow: ${workflowId ?? "(none)"}`);
      if (!workflow.kinds.includes(kind)) {
        throw new ApiError(400, `Workflow "${workflow.id}" does not apply to ${kind} projects`);
      }
      const params = await readJson<JsonObject>(request);
      const validation = validateWorkflowParams(workflow, params);
      if (!validation.ok) throw new ApiError(422, "Invalid workflow parameters", validation.errors);
      return json(await workflow.start(agent, params), 202);
    }

    if (action === "interactions" && parts[7] === "resolve" && method === "POST") {
      requireScope(principal, "agent:chat");
      const body = await readJson<{ response: JsonObject }>(request);
      return json(await agent.resolveInteraction(decodeURIComponent(parts[6] ?? ""), body.response));
    }
    if (action === "interactions" && parts[7] === "reject" && method === "POST") {
      requireScope(principal, "agent:chat");
      const body = await readJson<{ reason?: string }>(request).catch(() => ({}) as { reason?: string });
      return json(await agent.rejectInteraction(decodeURIComponent(parts[6] ?? ""), body.reason ?? "Rejected by user"));
    }
  }

  throw new ApiError(404, "Unknown v1 route");
}

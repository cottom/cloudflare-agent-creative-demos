import { getAgentByName } from "agents";
import { listAssetKinds, projectObjectName, requireAssetKind } from "../../shared/asset-kinds";
import { canAccessProject, hasScope, signEmbedToken, type Principal, type Scope } from "../platform/auth";
import { resolvePrincipal } from "../platform/principal";
import { getWorkflow, listWorkflows, validateWorkflowParams } from "../platform/workflows";
import {
  isWebhookEvent,
  rejectWebhookTarget,
  TARGET_REJECTION_MESSAGE,
  WEBHOOK_EVENTS
} from "../platform/webhooks";
import { StudioAgent, studioAgentName } from "../studio-agent";
import { ApiProblem, newRequestId, problem } from "./errors";
import {
  internalKind,
  internalWorkflowId,
  list,
  newId,
  publicAssetType,
  publicFlowId,
  toAction,
  toAsset,
  toFile,
  toHistoryEvent,
  toRun,
  toSession,
  type AssetRecord
} from "./dto";
import type { JsonObject, ProjectKind, ProjectState } from "../../shared/types";

/**
 * The public API.
 *
 * Everything a third party touches is defined here, in their vocabulary:
 * assets, files, sessions, runs, actions. No route exposes an asset "kind", a
 * Durable Object name, an R2 key or a workflow instance id, because each of
 * those would become a compatibility obligation the moment someone shipped
 * against it.
 */

const API_VERSION = "2026-08-11";

type Ctx = {
  env: Env;
  ctx: ExecutionContext;
  request: Request;
  url: URL;
  principal: Principal;
  requestId: string;
};

function ok(data: unknown, requestId: string, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-request-id", requestId);
  headers.set("x-api-version", API_VERSION);
  // Never cacheable. Responses vary by credential but the edge cache key does
  // not include one, so a cached 200 could otherwise be replayed to a different
  // workspace. Observed for real: a stale unauthenticated 401 was served from
  // the edge after the route's behaviour had changed.
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

async function readJson<T>(request: Request): Promise<T> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw problem.invalid("Expected a JSON request body.");
  try {
    return (await request.json()) as T;
  } catch {
    throw problem.invalid("Request body is not valid JSON.");
  }
}

function requireScope(principal: Principal, scope: Scope): void {
  if (!hasScope(principal, scope)) throw problem.scope(scope);
}

function tenantStub(env: Env, tenantId: string) {
  return env.TENANT.get(env.TENANT.idFromName(tenantId));
}

/**
 * Asset id → the kind that selects its Durable Object binding.
 *
 * Public ids deliberately carry no type, so this lookup is unavoidable — and it
 * would otherwise sit in front of every read. An asset's kind is immutable, so
 * the mapping is cached for the isolate's life with no staleness risk; only the
 * map's size is bounded.
 */
const kindCache = new Map<string, string>();
const KIND_CACHE_MAX = 5_000;

async function resolveAsset(context: Ctx, assetId: string): Promise<{ kind: string; record: AssetRecord }> {
  const cacheKey = `${context.principal.tenantId}/${assetId}`;
  const tenant = tenantStub(context.env, context.principal.tenantId);
  const record = (await tenant.getProject(assetId)) as AssetRecord | null;
  if (!record) throw problem.notFound(`Asset ${assetId}`);
  if (kindCache.size >= KIND_CACHE_MAX) kindCache.clear();
  kindCache.set(cacheKey, record.kind);
  if (!canAccessProject(context.principal, record.kind, assetId)) {
    throw problem.forbidden("This token is scoped to a different asset.");
  }
  return { kind: record.kind, record };
}

function projectStub(env: Env, principal: Principal, kind: string, assetId: string) {
  const name = projectObjectName(principal.tenantId, kind, assetId);
  const namespace = kind === "ppt" ? env.PPT_PROJECT : env.CANVAS_PROJECT;
  return namespace.get(namespace.idFromName(name)) as unknown as {
    initialize(projectId: string): Promise<ProjectState>;
    getSnapshot(): Promise<ProjectState>;
    getStateVersion(): Promise<number>;
    applyMutation(mutation: JsonObject): Promise<JsonObject & { ok: boolean; revision?: number; code?: string }>;
  };
}

function agentFor(env: Env, principal: Principal, kind: string, assetId: string, sessionId: string) {
  return getAgentByName<Env, StudioAgent>(
    env.STUDIO_AGENT,
    studioAgentName(kind as ProjectKind, projectObjectName(principal.tenantId, kind, assetId), sessionId)
  );
}

async function enforceRateLimit(env: Env, principal: Principal, cost: "read" | "write"): Promise<void> {
  const limiter = cost === "write" ? env.WRITE_RATE_LIMITER : env.READ_RATE_LIMITER;
  if (!limiter) return;
  const { success } = await limiter.limit({ key: `${principal.tenantId}:${cost}` });
  if (!success) throw problem.rateLimited();
}

function validId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(value)) {
    throw problem.invalid(`Invalid ${label}.`);
  }
  return value;
}

/** Capability manifest — generated, so it cannot drift from what the code does. */
function capabilities(): JsonObject {
  return {
    object: "capabilities",
    api_version: API_VERSION,
    asset_types: listAssetKinds().map((kind) => ({
      id: publicAssetType(kind.id),
      label: kind.label,
      description: kind.description,
      flows: kind.workflows.map(publicFlowId)
    })),
    flows: listWorkflows().map((workflow) => ({
      id: publicFlowId(workflow.id),
      label: workflow.label,
      description: workflow.description,
      asset_types: workflow.kinds.map(publicAssetType),
      requires_action: workflow.requiresApproval,
      parameters: workflow.params.map((param) => ({
        name: param.name,
        type: param.type,
        required: param.required,
        description: param.description
      }))
    })),
    scopes: ["projects:read", "projects:write", "agent:chat", "workflows:run"],
    webhook_events: WEBHOOK_EVENTS,
    limits: { list_page_max: 100, embed_token_max_seconds: 86_400 }
  };
}

// ---------------------------------------------------------------------------

async function handleAssets(context: Ctx, parts: string[], method: string): Promise<Response> {
  const { env, principal, requestId } = context;
  const tenant = tenantStub(env, principal.tenantId);

  // ---- collection ----
  if (parts.length === 1 && method === "GET") {
    requireScope(principal, "projects:read");
    await enforceRateLimit(env, principal, "read");
    const typeFilter = context.url.searchParams.get("type");
    const kindFilter = typeFilter ? internalKind(typeFilter) : undefined;
    if (typeFilter && !kindFilter) throw problem.invalid(`Unknown asset type "${typeFilter}".`);
    const page = await tenant.listProjects({
      kind: kindFilter,
      includeArchived: context.url.searchParams.get("include_archived") === "true",
      cursor: context.url.searchParams.get("starting_after"),
      limit: Number(context.url.searchParams.get("limit")) || undefined
    });
    return ok(list(page.projects.map((record) => toAsset(record as AssetRecord)), page.cursor), requestId);
  }

  if (parts.length === 1 && method === "POST") {
    requireScope(principal, "projects:write");
    await enforceRateLimit(env, principal, "write");
    const body = await readJson<{ type?: string; name?: string; metadata?: Record<string, string> }>(context.request);
    if (!body.type) throw problem.validation([{ field: "type", message: "type is required" }]);
    const kind = internalKind(body.type);
    if (!kind) throw problem.validation([{ field: "type", message: `Unknown asset type "${body.type}"` }]);
    const definition = requireAssetKind(kind);
    const assetId = newId("ast");
    const record = (await tenant.createProject({
      id: assetId,
      kind,
      name: body.name?.trim() || `Untitled ${definition.label}`,
      metadata: body.metadata
    })) as AssetRecord;
    // Seeded with the composed object name so every storage key derived from
    // the asset's own id inherits the tenant boundary.
    const state = await projectStub(env, principal, kind, assetId).initialize(
      projectObjectName(principal.tenantId, kind, assetId)
    );
    return ok(toAsset(record, state), requestId, 201);
  }

  const assetId = validId(decodeURIComponent(parts[1] ?? ""), "asset id");
  const { kind, record } = await resolveAsset(context, assetId);
  const stub = projectStub(env, principal, kind, assetId);
  const segment = parts[2];

  // ---- item ----
  if (!segment && method === "GET") {
    requireScope(principal, "projects:read");
    await enforceRateLimit(env, principal, "read");
    return ok(toAsset(record, await stub.getSnapshot()), requestId);
  }

  if (!segment && method === "PATCH") {
    requireScope(principal, "projects:write");
    const body = await readJson<{ name?: string }>(context.request);
    if (!body.name?.trim()) throw problem.validation([{ field: "name", message: "name is required" }]);
    await tenant.touchProject(assetId, body.name.trim());
    const updated = (await tenant.getProject(assetId)) as AssetRecord;
    return ok(toAsset(updated, await stub.getSnapshot()), requestId);
  }

  if (!segment && method === "DELETE") {
    requireScope(principal, "projects:write");
    await tenant.archiveProject(assetId);
    return ok({ id: assetId, object: "asset", deleted: true }, requestId);
  }

  if (segment === "restore" && method === "POST") {
    requireScope(principal, "projects:write");
    await tenant.restoreProject(assetId);
    const restored = (await tenant.getProject(assetId)) as AssetRecord;
    return ok(toAsset(restored, await stub.getSnapshot()), requestId);
  }

  // ---- content ----
  if (segment === "content" && method === "GET") {
    requireScope(principal, "projects:read");
    await enforceRateLimit(env, principal, "read");
    const state = await stub.getSnapshot();
    return ok(
      { object: "asset_content", asset_id: assetId, version: state.revision, content: state.document },
      requestId,
      200,
      { etag: `"${state.revision}"` }
    );
  }

  if (segment === "content" && method === "PUT") {
    requireScope(principal, "projects:write");
    await enforceRateLimit(env, principal, "write");
    const body = await readJson<{ content?: JsonObject; version?: number }>(context.request);
    if (!body.content) throw problem.validation([{ field: "content", message: "content is required" }]);
    // `If-Match` is the HTTP-native spelling; `version` in the body is the
    // spelling most SDK users reach for. Both are accepted, header wins.
    const ifMatch = context.request.headers.get("if-match")?.replace(/"/g, "");
    const expected = ifMatch !== undefined && ifMatch !== "" ? Number(ifMatch) : body.version;
    const state = await stub.getSnapshot();
    if (expected === undefined || Number.isNaN(expected)) {
      throw problem.validation([{ field: "version", message: "version or If-Match is required" }]);
    }
    if (expected !== state.revision) {
      throw problem.conflict(
        `Asset is at version ${state.revision}; the request was based on ${expected}. Re-read and retry.`
      );
    }
    const result = await stub.applyMutation({
      commandId: newId("cmd"),
      baseRevision: state.revision,
      actor: { type: "user", id: principal.tenantId },
      summary: "Replaced content via API",
      commands: [{ type: `${kind}.replace_document`, document: body.content }]
    } as unknown as JsonObject);
    if (!result.ok) throw problem.conflict("Asset changed while the request was in flight. Re-read and retry.");
    return ok({ object: "asset_content", asset_id: assetId, version: result.revision }, requestId);
  }

  if (segment === "history" && method === "GET") {
    requireScope(principal, "projects:read");
    const state = await stub.getSnapshot();
    const limit = Math.min(Math.max(Number(context.url.searchParams.get("limit")) || 25, 1), 100);
    return ok(list(state.activity.slice(0, limit).map(toHistoryEvent)), requestId);
  }

  // ---- files ----
  if (segment === "files") {
    requireScope(principal, "projects:read");
    const state = await stub.getSnapshot();
    const fileId = parts[3];
    if (!fileId && method === "GET") {
      return ok(list(state.artifacts.map((artifact) => toFile(artifact, assetId))), requestId);
    }
    const artifact = state.artifacts.find((item) => item.id === fileId);
    if (!artifact) throw problem.notFound(`File ${fileId}`);
    if (parts[4] === "content" && method === "GET") {
      const object = await env.ARTIFACTS.get(artifact.key, { onlyIf: context.request.headers });
      if (!object) throw problem.notFound(`File ${fileId} content`);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      // Authorisation-dependent, so it must not land in a shared cache.
      headers.set("cache-control", "private, max-age=31536000, immutable");
      headers.set("x-request-id", requestId);
      if (context.url.searchParams.get("disposition") === "attachment") {
        const filename = artifact.name.replace(/["\\\r\n]/g, "");
        headers.set("content-disposition", `attachment; filename="${filename}"`);
      }
      if (!("body" in object)) {
        return new Response(null, {
          status: context.request.headers.has("if-none-match") ? 304 : 412,
          headers
        });
      }
      return new Response(object.body, { headers });
    }
    if (method === "GET") return ok(toFile(artifact, assetId), requestId);
    throw problem.methodNotAllowed();
  }

  // ---- sessions ----
  if (segment === "sessions") return handleSessions(context, parts, method, kind, assetId, stub);

  // ---- runs ----
  if (segment === "runs") return handleRuns(context, parts, method, kind, assetId, stub);

  // ---- embed ----
  if (segment === "embed_sessions" && method === "POST") {
    requireScope(principal, "projects:write");
    if (principal.via === "embed-token") {
      throw problem.forbidden("An embed session cannot mint another embed session.");
    }
    const secret = env.EMBED_TOKEN_SECRET;
    if (!secret) throw problem.notConfigured("Embedding");
    const body = await readJson<{ expires_in?: number; scopes?: Scope[] }>(context.request).catch(
      () => ({}) as { expires_in?: number; scopes?: Scope[] }
    );
    const requested = body.scopes ?? (["projects:read", "projects:write", "agent:chat"] as Scope[]);
    // Intersected, never widened: an embed session cannot outrank its key.
    const granted = hasScope(principal, "admin")
      ? requested
      : requested.filter((scope) => principal.scopes.includes(scope));
    if (!granted.length) throw problem.forbidden("None of the requested scopes are held by this key.");
    const ttl = Math.min(Math.max(body.expires_in ?? 3600, 60), 86_400);
    const token = await signEmbedToken(secret, {
      tenantId: principal.tenantId,
      projectId: assetId,
      kind,
      scopes: granted,
      exp: Math.floor(Date.now() / 1000) + ttl
    });
    const origin = env.PUBLIC_ORIGIN ?? context.url.origin;
    return ok(
      {
        object: "embed_session",
        token,
        // A ready-made iframe src for hosts not using the SDK. The token rides
        // in the *fragment*, which browsers never send to a server, and the
        // editor strips it from history on read. Hosts using the SDK get a
        // stronger path still: it loads the frame with no credential at all and
        // hands the token over via postMessage.
        url: `${origin}/embed#token=${encodeURIComponent(token)}`,
        asset_id: assetId,
        scopes: granted,
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        expires_in: ttl
      },
      requestId,
      201,
      { [NO_REPLAY_HEADER]: "1" }
    );
  }

  throw problem.notFound("This route");
}

async function handleSessions(
  context: Ctx,
  parts: string[],
  method: string,
  kind: string,
  assetId: string,
  stub: ReturnType<typeof projectStub>
): Promise<Response> {
  const { env, principal, requestId } = context;
  const sessionId = parts[3];

  if (!sessionId && method === "GET") {
    requireScope(principal, "projects:read");
    const state = await stub.getSnapshot();
    return ok(list(state.sessions.map((session) => toSession(session, assetId))), requestId);
  }

  if (!sessionId && method === "POST") {
    requireScope(principal, "agent:chat");
    await enforceRateLimit(env, principal, "write");
    const body = await readJson<{ title?: string }>(context.request).catch(() => ({}) as { title?: string });
    const newSessionId = `${kind}-session-${crypto.randomUUID()}`;
    const agent = await agentFor(env, principal, kind, assetId, newSessionId);
    await agent.configureForProject({
      projectId: projectObjectName(principal.tenantId, kind, assetId),
      kind: kind as ProjectKind,
      sessionId: newSessionId,
      title: body.title?.trim() || `${requireAssetKind(kind).label} session`
    });
    const state = await stub.getSnapshot();
    const created = state.sessions.find((session) => session.id === newSessionId);
    return ok(
      created
        ? toSession(created, assetId)
        : { id: newSessionId, object: "session", asset_id: assetId, title: body.title ?? null },
      requestId,
      201
    );
  }

  if (!sessionId) throw problem.notFound("Session");
  const agent = await agentFor(env, principal, kind, assetId, validId(sessionId, "session id"));
  const action = parts[4];

  if (action === "messages" && method === "GET") {
    requireScope(principal, "agent:chat");
    const messages = await agent.getConversation();
    return ok(
      list(
        messages.map((message) => ({
          id: message.id,
          object: "message",
          role: message.role,
          session_id: sessionId,
          parts: message.parts
        }))
      ),
      requestId
    );
  }

  if (action === "messages" && method === "POST") {
    requireScope(principal, "agent:chat");
    await enforceRateLimit(env, principal, "write");
    const body = await readJson<{ content?: string; selection?: JsonObject }>(context.request);
    if (!body.content?.trim()) {
      throw problem.validation([{ field: "content", message: "content is required" }]);
    }
    const turn = await agent.sendUserMessage(body.content, body.selection as never);
    // Built field by field rather than spread: the agent's return value carries
    // internal submission state, and its metadata includes the composed object
    // name for the project. Spreading it published both.
    return ok(
      {
        object: "message_turn",
        id: turn.submissionId,
        session_id: sessionId,
        accepted: turn.accepted,
        messages: turn.messages.map((message) => ({
          id: message.id,
          object: "message",
          role: message.role,
          parts: message.parts
        }))
      },
      requestId,
      201
    );
  }

  if (action === "messages" && method === "DELETE") {
    requireScope(principal, "agent:chat");
    await agent.clearConversation();
    return ok({ object: "session", id: sessionId, cleared: true }, requestId);
  }

  if (action === "selection" && method === "POST") {
    requireScope(principal, "agent:chat");
    const body = await readJson<{ selection?: JsonObject }>(context.request);
    await agent.setEditorAwareness(body.selection as never);
    return ok({ object: "session", id: sessionId, selection: body.selection ?? null }, requestId);
  }

  throw problem.notFound("This route");
}

async function handleRuns(
  context: Ctx,
  parts: string[],
  method: string,
  kind: string,
  assetId: string,
  stub: ReturnType<typeof projectStub>
): Promise<Response> {
  const { env, principal, requestId } = context;
  const tenant = tenantStub(env, principal.tenantId);
  const runId = parts[3];

  if (!runId && method === "POST") {
    requireScope(principal, "workflows:run");
    await enforceRateLimit(env, principal, "write");
    const body = await readJson<{ flow?: string; input?: JsonObject; session_id?: string }>(context.request);
    if (!body.flow) throw problem.validation([{ field: "flow", message: "flow is required" }]);
    const workflowId = internalWorkflowId(body.flow);
    const workflow = workflowId ? getWorkflow(workflowId) : undefined;
    if (!workflow) throw problem.validation([{ field: "flow", message: `Unknown flow "${body.flow}"` }]);
    if (!workflow.kinds.includes(kind)) {
      throw problem.validation([
        { field: "flow", message: `Flow "${body.flow}" does not apply to ${publicAssetType(kind)} assets` }
      ]);
    }
    const input = body.input ?? {};
    const validation = validateWorkflowParams(workflow, input);
    if (!validation.ok) {
      throw problem.validation(
        validation.errors.map((message) => ({ field: message.split(" ")[0] ?? "input", message }))
      );
    }
    // A caller running a flow should not have to know sessions exist; one is
    // opened for them when they do not supply it.
    let sessionId = body.session_id;
    if (!sessionId) {
      sessionId = `${kind}-session-${crypto.randomUUID()}`;
      const opener = await agentFor(env, principal, kind, assetId, sessionId);
      await opener.configureForProject({
        projectId: projectObjectName(principal.tenantId, kind, assetId),
        kind: kind as ProjectKind,
        sessionId,
        title: workflow.label
      });
    }
    const agent = await agentFor(env, principal, kind, assetId, sessionId);
    const started = (await workflow.start(agent as never, input)) as { workflowId?: string };
    const publicId = newId("run");
    if (started.workflowId) {
      await tenant.recordRun(publicId, assetId, started.workflowId, body.flow);
    }
    return ok(
      {
        id: publicId,
        object: "run",
        flow: body.flow,
        status: "queued",
        asset_id: assetId,
        session_id: sessionId,
        created_at: new Date().toISOString()
      },
      requestId,
      202
    );
  }

  const state = await stub.getSnapshot();

  if (!runId && method === "GET") {
    requireScope(principal, "projects:read");
    const known = await tenant.listRuns(assetId, 20);
    const byInstance = new Map(known.map((entry) => [entry.instanceId, entry.publicId]));
    const runs = state.workflows
      .filter((run) => byInstance.has(run.id))
      .map((run) =>
        toRun(
          { ...run, id: byInstance.get(run.id)! },
          assetId,
          state.interactions.filter((item) => item.status === "pending" && item.workflowId === run.id)
        )
      );
    return ok(list(runs), requestId);
  }

  if (!runId) throw problem.notFound("Run");
  const resolved = await tenant.resolveRun(runId);
  if (!resolved || resolved.assetId !== assetId) throw problem.notFound(`Run ${runId}`);
  const run = state.workflows.find((item) => item.id === resolved.instanceId);
  if (!run) throw problem.notFound(`Run ${runId}`);
  const pending = state.interactions.filter(
    (item) => item.status === "pending" && item.workflowId === resolved.instanceId
  );

  if (parts.length === 4 && method === "GET") {
    requireScope(principal, "projects:read");
    await enforceRateLimit(env, principal, "read");
    return ok(toRun({ ...run, id: runId }, assetId, pending), requestId);
  }

  // POST /v1/assets/{id}/runs/{runId}/actions/{actionId}
  if (parts[4] === "actions" && parts[5] && method === "POST") {
    requireScope(principal, "agent:chat");
    const actionId = decodeURIComponent(parts[5]);
    const interaction = state.interactions.find((item) => item.id === actionId);
    if (!interaction) throw problem.notFound(`Action ${actionId}`);
    const agent = await agentFor(env, principal, kind, assetId, interaction.sessionId);
    const body = await readJson<{ response?: JsonObject; decline?: boolean; reason?: string }>(context.request);
    const result = body.decline
      ? await agent.rejectInteraction(actionId, body.reason ?? "Declined")
      : await agent.resolveInteraction(actionId, body.response ?? {});
    return ok(toAction(result as never, assetId), requestId);
  }

  throw problem.notFound("This route");
}

/**
 * Webhook subscriptions.
 *
 * Workspace-level rather than per-asset: an integrator wants one endpoint for
 * everything happening in their workspace, not one registration per document.
 */
async function handleWebhooks(context: Ctx, parts: string[], method: string): Promise<Response> {
  const { env, principal, requestId } = context;
  // Managing delivery endpoints is an account-level action, so it is closed to
  // embed sessions no matter what scopes they were granted.
  if (principal.via === "embed-token") {
    throw problem.forbidden("Embed sessions cannot manage webhooks.");
  }
  requireScope(principal, "projects:write");
  const tenant = tenantStub(env, principal.tenantId);

  if (parts.length === 1 && method === "POST") {
    const body = await readJson<{ url?: string; events?: string[] }>(context.request);
    const errors: Array<{ field: string; message: string }> = [];
    // One validator, shared with the delivery path, so registration cannot
    // accept a target that sending would then refuse.
    const rejection = rejectWebhookTarget(body.url ?? "", env.PUBLIC_ORIGIN);
    if (rejection) errors.push({ field: "url", message: TARGET_REJECTION_MESSAGE[rejection] });
    const events = (body.events ?? []).filter(isWebhookEvent);
    if (!events.length) {
      errors.push({ field: "events", message: `events must include at least one of: ${WEBHOOK_EVENTS.join(", ")}` });
    }
    if (errors.length) throw problem.validation(errors);

    const record = await tenant.registerWebhook(new URL(body.url!).toString(), events);
    return ok(
      {
        id: record.id,
        object: "webhook",
        url: record.url,
        events: record.events,
        // Shown once. Store it — it is the only way to verify a delivery.
        secret: record.secret,
        created_at: record.createdAt
      },
      requestId,
      201,
      { [NO_REPLAY_HEADER]: "1" }
    );
  }

  if (parts.length === 1 && method === "GET") {
    const webhooks = await tenant.listWebhooks();
    return ok(
      list(
        webhooks.map((webhook) => ({
          id: webhook.id,
          object: "webhook",
          url: webhook.url,
          events: webhook.events,
          created_at: webhook.createdAt
        }))
      ),
      requestId
    );
  }

  if (parts[1] === "deliveries" && method === "GET") {
    const deliveries = await tenant.listDeliveries(Number(context.url.searchParams.get("limit")) || undefined);
    return ok(
      list(
        deliveries.map((delivery) => ({
          id: delivery.id,
          object: "webhook_delivery",
          webhook_id: delivery.webhookId,
          event: delivery.event,
          status: delivery.status,
          attempts: delivery.attempts,
          last_error: delivery.lastError
        }))
      ),
      requestId
    );
  }

  if (parts.length === 2 && method === "DELETE") {
    const deleted = await tenant.deleteWebhook(validId(decodeURIComponent(parts[1]!), "webhook id"));
    if (!deleted) throw problem.notFound(`Webhook ${parts[1]}`);
    return ok({ id: parts[1], object: "webhook", deleted: true }, requestId);
  }

  throw problem.notFound("This route");
}

// ---------------------------------------------------------------------------

/**
 * Replay-safe POST handling.
 *
 * Only successful responses are recorded: a failed create should be retryable
 * with the same key, and caching a 500 would make a transient fault permanent
 * for that key.
 */
const NO_REPLAY_HEADER = "x-creative-no-replay";

async function withIdempotency(context: Ctx, run: () => Promise<Response>): Promise<Response> {
  const key = context.request.headers.get("idempotency-key");
  if (!key || context.request.method.toUpperCase() !== "POST") return run();
  const fingerprint = `${context.url.pathname}:${await context.request.clone().text()}`;
  const tenant = tenantStub(context.env, context.principal.tenantId);
  const replay = await tenant.replayIdempotent(key, fingerprint);
  if (replay && "conflict" in replay) {
    throw new ApiProblem(
      "idempotency_conflict",
      "This Idempotency-Key was already used with a different request body."
    );
  }
  if (replay) {
    return ok(JSON.parse(replay.body), context.requestId, replay.status, { "idempotent-replay": "true" });
  }
  const response = await run();
  /**
   * Responses carrying a freshly minted credential are never stored.
   *
   * Recording one would write an embed token or a webhook signing secret into
   * the workspace's database in plaintext, and replay it to anyone presenting
   * the same key long after it was issued — a credential shown once would
   * quietly become a credential retrievable for as long as the record lives.
   * Those calls are cheap and safe to repeat, so the caller simply gets a new
   * one.
   */
  if (response.status < 300 && !response.headers.has(NO_REPLAY_HEADER)) {
    const body = await response.clone().text();
    context.ctx.waitUntil(tenant.recordIdempotent(key, fingerprint, response.status, body).catch(() => {}));
  }
  const cleaned = new Response(response.body, response);
  cleaned.headers.delete(NO_REPLAY_HEADER);
  return cleaned;
}

export async function handlePublicApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) return null;
  const requestId = newRequestId();
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const method = request.method.toUpperCase();

  try {
    // Discoverable without a credential, so an integrator can read the surface
    // before signing up for one.
    if (parts[0] === "capabilities" && method === "GET") return ok(capabilities(), requestId);

    const principal = await resolvePrincipal(request, env);
    if (!principal) {
      return problem
        .unauthorized()
        .toResponse(requestId);
    }
    const context: Ctx = { env, ctx, request, url, principal, requestId };

    if (parts[0] === "me" && method === "GET") {
      return ok(
        {
          object: "identity",
          workspace: principal.tenantId,
          scopes: principal.scopes,
          credential: principal.via === "api-key" ? "api_key" : "embed_session",
          asset_id: principal.projectId ?? null
        },
        requestId
      );
    }

    if (parts[0] === "webhooks") {
      return await withIdempotency(context, () => handleWebhooks(context, parts, method));
    }

    if (parts[0] === "assets") {
      return await withIdempotency(context, () => handleAssets(context, parts, method));
    }

    throw problem.notFound("This route");
  } catch (error) {
    if (error instanceof ApiProblem) {
      if (error.status >= 500) {
        console.error(JSON.stringify({ event: "api_error", requestId, path: url.pathname, code: error.code }));
      }
      return error.toResponse(requestId);
    }
    console.error(JSON.stringify({
      event: "api_unhandled",
      requestId,
      path: url.pathname,
      method,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }));
    // Internal faults never echo their message; the request id is the handle.
    return new ApiProblem("internal_error", "An unexpected error occurred.").toResponse(requestId);
  }
}

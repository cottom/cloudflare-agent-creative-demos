import { generateApiKey, timingSafeEqualUtf8, type Scope } from "../platform/auth";
import { generateDeckPlan } from "../lib/ai";
import { newRequestId, problem, ApiProblem } from "./errors";
import type { PptBuildWorkflowParams } from "../../shared/types";

/**
 * Provisioning and operations plane.
 *
 * Separate from the public API because it is the only credential that crosses
 * workspace boundaries: creating the first key for a workspace cannot itself
 * require a key from that workspace. Third parties never see these routes.
 */

function json(data: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-request-id": requestId }
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function validId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(value)) throw problem.invalid("Invalid workspace id.");
  return value;
}

export async function handleAdminApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/admin/")) return null;
  const requestId = newRequestId();
  const parts = url.pathname.split("/").filter(Boolean).slice(2);
  const method = request.method.toUpperCase();

  try {
    const adminSecret = env.PLATFORM_ADMIN_SECRET;
    // Absent secret disables the plane outright rather than leaving it open.
    if (!adminSecret) throw problem.notConfigured("Administration");
    const presented = request.headers.get("x-admin-secret") ?? "";
    if (presented.length !== adminSecret.length || !timingSafeEqualUtf8(presented, adminSecret)) {
      throw problem.unauthorized("Invalid admin secret.");
    }

    const tenantStub = (tenantId: string) => env.TENANT.get(env.TENANT.idFromName(tenantId));

    if (parts[0] === "workspaces" && parts[2] === "keys") {
      const tenantId = validId(decodeURIComponent(parts[1] ?? ""));
      if (method === "POST") {
        const body = await readJson<{ name?: string; scopes?: Scope[] }>(request);
        const key = generateApiKey(tenantId);
        const record = await tenantStub(tenantId).addApiKey(
          key,
          body.name?.trim() || "default",
          body.scopes ?? (["projects:read", "projects:write", "agent:chat", "workflows:run"] as Scope[])
        );
        // Returned exactly once; only the digest is stored.
        return json({ ...record, key }, requestId, 201);
      }
      if (method === "GET") return json({ keys: await tenantStub(tenantId).listApiKeys() }, requestId);
      if (method === "DELETE" && parts[3]) {
        return json({ revoked: await tenantStub(tenantId).revokeApiKey(decodeURIComponent(parts[3])) }, requestId);
      }
    }

    if (parts[0] === "workspaces" && parts[2] === "stats" && method === "GET") {
      return json(await tenantStub(validId(decodeURIComponent(parts[1] ?? ""))).stats(), requestId);
    }

    /**
     * Run deck planning outside a workflow and return its shape.
     *
     * Planning sits behind a human approval gate, so inspecting what the model
     * actually produced used to cost a five-minute round trip — which is how a
     * deck full of empty content slots stayed misdiagnosed across three
     * attempts. Measured caveat: a request handler is cut off near 126s and
     * planning alone costs ~60s, so only small decks complete here. Use it to
     * inspect shape, not throughput.
     */
    if (parts[0] === "dry-run" && parts[1] === "deck-plan" && method === "POST") {
      const body = await readJson<{ objective?: string; audience?: string; slideCount?: number }>(request);
      if (!body.objective?.trim()) throw problem.invalid("objective is required.");
      const params = {
        projectId: "dry-run",
        sessionId: "dry-run",
        objective: body.objective,
        audience: body.audience,
        slideCount: body.slideCount
      } as PptBuildWorkflowParams;
      const outline = {
        title: body.objective.slice(0, 80),
        objective: body.objective,
        audience: body.audience ?? "business decision makers",
        styleId: "minimal",
        slides: []
      } as unknown as Parameters<typeof generateDeckPlan>[2];
      const diagnostics: string[] = [];
      const plan = await generateDeckPlan(env, params, outline, undefined, { diagnostics });
      return json(
        {
          diagnostics,
          slides: plan.slides.map((slide, index) => ({
            index: index + 1,
            layoutId: slide.layoutId,
            filledSlots: Object.entries(slide.slots)
              .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
              .map(([name]) => name),
            hasImagePrompt: Boolean(slide.imagePrompt)
          })),
          raw: plan
        },
        requestId
      );
    }

    throw problem.notFound("This admin route");
  } catch (error) {
    if (error instanceof ApiProblem) return error.toResponse(requestId);
    console.error(JSON.stringify({
      event: "admin_error",
      requestId,
      error: error instanceof Error ? error.message : String(error)
    }));
    return new ApiProblem("internal_error", "An unexpected error occurred.").toResponse(requestId);
  }
}

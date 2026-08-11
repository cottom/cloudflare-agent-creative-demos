import {
  bearerToken,
  tenantFromApiKey,
  verifyEmbedToken,
  type Principal,
  type Scope
} from "./auth";

/**
 * Turn a request into a Principal.
 *
 * API-key verification is a Durable Object round trip, and it would otherwise
 * sit in front of every single request — including the chat stream and the
 * poll loop. Verified keys are therefore cached in the isolate for a short
 * window.
 *
 * The cost of that cache is revocation latency: a revoked key keeps working in
 * an already-warm isolate until its entry expires. `AUTH_CACHE_TTL_MS` is the
 * upper bound on that window, and it is short enough to be an acceptable
 * trade for removing a round trip from the hot path. Anything requiring
 * immediate revocation must not rely on this path.
 *
 * Embed tokens skip the cache entirely — they are pure HMAC verification with
 * no storage read, so caching would save nothing.
 */

const AUTH_CACHE_TTL_MS = 30_000;

type CacheEntry = { principal: Principal; expiresAt: number };

const cache = new Map<string, CacheEntry>();

/** Bounded so a key-spraying caller cannot grow the isolate's heap. */
const MAX_CACHE_ENTRIES = 1_000;

function cacheGet(key: string, now: number): Principal | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return entry.principal;
}

function cacheSet(key: string, principal: Principal, now: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Evict the oldest insertion; Map preserves insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { principal, expiresAt: now + AUTH_CACHE_TTL_MS });
}

export function clearAuthCache(): void {
  cache.clear();
}

function tenantStub(env: Env, tenantId: string) {
  return env.TENANT.get(env.TENANT.idFromName(tenantId));
}

export async function resolvePrincipal(request: Request, env: Env, now = Date.now()): Promise<Principal | null> {
  const presented = bearerToken(request);
  if (!presented) return null;
  const token = presented.value;

  if (token.startsWith("cak_")) {
    // A long-lived key in a query string should be assumed logged. The query
    // path exists for embedded editors, which use short-lived pinned tokens;
    // an API key presented that way is refused rather than merely discouraged.
    if (presented.source === "query") return null;
    const cached = cacheGet(token, now);
    if (cached) return cached;
    const tenantId = tenantFromApiKey(token);
    if (!tenantId) return null;
    const verified = await tenantStub(env, tenantId).verifyApiKey(token);
    if (!verified) return null;
    const principal: Principal = { tenantId, scopes: verified.scopes as Scope[], via: "api-key" };
    cacheSet(token, principal, now);
    return principal;
  }

  const secret = env.EMBED_TOKEN_SECRET;
  if (!secret) return null;
  const claims = await verifyEmbedToken(secret, token, now);
  if (!claims) return null;
  return {
    tenantId: claims.tenantId,
    scopes: claims.scopes,
    projectId: claims.projectId,
    kind: claims.kind,
    via: "embed-token"
  };
}

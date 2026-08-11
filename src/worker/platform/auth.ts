/**
 * Tenant authentication and scoped tokens.
 *
 * Two credential shapes, deliberately different in power:
 *
 * - **API keys** (`cak_…`) are long-lived, server-to-server, and carry full
 *   scopes. Only their SHA-256 digest is stored, so a leaked tenant record
 *   cannot be replayed as a credential.
 * - **Embed tokens** are short-lived, HMAC-signed, and pinned to a single
 *   project. They are safe to hand to a browser because the worst a stolen one
 *   can do is edit the project it already names, until it expires.
 *
 * Everything is Web Crypto — no dependencies, and comparisons are
 * constant-time so a token cannot be discovered a byte at a time.
 */

export type Scope = "projects:read" | "projects:write" | "agent:chat" | "workflows:run" | "admin";

export const ALL_SCOPES: Scope[] = [
  "projects:read",
  "projects:write",
  "agent:chat",
  "workflows:run",
  "admin"
];

export type Principal = {
  tenantId: string;
  scopes: Scope[];
  /** Present on embed tokens: the principal may only touch this project. */
  projectId?: string;
  kind?: string;
  via: "api-key" | "embed-token";
};

const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compare two same-length hex digests without leaking position via timing. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Constant-time comparison for arbitrary secrets.
 *
 * `timingSafeEqualHex` assumes a fixed-width digest; this one is for
 * caller-supplied strings, where length itself is already observable and the
 * caller checks it before comparing content.
 */
export function timingSafeEqualUtf8(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Keys name their own tenant: `cak_<tenant>_<secret>`.
 *
 * Verification has to ask a specific tenant object whether it issued a key, so
 * the tenant has to be known *before* the key is checked. Embedding it removes
 * the alternative — a separate `X-Tenant-Id` header that callers can get wrong
 * and that a global key-to-tenant index would otherwise have to resolve.
 *
 * The tenant segment is public information, not a secret; entropy lives
 * entirely in the 24 random bytes that follow.
 */
export function generateApiKey(tenantId: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `cak_${base64url(encoder.encode(tenantId))}_${secret}`;
}

export function tenantFromApiKey(key: string): string | null {
  const [prefix, tenant, secret] = key.split("_");
  if (prefix !== "cak" || !tenant || !secret) return null;
  try {
    const decoded = new TextDecoder().decode(fromBase64url(tenant));
    // Tenant ids address a Durable Object by name; reject anything that is not
    // the constrained shape the API itself issues.
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Typed as `Uint8Array<ArrayBuffer>` so it satisfies Web Crypto's BufferSource. */
function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export type EmbedClaims = {
  tenantId: string;
  projectId: string;
  kind: string;
  scopes: Scope[];
  /** Unix seconds. */
  exp: number;
};

/**
 * Mint a token a host page can pass to an embedded editor.
 *
 * Kept deliberately small and self-describing rather than a session lookup:
 * verifying it costs one HMAC and no storage round trip, which matters when
 * every embedded editor verifies on connect.
 */
export async function signEmbedToken(secret: string, claims: EmbedClaims): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyEmbedToken(secret: string, token: string, now = Date.now()): Promise<EmbedClaims | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    fromBase64url(signature),
    encoder.encode(payload)
  );
  if (!valid) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as EmbedClaims;
    // An expired token is indistinguishable from a forged one to the caller,
    // on purpose: both are simply "not authenticated".
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Extract the presented credential.
 *
 * Header only. A credential in a query string should be assumed recorded — it
 * lands in access logs, `Referer` headers and browser history — and nothing
 * here needs one: the embedded editor authenticates its API calls with this
 * header like any other client, and receives its token out of band rather than
 * through a URL.
 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const value = header.slice(7).trim();
  return value || null;
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope) || principal.scopes.includes("admin");
}

/** Embed principals are pinned to one project; API keys may address any. */
export function canAccessProject(principal: Principal, kind: string, projectId: string): boolean {
  if (!principal.projectId) return true;
  return principal.projectId === projectId && principal.kind === kind;
}

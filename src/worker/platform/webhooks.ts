/**
 * Webhook signing and payload shaping.
 *
 * Delivery itself lives in the Tenant object, which owns the schedule; this
 * module is the pure part — what a receiver sees and how they verify it.
 *
 * The signature scheme is the one most integrators have already implemented:
 * an `X-Signature: t=<unix>,v1=<hex>` header over `"<t>.<body>"`. Signing the
 * timestamp along with the body is what makes it replay-resistant — a captured
 * request cannot be re-sent later without breaking the signature, so receivers
 * can reject anything older than their tolerance.
 */

const encoder = new TextEncoder();

export type WebhookEvent =
  | "run.running"
  | "run.requires_action"
  | "run.succeeded"
  | "run.failed";

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  "run.running",
  "run.requires_action",
  "run.succeeded",
  "run.failed"
];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as string[]).includes(value);
}

/**
 * Hosts a delivery must never be pointed at.
 *
 * A webhook URL is attacker-chosen — any authenticated workspace can set one —
 * and delivery is a request made *by us*, from inside our network, with our
 * egress identity. That is server-side request forgery, and the fact that this
 * runtime has no VM metadata endpoint to steal is not a reason to allow it:
 * the same primitive lets a workspace aim our egress at anything.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^0\.0\.0\.0$/,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\./i
];

/** Bracketed IPv6, or dotted IPv4. A real receiver is named, not numbered. */
function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

export type TargetRejection =
  | "not_absolute"
  | "not_https"
  | "ip_literal"
  | "reserved_host"
  | "own_origin";

/**
 * Whether a URL may be used as a delivery target.
 *
 * Checked at registration *and* immediately before each send, because a
 * hostname's meaning can change between the two.
 *
 * What this cannot do: resolve the host and reject private addresses. Workers
 * has no DNS resolution API, so a hostname that resolves to a private address
 * is not detectable here. The residual risk is bounded by there being no
 * private network to pivot into from this runtime, and by delivery refusing to
 * follow redirects — which is the bypass that would otherwise make
 * registration-time validation decorative.
 */
export function rejectWebhookTarget(raw: string, ownOrigin?: string): TargetRejection | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not_absolute";
  }
  if (url.protocol !== "https:") return "not_https";
  if (isIpLiteral(url.hostname)) return "ip_literal";
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) return "reserved_host";
  // Delivering to ourselves is a loop and an amplifier: it would let a
  // workspace drive our own unauthenticated routes with our egress.
  if (ownOrigin) {
    try {
      if (new URL(ownOrigin).host === url.host) return "own_origin";
    } catch {
      // A malformed PUBLIC_ORIGIN must not make every target look unsafe.
    }
  }
  return null;
}

export const TARGET_REJECTION_MESSAGE: Record<TargetRejection, string> = {
  not_absolute: "url must be an absolute URL",
  not_https: "url must use https",
  ip_literal: "url must name a host, not an IP address",
  reserved_host: "url must not target a reserved or internal host",
  own_origin: "url must not target this API"
};

/**
 * Coarse delivery outcomes.
 *
 * The raw failure is kept in our logs, not in the API. Returning it verbatim
 * would turn the deliveries endpoint into a network probe: the difference
 * between a refused connection, a DNS failure and a timeout tells a caller
 * what exists behind a host they cannot otherwise reach.
 */
export type DeliveryFailure =
  | "connection_failed"
  | "timeout"
  | "redirected"
  | "http_client_error"
  | "http_server_error"
  | "rejected_target";

export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `whsec_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function signPayload(secret: string, body: string, timestampSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}.${body}`));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestampSeconds},v1=${hex}`;
}

/**
 * Backoff schedule, in seconds.
 *
 * Front-loaded so a receiver that was redeploying recovers in under a minute,
 * then widening so a receiver that is genuinely down is not hammered for an
 * hour. Exhausting the schedule marks the delivery failed rather than retrying
 * forever — an undeliverable event is the integrator's problem to see, and a
 * queue that never drains is ours.
 */
export const RETRY_SCHEDULE_SECONDS = [10, 30, 120, 600, 3600];
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;

export function nextAttemptDelaySeconds(attempt: number): number | null {
  return RETRY_SCHEDULE_SECONDS[attempt - 1] ?? null;
}

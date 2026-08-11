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

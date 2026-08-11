/**
 * Secrets are set with `wrangler secret put` and so never appear in
 * `wrangler.jsonc` — which means `wrangler types` cannot know about them.
 * Declaring them here augments the generated `Env` rather than replacing it.
 *
 * Both are optional on purpose: the code paths that need them return 501 when
 * they are missing, so a deployment without them runs with those features off
 * instead of failing to boot.
 */
declare global {
  interface Env {
    /** HMAC key for embed tokens. `wrangler secret put EMBED_TOKEN_SECRET` */
    EMBED_TOKEN_SECRET?: string;
    /** Authorises tenant provisioning. `wrangler secret put PLATFORM_ADMIN_SECRET` */
    PLATFORM_ADMIN_SECRET?: string;
  }
}

export {};

import { DurableObject } from "cloudflare:workers";
import { sha256Hex, timingSafeEqualHex, type Scope } from "./auth";
import {
  generateWebhookSecret,
  isWebhookEvent,
  MAX_ATTEMPTS,
  nextAttemptDelaySeconds,
  rejectWebhookTarget,
  signPayload,
  type DeliveryFailure
} from "./webhooks";

/**
 * Per-tenant control plane: API keys and the project index.
 *
 * **Concurrency shape.** One Durable Object per tenant is a serialization
 * point, so it deliberately owns only cold-path work — creating projects,
 * listing them, minting keys. The hot paths (editing a document, chatting with
 * the agent, running a workflow) address the Project object directly and never
 * touch this one, so a tenant with a thousand busy projects still has a thousand
 * independent write paths. Auth is the one hot-path read, and the Worker caches
 * it in-isolate so it is not a per-request round trip.
 *
 * The project index lives in SQLite rather than a stored array because listing
 * with a filter and a cursor should not deserialize every project a tenant has
 * ever created.
 */

export type ProjectRecord = {
  id: string;
  kind: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Free-form integrator metadata, echoed back on reads. */
  metadata: Record<string, string>;
};

export type ApiKeyRecord = {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type KeyRow = {
  hash: string;
  id: string;
  name: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type ProjectRow = {
  id: string;
  kind: string;
  name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  metadata: string;
};

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    metadata: JSON.parse(row.metadata) as Record<string, string>
  };
}

function toKey(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    scopes: JSON.parse(row.scopes) as Scope[],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}

export type WebhookRecord = {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
  disabledAt: string | null;
};

export type DeliveryRecord = {
  id: string;
  webhookId: string;
  event: string;
  status: string;
  attempts: number;
  lastError: string | null;
};

type WebhookRow = {
  id: string;
  url: string;
  secret: string;
  events: string;
  created_at: string;
  disabled_at: string | null;
};

type DeliveryRow = {
  id: string;
  webhook_id: string;
  event: string;
  body: string;
  attempts: number;
  due_at: number;
  status: string;
  last_error: string | null;
};

function toWebhook(row: WebhookRow): WebhookRecord {
  return {
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    createdAt: row.created_at,
    disabledAt: row.disabled_at
  };
}

export class Tenant extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `blockConcurrencyWhile` guarantees no request observes a half-built
    // schema: the object will not dispatch RPC until this resolves.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          hash TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          scopes TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS projects_kind_updated
          ON projects (kind, updated_at DESC);
        CREATE TABLE IF NOT EXISTS idempotency (
          key TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          status INTEGER NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
          public_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          flow TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_asset ON runs (asset_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS webhooks (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          secret TEXT NOT NULL,
          events TEXT NOT NULL,
          created_at TEXT NOT NULL,
          disabled_at TEXT
        );
        CREATE TABLE IF NOT EXISTS deliveries (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          event TEXT NOT NULL,
          body TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          due_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, due_at);
      `);
    });
  }

  // ---- API keys -------------------------------------------------------

  /**
   * Store a key by digest and return the record.
   *
   * The caller holds the only copy of the plaintext key; this object never
   * sees it again, which is what makes a leak of tenant storage non-replayable.
   */
  async addApiKey(plaintext: string, name: string, scopes: Scope[]): Promise<ApiKeyRecord> {
    const hash = await sha256Hex(plaintext);
    const record: ApiKeyRecord = {
      id: `key_${crypto.randomUUID()}`,
      name,
      scopes,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null
    };
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO api_keys (hash, id, name, scopes, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      hash,
      record.id,
      record.name,
      JSON.stringify(record.scopes),
      record.createdAt
    );
    return record;
  }

  /**
   * Resolve a presented key to its scopes, or null.
   *
   * The digest lookup is a primary-key hit, but the stored digest is still
   * compared in constant time so that a future non-indexed lookup cannot
   * silently reintroduce a timing side channel.
   */
  async verifyApiKey(plaintext: string): Promise<{ keyId: string; scopes: Scope[] } | null> {
    const hash = await sha256Hex(plaintext);
    const row = this.ctx.storage.sql
      .exec<KeyRow>(`SELECT * FROM api_keys WHERE hash = ?`, hash)
      .toArray()[0];
    if (!row || !timingSafeEqualHex(row.hash, hash) || row.revoked_at) return null;
    this.ctx.storage.sql.exec(
      `UPDATE api_keys SET last_used_at = ? WHERE hash = ?`,
      new Date().toISOString(),
      hash
    );
    return { keyId: row.id, scopes: JSON.parse(row.scopes) as Scope[] };
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    return this.ctx.storage.sql
      .exec<KeyRow>(`SELECT * FROM api_keys ORDER BY created_at DESC`)
      .toArray()
      .map(toKey);
  }

  async revokeApiKey(keyId: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      new Date().toISOString(),
      keyId
    );
    return cursor.rowsWritten > 0;
  }

  // ---- Projects -------------------------------------------------------

  async createProject(input: {
    id: string;
    kind: string;
    name: string;
    metadata?: Record<string, string>;
  }): Promise<ProjectRecord> {
    const existing = this.ctx.storage.sql
      .exec<ProjectRow>(`SELECT * FROM projects WHERE id = ?`, input.id)
      .toArray()[0];
    // Creation is idempotent by id so a retried POST cannot produce a second
    // project or clobber the name on an existing one.
    if (existing) return toProject(existing);

    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: input.id,
      kind: input.kind,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      metadata: input.metadata ?? {}
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO projects (id, kind, name, created_at, updated_at, archived_at, metadata)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      record.id,
      record.kind,
      record.name,
      now,
      now,
      JSON.stringify(record.metadata)
    );
    return record;
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const row = this.ctx.storage.sql
      .exec<ProjectRow>(`SELECT * FROM projects WHERE id = ?`, projectId)
      .toArray()[0];
    return row ? toProject(row) : null;
  }

  /**
   * Keyset pagination on `(updated_at, id)`.
   *
   * Offset pagination would re-scan the skipped rows and, worse, skip or repeat
   * projects when one is touched mid-listing — which is normal here, since
   * agents update projects continuously.
   */
  async listProjects(options: {
    kind?: string;
    includeArchived?: boolean;
    cursor?: string | null;
    limit?: number;
  } = {}): Promise<{ projects: ProjectRecord[]; cursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const filters = ["1 = 1"];
    const bindings: string[] = [];
    if (options.kind) {
      filters.push("kind = ?");
      bindings.push(options.kind);
    }
    if (!options.includeArchived) filters.push("archived_at IS NULL");
    if (options.cursor) {
      const [updatedAt, id] = options.cursor.split("|");
      filters.push("(updated_at < ? OR (updated_at = ? AND id > ?))");
      bindings.push(updatedAt ?? "", updatedAt ?? "", id ?? "");
    }
    const rows = this.ctx.storage.sql
      .exec<ProjectRow>(
        `SELECT * FROM projects WHERE ${filters.join(" AND ")}
         ORDER BY updated_at DESC, id ASC LIMIT ?`,
        ...bindings,
        limit + 1
      )
      .toArray();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      projects: page.map(toProject),
      cursor: rows.length > limit && last ? `${last.updated_at}|${last.id}` : null
    };
  }

  async touchProject(projectId: string, name?: string): Promise<void> {
    const now = new Date().toISOString();
    if (name) {
      this.ctx.storage.sql.exec(`UPDATE projects SET updated_at = ?, name = ? WHERE id = ?`, now, name, projectId);
      return;
    }
    this.ctx.storage.sql.exec(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, projectId);
  }

  /**
   * Archive rather than delete.
   *
   * The Durable Object holding the document is addressed by name and cannot be
   * removed from here, so a hard delete would drop the index row while leaving
   * the data reachable — a worse outcome than an explicit archived state.
   */
  async archiveProject(projectId: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`,
      new Date().toISOString(),
      new Date().toISOString(),
      projectId
    );
    return cursor.rowsWritten > 0;
  }

  async restoreProject(projectId: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL`,
      new Date().toISOString(),
      projectId
    );
    return cursor.rowsWritten > 0;
  }

  // ---- Idempotency ----------------------------------------------------

  /**
   * Replay protection for POSTs.
   *
   * A client that times out cannot tell a lost request from a lost response, so
   * it retries — and without this, a retried "create asset" silently makes two.
   * The fingerprint is checked as well as the key: reusing one key for a
   * *different* payload is a client bug, and returning the first response for
   * it would hide that bug behind a plausible success.
   */
  async replayIdempotent(
    key: string,
    fingerprint: string
  ): Promise<{ status: number; body: string } | { conflict: true } | null> {
    const row = this.ctx.storage.sql
      .exec<{ fingerprint: string; status: number; body: string }>(
        `SELECT fingerprint, status, body FROM idempotency WHERE key = ?`,
        key
      )
      .toArray()[0];
    if (!row) return null;
    if (row.fingerprint !== fingerprint) return { conflict: true };
    return { status: row.status, body: row.body };
  }

  async recordIdempotent(key: string, fingerprint: string, status: number, body: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)`,
      key,
      fingerprint,
      status,
      body,
      new Date().toISOString()
    );
  }

  // ---- Runs -----------------------------------------------------------

  /**
   * Public run id ⇄ workflow instance id.
   *
   * The engine's instance id is an implementation detail with its own format;
   * handing it out would make swapping the engine a breaking API change.
   */
  async recordRun(publicId: string, assetId: string, instanceId: string, flow: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO runs (public_id, asset_id, instance_id, flow, created_at) VALUES (?, ?, ?, ?, ?)`,
      publicId,
      assetId,
      instanceId,
      flow,
      new Date().toISOString()
    );
  }

  async resolveRun(publicId: string): Promise<{ assetId: string; instanceId: string; flow: string } | null> {
    const row = this.ctx.storage.sql
      .exec<{ asset_id: string; instance_id: string; flow: string }>(
        `SELECT asset_id, instance_id, flow FROM runs WHERE public_id = ?`,
        publicId
      )
      .toArray()[0];
    return row ? { assetId: row.asset_id, instanceId: row.instance_id, flow: row.flow } : null;
  }

  async listRuns(assetId: string, limit = 20): Promise<Array<{ publicId: string; instanceId: string; flow: string }>> {
    return this.ctx.storage.sql
      .exec<{ public_id: string; instance_id: string; flow: string }>(
        `SELECT public_id, instance_id, flow FROM runs WHERE asset_id = ? ORDER BY created_at DESC LIMIT ?`,
        assetId,
        Math.min(Math.max(limit, 1), 100)
      )
      .toArray()
      .map((row) => ({ publicId: row.public_id, instanceId: row.instance_id, flow: row.flow }));
  }

  // ---- Webhooks -------------------------------------------------------

  async registerWebhook(url: string, events: string[]): Promise<WebhookRecord & { secret: string }> {
    const secret = generateWebhookSecret();
    const record: WebhookRecord = {
      id: `wh_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      url,
      events: events.filter(isWebhookEvent),
      createdAt: new Date().toISOString(),
      disabledAt: null
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO webhooks (id, url, secret, events, created_at, disabled_at) VALUES (?, ?, ?, ?, ?, NULL)`,
      record.id,
      record.url,
      secret,
      JSON.stringify(record.events),
      record.createdAt
    );
    // The secret is returned exactly once, like an API key: a receiver that
    // loses it re-registers rather than reading it back out of us.
    return { ...record, secret };
  }

  async listWebhooks(): Promise<WebhookRecord[]> {
    return this.ctx.storage.sql
      .exec<WebhookRow>(`SELECT * FROM webhooks ORDER BY created_at DESC`)
      .toArray()
      .map(toWebhook);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    return this.ctx.storage.sql.exec(`DELETE FROM webhooks WHERE id = ?`, id).rowsWritten > 0;
  }

  /**
   * Fan an event out to every subscriber and schedule delivery.
   *
   * Writing the delivery rows and returning is deliberate: the caller is a
   * project object finishing a state change, and it must not wait on a third
   * party's HTTP endpoint to do it.
   */
  async emit(event: string, payload: Record<string, unknown>): Promise<number> {
    const subscribers = this.ctx.storage.sql
      .exec<WebhookRow>(`SELECT * FROM webhooks WHERE disabled_at IS NULL`)
      .toArray()
      .filter((row) => (JSON.parse(row.events) as string[]).includes(event));
    if (!subscribers.length) return 0;

    const body = JSON.stringify({
      id: `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      object: "event",
      type: event,
      created_at: new Date().toISOString(),
      data: payload
    });
    const now = Date.now();
    for (const subscriber of subscribers) {
      this.ctx.storage.sql.exec(
        `INSERT INTO deliveries (id, webhook_id, event, body, attempts, due_at, status)
         VALUES (?, ?, ?, ?, 0, ?, 'pending')`,
        `del_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        subscriber.id,
        event,
        body,
        now
      );
    }
    await this.scheduleNextDelivery();
    return subscribers.length;
  }

  /** One alarm per object, so it always points at the earliest pending row. */
  private async scheduleNextDelivery(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ due_at: number }>(`SELECT MIN(due_at) AS due_at FROM deliveries WHERE status = 'pending'`)
      .toArray()[0];
    if (!next?.due_at) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next.due_at) {
      await this.ctx.storage.setAlarm(Math.max(next.due_at, Date.now() + 1000));
    }
  }

  async alarm(): Promise<void> {
    const due = this.ctx.storage.sql
      .exec<DeliveryRow>(
        `SELECT * FROM deliveries WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 20`,
        Date.now()
      )
      .toArray();

    for (const delivery of due) {
      const webhook = this.ctx.storage.sql
        .exec<WebhookRow>(`SELECT * FROM webhooks WHERE id = ?`, delivery.webhook_id)
        .toArray()[0];
      if (!webhook) {
        this.ctx.storage.sql.exec(`DELETE FROM deliveries WHERE id = ?`, delivery.id);
        continue;
      }

      const attempts = delivery.attempts + 1;
      let failure: DeliveryFailure | null = null;
      let detail = "";

      // Re-checked here, not just at registration: what a hostname means can
      // change between the two, and this is the moment the request is made.
      const unsafe = rejectWebhookTarget(webhook.url, this.env.PUBLIC_ORIGIN);
      if (unsafe) {
        this.ctx.storage.sql.exec(
          `UPDATE deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`,
          attempts,
          "rejected_target" satisfies DeliveryFailure,
          delivery.id
        );
        continue;
      }

      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const response = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-signature": await signPayload(webhook.secret, delivery.body, timestamp),
            "x-event-type": delivery.event,
            "x-delivery-id": delivery.id,
            "x-attempt": String(attempts)
          },
          body: delivery.body,
          // Never follow a redirect. Validating the registered URL is
          // decorative if a receiver can 302 us to somewhere we refused to be
          // pointed at directly, and a webhook endpoint has no legitimate
          // reason to move.
          redirect: "manual",
          // A receiver that accepts the connection and then hangs would
          // otherwise hold the alarm open behind every other delivery.
          signal: AbortSignal.timeout(10_000)
        });

        if (response.ok) {
          this.ctx.storage.sql.exec(
            `UPDATE deliveries SET status = 'delivered', attempts = ?, last_error = NULL WHERE id = ?`,
            attempts,
            delivery.id
          );
          continue;
        }

        detail = `HTTP ${response.status}`;
        if (response.status >= 300 && response.status < 400) failure = "redirected";
        else if (response.status >= 500) failure = "http_server_error";
        else failure = "http_client_error";

        // A redirect, or a 4xx that is not 429, is the receiver telling us this
        // request is wrong. Retrying an unchanged request cannot fix that.
        if (failure !== "http_server_error" && response.status !== 429) {
          this.ctx.storage.sql.exec(
            `UPDATE deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`,
            attempts,
            failure,
            delivery.id
          );
          console.warn(JSON.stringify({ event: "webhook_failed", id: delivery.id, failure, detail }));
          continue;
        }
      } catch (cause) {
        detail = cause instanceof Error ? cause.message : String(cause);
        failure = /timeout|abort/i.test(detail) ? "timeout" : "connection_failed";
      }

      // The specific reason stays in our logs. Publishing it would let a caller
      // distinguish "refused", "no such host" and "timed out" for any address
      // they name, which is a network scanner.
      console.warn(JSON.stringify({ event: "webhook_retry", id: delivery.id, failure, detail, attempts }));

      const delay = attempts >= MAX_ATTEMPTS ? null : nextAttemptDelaySeconds(attempts);
      if (delay === null) {
        this.ctx.storage.sql.exec(
          `UPDATE deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`,
          attempts,
          failure,
          delivery.id
        );
      } else {
        this.ctx.storage.sql.exec(
          `UPDATE deliveries SET attempts = ?, due_at = ?, last_error = ? WHERE id = ?`,
          attempts,
          Date.now() + delay * 1000,
          failure,
          delivery.id
        );
      }
    }

    await this.scheduleNextDelivery();
  }

  /**
   * Translate an internal run state change into a public event.
   *
   * The project object knows a workflow instance changed status but not what
   * that run is called publicly, and it must not learn — so the mapping is
   * resolved here, next to the table that holds it. A run with no mapping was
   * started outside the public API and is not anyone's to hear about.
   */
  async emitRunEvent(input: {
    assetId: string;
    instanceId: string;
    status: string;
    progress: number;
    message: string;
    error?: string;
  }): Promise<void> {
    const PUBLIC_STATUS: Record<string, string> = {
      running: "run.running",
      waiting: "run.requires_action",
      complete: "run.succeeded",
      error: "run.failed"
    };
    const event = PUBLIC_STATUS[input.status];
    if (!event) return;
    const row = this.ctx.storage.sql
      .exec<{ public_id: string; flow: string }>(
        `SELECT public_id, flow FROM runs WHERE instance_id = ?`,
        input.instanceId
      )
      .toArray()[0];
    if (!row) return;
    await this.emit(event, {
      run: {
        id: row.public_id,
        object: "run",
        flow: row.flow,
        status: event.slice(4),
        progress: input.progress,
        message: input.message,
        asset_id: input.assetId,
        error: input.error ?? null
      }
    });
  }

  /** Delivery history, so an integrator can see why nothing arrived. */
  async listDeliveries(limit = 20): Promise<DeliveryRecord[]> {
    return this.ctx.storage.sql
      .exec<DeliveryRow>(
        `SELECT * FROM deliveries ORDER BY due_at DESC LIMIT ?`,
        Math.min(Math.max(limit, 1), 100)
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        webhookId: row.webhook_id,
        event: row.event,
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error
      }));
  }

  async stats(): Promise<{ projects: number; byKind: Record<string, number> }> {
    const rows = this.ctx.storage.sql
      .exec<{ kind: string; count: number }>(
        `SELECT kind, COUNT(*) AS count FROM projects WHERE archived_at IS NULL GROUP BY kind`
      )
      .toArray();
    return {
      projects: rows.reduce((total, row) => total + row.count, 0),
      byKind: Object.fromEntries(rows.map((row) => [row.kind, row.count]))
    };
  }
}

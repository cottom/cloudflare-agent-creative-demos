import { DurableObject } from "cloudflare:workers";
import { sha256Hex, timingSafeEqualHex, type Scope } from "./auth";

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

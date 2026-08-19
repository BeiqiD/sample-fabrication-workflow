import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new SqliteD1Statement(this.database, this.query, bindings);
  }

  private statement(): StatementSync {
    if (this.bindings.length > 100) throw new Error("D1 binding limit exceeded");
    return this.database.prepare(this.query);
  }

  async first<T>() {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement().all(...this.bindings) as T[], meta: {} };
  }

  async run() {
    return this.execute();
  }

  execute() {
    const statement = this.statement();
    if (/^\s*SELECT\b/i.test(this.query)) {
      return { success: true, meta: { changes: 0 }, results: statement.all(...this.bindings) };
    }
    const result = statement.run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
}

class SqliteD1Database {
  constructor(readonly database: DatabaseSync) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  database.exec(`
    INSERT INTO samples (id, code, title, status, created_at, updated_at)
    VALUES (
      'sample-zombie', 'ZOMBIE', 'Zombie regression', 'stored',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days')
    );

    INSERT INTO managed_storage_objects (
      id, provider, object_key, original_name, mime_type, byte_size,
      sha256, status, created_at, orphaned_at
    ) VALUES (
      'managed-zombie', 'switchdrive', 'comments/zombie.dat',
      'zombie.dat', 'application/octet-stream', 16,
      '${"a".repeat(64)}', 'ready',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'), NULL
    );

    INSERT INTO comment_submissions (
      id, context_kind, sample_id, body, status, created_at, updated_at
    ) VALUES (
      'submission-zombie', 'sample', 'sample-zombie', 'Keep this comment',
      'ready', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')
    );

    INSERT INTO comment_submission_items (
      id, submission_id, kind, status, position, filename, mime_type,
      byte_size, sha256, storage_object_id, created_at, updated_at,
      deleted_at, deleted_by
    ) VALUES (
      'item-zombie', 'submission-zombie', 'attachment', 'ready', 0,
      'zombie.dat', 'application/octet-stream', 16,
      '${"a".repeat(64)}', 'managed-zombie',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'),
      'local-development'
    );

    -- Model the real post-grace orphan sweep: the relationship already exists
    -- and no longer emits a retention edge, then GC marks both metadata and
    -- ledger state as orphaned.
    UPDATE managed_storage_objects
    SET status = 'orphaned',
        orphaned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    WHERE id = 'managed-zombie';

    INSERT INTO blob_gc_ledger (
      store_kind, provider, object_key, blob_record_id, state,
      operation_id, orphaned_at, updated_at
    ) VALUES (
      'managed', 'switchdrive', 'comments/zombie.dat', 'managed-zombie',
      'orphaned', 'orphan-zombie',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    );
  `);
  return database;
}

function envFor(database: DatabaseSync): Env {
  return {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database),
    ASSETS: {},
    MANAGED_STORAGE_PROVIDER: "switchdrive",
    SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/test-user/",
    SWITCHDRIVE_USERNAME: "test-user",
    SWITCHDRIVE_APP_PASSWORD: "test-password",
  } as unknown as Env;
}

function request(env: Env, path: string, init?: RequestInit) {
  return worker.fetch(
    new Request(`https://samples.run/api${path}`, init),
    env,
    {} as ExecutionContext,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("managed Comment attachment restore after orphan marking", () => {
  it("reactivates managed metadata, clears the orphan, rebuilds retention, and downloads", async () => {
    const database = migratedDatabase();
    const env = envFor(database);

    expect(database.prepare(`
      SELECT status, orphaned_at IS NOT NULL AS has_orphaned_at
      FROM managed_storage_objects WHERE id = 'managed-zombie'
    `).get()).toEqual({ status: "orphaned", has_orphaned_at: 1 });
    expect(database.prepare(`
      SELECT state FROM blob_gc_ledger WHERE object_key = 'comments/zombie.dat'
    `).get()).toEqual({ state: "orphaned" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_retention_edges
      WHERE store_kind = 'managed' AND object_key = 'comments/zombie.dat'
    `).get()).toEqual({ count: 0 });
    expect((await request(env, "/attachments/item-zombie/download")).status).toBe(404);

    const restored = await request(
      env,
      "/comment-submissions/submission-zombie/items/item-zombie/restore",
      { method: "POST" },
    );
    expect(restored.status).toBe(200);

    expect(database.prepare(`
      SELECT status, orphaned_at FROM managed_storage_objects
      WHERE id = 'managed-zombie'
    `).get()).toEqual({ status: "ready", orphaned_at: null });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_gc_ledger
      WHERE object_key = 'comments/zombie.dat'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT retention_reason, retain_until FROM blob_retention_edges
      WHERE store_kind = 'managed' AND object_key = 'comments/zombie.dat'
    `).get()).toEqual({ retention_reason: "ready_comment_item", retain_until: null });
    expect(database.prepare(`
      SELECT body, deleted_at FROM comment_submissions
      WHERE id = 'submission-zombie'
    `).get()).toEqual({ body: "Keep this comment", deleted_at: null });

    const providerFetch = vi.fn(async () => new Response("restored-bytes", {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        etag: "restored-etag",
      },
    }));
    vi.stubGlobal("fetch", providerFetch);

    const download = await request(env, "/attachments/item-zombie/download");
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("restored-bytes");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(String(providerFetch.mock.calls[0][0])).toContain("comments/zombie.dat");
    database.close();
  });
});

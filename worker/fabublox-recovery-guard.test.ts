import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { queueFabubloxImportCleanup } from "./fabublox-import-recovery";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const NOW = new Date("2026-09-13T10:00:00.000Z");
const bytes = new TextEncoder().encode("verified recovery snapshot bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const sourceKey = "imports/recovery/source.png";
const canonicalKey = "ready/canonical.png";

function rows(database: DatabaseSync) {
  return Object.fromEntries([
    "imports", "assets", "events", "blob_integrity_quarantine", "blob_gc_ledger",
  ].map((table) => [table, database.prepare(`SELECT * FROM ${table}`)
    .all().sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]));
}

function addQuarantine(database: DatabaseSync, key: string, id: string) {
  database.prepare(`INSERT INTO blob_integrity_quarantine
    (store_kind, provider, object_key, blob_record_id, reason, expected_byte_size,
      observed_byte_size, operation_id, detected_at, last_checked_at)
    VALUES ('r2', 'r2', ?, ?, 'missing', ?, NULL, 'raced-check', ?, ?)`)
    .run(key, id, bytes.byteLength, NOW.toISOString(), NOW.toISOString());
}

function fixture(options: { canonical?: boolean; sourceQuarantined?: boolean } = {}) {
  const database = referenceTestDatabase();
  database.exec(`
    INSERT INTO imports
      (id, status, source_filename, source_sha256, sheet_name, template_type,
        actor_email, created_at, operation_id, lease_expires_at)
    VALUES
      ('recovering-import', 'pending', 'source.xlsx', '${"a".repeat(64)}',
        'Sheet 1', 'process', 'researcher@example.com',
        '2026-09-01T00:00:00.000Z', 'upload-operation', '2026-09-02T00:00:00.000Z'),
      ('other-import', 'pending', 'other.xlsx', '${"b".repeat(64)}',
        'Sheet 1', 'process', 'researcher@example.com',
        '2026-09-01T00:00:00.000Z', 'other-operation', '2026-09-20T00:00:00.000Z');
    INSERT INTO samples (id, code, title, status, created_at, updated_at)
    VALUES ('retained-sample', 'RECOVERY-TEST', 'Recovery source', 'active',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO assets
      (id, import_id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
    VALUES ('source', NULL, '${sourceKey}', 'source.png', 'image/png', ${bytes.byteLength},
      'ready', NULL, '2026-09-01T00:00:00.000Z');
    INSERT INTO events (id, sample_id, kind, asset_key, created_at)
    VALUES ('retained-event', 'retained-sample', 'image', '${sourceKey}',
      '2026-09-01T00:00:00.000Z');
    -- Preserve an existing public consumer while reproducing the recoverable
    -- failed-import metadata accepted by the current schema. No guards disabled.
    UPDATE assets SET import_id = 'recovering-import', status = 'failed',
      sha256 = ${options.canonical ? `'${digest}'` : "NULL"} WHERE id = 'source';
  `);
  if (options.canonical) {
    database.prepare(`INSERT INTO assets
      (id, import_id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('canonical', NULL, ?, 'canonical.png', 'image/png', ?, 'ready', ?, ?)`)
      .run(canonicalKey, bytes.byteLength, digest, NOW.toISOString());
  }
  if (options.sourceQuarantined) addQuarantine(database, sourceKey, "source");

  let mutate: (() => void) | undefined;
  let racedState: ReturnType<typeof rows> | undefined;
  const get = vi.fn(async (key: string) => {
    // Capture the object first, then simulate a different request committing
    // metadata during the successful provider read. Verification consumes the
    // original bytes, so only the transactional snapshot fence can reject this.
    const object = {
      body: new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bytes);
        controller.close();
      } }),
      size: bytes.byteLength,
      httpEtag: '"fixture-etag"',
      writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); },
    };
    if (mutate && key === (options.canonical ? canonicalKey : sourceKey)) {
      const callback = mutate;
      mutate = undefined;
      callback();
      racedState = rows(database);
    }
    return object;
  });
  const put = vi.fn(), remove = vi.fn();
  const env = {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {
      get, put, delete: remove,
      head: vi.fn(async () => ({ size: bytes.byteLength, httpEtag: '"fixture-etag"',
        writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); } })),
    } as unknown as R2Bucket,
  } satisfies Env;
  return {
    database, get, put, remove,
    onRead(callback: () => void) { mutate = callback; },
    racedState() { return racedState; },
    recover() { return queueFabubloxImportCleanup(env, {
      importId: "recovering-import", operationId: "upload-operation",
      recoveryOperationId: "cleanup-operation", now: NOW, error: new Error("Interrupted upload"),
    }); },
  };
}

async function rejectsRace(
  mutate: (database: DatabaseSync) => void,
  options: Parameters<typeof fixture>[0] = {},
) {
  const state = fixture(options);
  try {
    state.onRead(() => mutate(state.database));
    await expect(state.recover()).rejects.toThrow(/malformed JSON/);
    expect(state.racedState(), "the independent metadata change was committed during GET").toBeDefined();
    expect(rows(state.database), "claim, adoption and cleanup roll back without undoing the competing request")
      .toEqual(state.racedState());
    expect(state.database.prepare(`SELECT status, recovery_operation_id, completed_at
      FROM imports WHERE id = 'recovering-import'`).get()).toEqual({
      status: "pending", recovery_operation_id: null, completed_at: null,
    });
    expect(state.database.prepare("SELECT asset_key FROM events WHERE id = 'retained-event'").get())
      .toEqual({ asset_key: sourceKey });
    expect(state.database.prepare("SELECT * FROM blob_gc_ledger").all()).toEqual([]);
    expect(state.put).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { state.database.close(); }
}

describe("FabuBlox recovery publication snapshot on the current schema", () => {
  it.each([
    ["key", "UPDATE assets SET r2_key = 'unverified/replacement.png' WHERE id = 'source'"],
    ["hash", `UPDATE assets SET sha256 = '${"f".repeat(64)}' WHERE id = 'source'`],
    ["size", "UPDATE assets SET byte_size = byte_size + 1 WHERE id = 'source'"],
    ["status", "UPDATE assets SET status = 'pending' WHERE id = 'source'"],
    ["owner", "UPDATE assets SET import_id = 'other-import' WHERE id = 'source'"],
    ["removed source", "DELETE FROM assets WHERE id = 'source'"],
    ["added source", `INSERT INTO assets
      (id, import_id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('new-source', 'recovering-import', 'uninspected/new.png', 'new.png',
        'image/png', 5, 'pending', NULL, '2026-09-01T00:01:00.000Z')`],
  ])("rolls back recovery when the source %s changes after inspection", async (_label, sql) => {
    await rejectsRace((database) => database.exec(sql));
  });

  it("does not promote a source quarantined while its successful GET is in flight", async () => {
    await rejectsRace((database) => addQuarantine(database, sourceKey, "source"));
  });

  it("does not rebind from a stale diagnosis after another request removes source quarantine", async () => {
    await rejectsRace((database) => database.prepare(
      "DELETE FROM blob_integrity_quarantine WHERE object_key = ?",
    ).run(sourceKey), { canonical: true, sourceQuarantined: true });
  });

  it.each([
    ["key", "UPDATE assets SET r2_key = 'unverified/canonical-replacement.png' WHERE id = 'canonical'"],
    ["hash", `UPDATE assets SET sha256 = '${"e".repeat(64)}' WHERE id = 'canonical'`],
    ["size", "UPDATE assets SET byte_size = byte_size + 1 WHERE id = 'canonical'"],
    ["status", "UPDATE assets SET status = 'failed' WHERE id = 'canonical'"],
    ["private ownership", "UPDATE assets SET import_id = 'other-import' WHERE id = 'canonical'"],
  ])("rejects canonical %s changes after the canonical bytes were selected", async (_label, sql) => {
    await rejectsRace((database) => database.exec(sql), { canonical: true });
  });

  it("rejects a canonical quarantined during its successful full GET", async () => {
    await rejectsRace((database) => addQuarantine(database, canonicalKey, "canonical"), { canonical: true });
  });

  it.each([false, true])("publishes only unchanged verified evidence (canonical=%s)", async (canonical) => {
    const state = fixture({ canonical });
    try {
      const result = await state.recover();
      expect(result.importsFailed).toBe(1);
      expect(state.database.prepare(`SELECT status, recovery_operation_id
        FROM imports WHERE id = 'recovering-import'`).get()).toEqual({
        status: "failed", recovery_operation_id: "cleanup-operation",
      });
      expect(state.database.prepare("SELECT asset_key FROM events WHERE id = 'retained-event'").get())
        .toEqual({ asset_key: canonical ? canonicalKey : sourceKey });
      expect(state.database.prepare("SELECT import_id, status, sha256 FROM assets WHERE id = ?")
        .get(canonical ? "canonical" : "source"))
        .toEqual({ import_id: null, status: "ready", sha256: digest });
      expect(result.objectsQueued).toBe(canonical ? 1 : 0);
      expect(state.put).not.toHaveBeenCalled();
      expect(state.remove).not.toHaveBeenCalled();
      expect(state.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { state.database.close(); }
  });
});

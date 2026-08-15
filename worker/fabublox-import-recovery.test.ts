import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
import { reapStaleFabubloxImports } from "./fabublox-import-recovery";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = () => readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const NOW = new Date("2026-08-20T00:00:00.000Z");
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function applyMigrations(
  database: DatabaseSync,
  predicate: (name: string) => boolean,
) {
  for (const filename of migrationNames().filter(predicate)) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
}

function bytesBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function streamBytes(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function r2Object(bytes: Uint8Array, contentType = "image/png") {
  return {
    body: streamBytes(bytes),
    size: bytes.byteLength,
    httpEtag: '"fabublox-recovery"',
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", contentType);
    },
  };
}

function recoveryEnv(
  database: DatabaseSync,
  stored: Map<string, Uint8Array>,
  options: { failReads?: boolean } = {},
) {
  const head = vi.fn(async (key: string) => {
    if (options.failReads) throw new Error("temporary R2 outage");
    const bytes = stored.get(key);
    return bytes ? r2Object(bytes) : null;
  });
  const get = vi.fn(async (key: string) => {
    if (options.failReads) throw new Error("temporary R2 outage");
    const bytes = stored.get(key);
    return bytes ? r2Object(bytes) : null;
  });
  const remove = vi.fn(async (key: string) => {
    stored.delete(key);
  });
  const env = {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {
      head,
      get,
      delete: remove,
      put: vi.fn(),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket,
  } satisfies Env;
  return { env, head, get, remove };
}

function seedSharedImportState(
  database: DatabaseSync,
  input: {
    importAStatus: "pending" | "failed";
    importBStatus: "pending" | "ready";
    assetStatus: "pending" | "ready" | "failed";
    assetSha256: string | null;
    assetByteSize: number;
  },
) {
  database.exec(`
    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES
      ('family-a', 'Import A', 'process', '2026-07-01T00:00:00.000Z'),
      ('family-b', 'Import B', 'process', '2026-07-01T00:00:00.000Z');

    INSERT INTO state_representations
      (hash, representation_type, content_json, created_at)
    VALUES ('shared-state', 'diagram', '{}', '2026-07-01T00:00:00.000Z');

    INSERT INTO step_definitions (hash, name, canonical_json, created_at)
    VALUES ('shared-definition', 'Shared state', '{}', '2026-07-01T00:00:00.000Z');

    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash,
       initial_state_hash, source_asset_key, content_json, created_at, template_kind)
    VALUES
      ('template-a', 'family-a', 'Template A', 'process', 1,
       'manifest-a', 'shared-state', NULL, '{}',
       '2026-07-01T00:00:00.000Z', 'process'),
      ('template-b', 'family-b', 'Template B', 'process', 1,
       'manifest-b', 'shared-state', NULL, '{}',
       '2026-07-01T00:01:00.000Z', 'process');

    INSERT INTO template_steps
      (id, template_version_id, logical_step_key, position, definition_hash,
       expected_state_hash, raw_json)
    VALUES
      ('step-a', 'template-a', 'a:shared', 0,
       'shared-definition', 'shared-state', '{}'),
      ('step-b', 'template-b', 'b:shared', 0,
       'shared-definition', 'shared-state', '{}');

    INSERT INTO imports
      (id, status, source_filename, source_sha256, sheet_name, template_type,
       recipe_family_id, template_version_id, actor_email, created_at,
       completed_at, operation_id, lease_expires_at, finalization_id)
    VALUES
      ('import-a', '${input.importAStatus}', 'a.zip', '${"1".repeat(64)}',
       'manifest', 'process', 'family-a', 'template-a', 'a@example.com',
       '2026-07-01T00:00:00.000Z',
       ${input.importAStatus === "failed" ? "'2026-07-01T01:00:00.000Z'" : "NULL"},
       'operation-a',
       ${input.importAStatus === "pending" ? "'2026-07-02T00:00:00.000Z'" : "NULL"},
       NULL),
      ('import-b', '${input.importBStatus}', 'b.zip', '${"2".repeat(64)}',
       'manifest', 'process', 'family-b', 'template-b', 'b@example.com',
       '2026-07-01T00:01:00.000Z',
       ${input.importBStatus === "ready" ? "'2026-07-01T02:00:00.000Z'" : "NULL"},
       'operation-b',
       ${input.importBStatus === "pending" ? "'2026-09-01T00:00:00.000Z'" : "NULL"},
       ${input.importBStatus === "ready" ? "'finalization-b'" : "NULL"});

    INSERT INTO assets
      (id, import_id, r2_key, original_name, mime_type, byte_size, status,
       sha256, created_at)
    VALUES
      ('shared-asset', 'import-a', 'imports/a/shared.png', 'shared.png',
       'image/png', ${input.assetByteSize}, '${input.assetStatus}',
       ${input.assetSha256 === null ? "NULL" : `'${input.assetSha256}'`},
       '2026-07-01T00:00:00.000Z');

    INSERT INTO state_representation_assets (state_hash, asset_id, position)
    VALUES ('shared-state', 'shared-asset', 0);
  `);
}

function legacyDatabase() {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, (name) => name <= "0024_blob_integrity_quarantine.sql");
  return database;
}

function finishRecoveryMigrations(database: DatabaseSync) {
  applyMigrations(database, (name) => name > "0024_blob_integrity_quarantine.sql");
}

describe("FabuBlox import recovery ownership", () => {
  it("transfers a shared asset to pending Import B without publishing it, then GC-queues it when B fails", async () => {
    const database = legacyDatabase();
    const bytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);
    const sha256 = await sha256Hex(bytesBuffer(bytes));
    seedSharedImportState(database, {
      importAStatus: "pending",
      importBStatus: "pending",
      assetStatus: "pending",
      assetSha256: sha256,
      assetByteSize: bytes.byteLength,
    });
    finishRecoveryMigrations(database);
    const stored = new Map([["imports/a/shared.png", bytes]]);
    const { env, head, get } = recoveryEnv(database, stored);

    const before = await worker.fetch(new Request(
      "https://app.test/api/assets/imports/a/shared.png",
    ), env, executionContext);
    expect(before.status).toBe(404);
    expect(get).not.toHaveBeenCalled();

    const recoveredA = await reapStaleFabubloxImports(env, NOW);
    expect(recoveredA).toEqual({
      staleImportsFailed: 1,
      staleImportAssetsReleased: 0,
      staleImportObjectsQueued: 0,
      staleImportRecoveryFailures: 0,
    });
    expect(database.prepare(`
      SELECT status FROM imports WHERE id = 'import-b'
    `).get()).toEqual({ status: "pending" });
    expect(database.prepare(`
      SELECT import_id, status, sha256 FROM assets WHERE id = 'shared-asset'
    `).get()).toEqual({
      import_id: "import-b",
      status: "pending",
      sha256,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM state_representation_assets
      WHERE state_hash = 'shared-state' AND asset_id = 'shared-asset'
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_gc_ledger
      WHERE object_key = 'imports/a/shared.png'
    `).get()).toEqual({ count: 0 });
    expect(head).toHaveBeenCalledWith("imports/a/shared.png");

    const afterA = await worker.fetch(new Request(
      "https://app.test/api/assets/imports/a/shared.png",
    ), env, executionContext);
    expect(afterA.status).toBe(404);
    expect(get).not.toHaveBeenCalled();

    database.prepare(`
      UPDATE imports
      SET status = 'failed', completed_at = '2026-08-20T01:00:00.000Z',
          lease_expires_at = NULL
      WHERE id = 'import-b'
    `).run();
    const recoveredB = await reapStaleFabubloxImports(
      env,
      new Date("2026-08-20T02:00:00.000Z"),
    );
    expect(recoveredB).toEqual({
      staleImportsFailed: 1,
      staleImportAssetsReleased: 1,
      staleImportObjectsQueued: 1,
      staleImportRecoveryFailures: 0,
    });
    expect(database.prepare(`
      SELECT import_id, status, sha256 FROM assets WHERE id = 'shared-asset'
    `).get()).toEqual({
      import_id: "import-b",
      status: "failed",
      sha256: null,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM state_representation_assets
      WHERE state_hash = 'shared-state' AND asset_id = 'shared-asset'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT state FROM blob_gc_ledger
      WHERE object_key = 'imports/a/shared.png'
    `).get()).toEqual({ state: "orphaned" });
    expect((await worker.fetch(new Request(
      "https://app.test/api/assets/imports/a/shared.png",
    ), env, executionContext)).status).toBe(404);
    database.close();
  });

  it("reconstructs SHA and byte size from provider bytes before restoring a legacy failed asset used by ready B", async () => {
    const database = legacyDatabase();
    const bytes = Uint8Array.from([137, 80, 78, 71, 11, 12, 13]);
    const sha256 = await sha256Hex(bytesBuffer(bytes));
    seedSharedImportState(database, {
      importAStatus: "failed",
      importBStatus: "ready",
      assetStatus: "failed",
      assetSha256: null,
      assetByteSize: 999,
    });
    finishRecoveryMigrations(database);
    const stored = new Map([["imports/a/shared.png", bytes]]);
    const { env, get, head } = recoveryEnv(database, stored);

    const result = await reapStaleFabubloxImports(env, NOW);
    expect(result).toEqual({
      staleImportsFailed: 1,
      staleImportAssetsReleased: 0,
      staleImportObjectsQueued: 0,
      staleImportRecoveryFailures: 0,
    });
    expect(get).toHaveBeenCalledWith("imports/a/shared.png");
    expect(head).not.toHaveBeenCalled();
    expect(database.prepare(`
      SELECT import_id, status, sha256, byte_size
      FROM assets WHERE id = 'shared-asset'
    `).get()).toEqual({
      import_id: null,
      status: "ready",
      sha256,
      byte_size: bytes.byteLength,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_integrity_quarantine
      WHERE object_key = 'imports/a/shared.png'
    `).get()).toEqual({ count: 0 });

    const live = await worker.fetch(new Request(
      "https://app.test/api/assets/imports/a/shared.png",
    ), env, executionContext);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(bytes);
    database.close();
  });

  it("quarantines a missing legacy failed object instead of publishing metadata retained by ready B", async () => {
    const database = legacyDatabase();
    seedSharedImportState(database, {
      importAStatus: "failed",
      importBStatus: "ready",
      assetStatus: "failed",
      assetSha256: null,
      assetByteSize: 17,
    });
    finishRecoveryMigrations(database);
    const { env, get } = recoveryEnv(database, new Map());

    const result = await reapStaleFabubloxImports(env, NOW);
    expect(result).toEqual({
      staleImportsFailed: 1,
      staleImportAssetsReleased: 1,
      staleImportObjectsQueued: 0,
      staleImportRecoveryFailures: 0,
    });
    expect(get).toHaveBeenCalledWith("imports/a/shared.png");
    expect(database.prepare(`
      SELECT import_id, status, sha256 FROM assets WHERE id = 'shared-asset'
    `).get()).toEqual({ import_id: null, status: "failed", sha256: null });
    expect(database.prepare(`
      SELECT reason, expected_byte_size, observed_byte_size
      FROM blob_integrity_quarantine
      WHERE object_key = 'imports/a/shared.png'
    `).get()).toEqual({
      reason: "missing",
      expected_byte_size: 17,
      observed_byte_size: null,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM state_representation_assets
      WHERE state_hash = 'shared-state' AND asset_id = 'shared-asset'
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_gc_ledger
      WHERE object_key = 'imports/a/shared.png'
    `).get()).toEqual({ count: 0 });

    const callsBeforeLive = get.mock.calls.length;
    expect((await worker.fetch(new Request(
      "https://app.test/api/assets/imports/a/shared.png",
    ), env, executionContext)).status).toBe(404);
    expect(get).toHaveBeenCalledTimes(callsBeforeLive);
    database.close();
  });

  it("does not claim recovery when R2 verification is temporarily unavailable", async () => {
    const database = legacyDatabase();
    seedSharedImportState(database, {
      importAStatus: "failed",
      importBStatus: "ready",
      assetStatus: "failed",
      assetSha256: null,
      assetByteSize: 17,
    });
    finishRecoveryMigrations(database);
    const { env, get } = recoveryEnv(database, new Map(), { failReads: true });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await reapStaleFabubloxImports(env, NOW);
    expect(result).toEqual({
      staleImportsFailed: 0,
      staleImportAssetsReleased: 0,
      staleImportObjectsQueued: 0,
      staleImportRecoveryFailures: 1,
    });
    expect(get).toHaveBeenCalledWith("imports/a/shared.png");
    expect(database.prepare(`
      SELECT status, recovery_operation_id, template_version_id
      FROM imports WHERE id = 'import-a'
    `).get()).toEqual({
      status: "failed",
      recovery_operation_id: null,
      template_version_id: "template-a",
    });
    expect(database.prepare(`
      SELECT import_id, status, sha256 FROM assets WHERE id = 'shared-asset'
    `).get()).toEqual({
      import_id: "import-a",
      status: "failed",
      sha256: null,
    });
    errorLog.mockRestore();
    database.close();
  });

  it("blocks pending Import B finalization when its shared state asset is quarantined", async () => {
    const database = legacyDatabase();
    const sha256 = "f".repeat(64);
    seedSharedImportState(database, {
      importAStatus: "pending",
      importBStatus: "pending",
      assetStatus: "ready",
      assetSha256: sha256,
      assetByteSize: 17,
    });
    database.exec(`
      INSERT INTO samples
        (id, code, title, inherited_state_hash, created_at, updated_at)
      VALUES (
        'public-sample', 'PUBLIC', 'Public state consumer', 'shared-state',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      );
    `);
    finishRecoveryMigrations(database);
    const { env, head } = recoveryEnv(database, new Map());

    const recovered = await reapStaleFabubloxImports(env, NOW);
    expect(recovered).toEqual({
      staleImportsFailed: 1,
      staleImportAssetsReleased: 1,
      staleImportObjectsQueued: 0,
      staleImportRecoveryFailures: 0,
    });
    expect(head).toHaveBeenCalledWith("imports/a/shared.png");
    expect(database.prepare(`
      SELECT import_id, status, sha256 FROM assets WHERE id = 'shared-asset'
    `).get()).toEqual({
      import_id: null,
      status: "failed",
      sha256: null,
    });
    expect(database.prepare(`
      SELECT reason FROM blob_integrity_quarantine
      WHERE object_key = 'imports/a/shared.png'
    `).get()).toEqual({ reason: "missing" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM fabublox_import_asset_dependencies
      WHERE import_id = 'import-b' AND asset_id = 'shared-asset'
    `).get()).toEqual({ count: 2 });

    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size, status, sha256,
        created_at
      ) VALUES
        ('b-workbook', 'imports/b/workbook.xlsx', 'workbook.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          4, 'ready', '${"a".repeat(64)}', '2026-08-20T00:10:00.000Z'),
        ('b-manifest', 'imports/b/manifest.json', 'manifest.json',
          'application/json', 4, 'ready', '${"b".repeat(64)}',
          '2026-08-20T00:10:00.000Z');
    `);

    expect(() => database.prepare(`
      UPDATE imports
      SET status = 'ready',
          workbook_asset_key = 'imports/b/workbook.xlsx',
          manifest_asset_key = 'imports/b/manifest.json',
          finalization_id = 'finalization-b',
          completed_at = '2026-08-20T00:30:00.000Z',
          lease_expires_at = NULL
      WHERE id = 'import-b'
    `).run()).toThrow(/import assets are not publishable/);
    expect(database.prepare(`
      SELECT status, finalization_id, workbook_asset_key, manifest_asset_key
      FROM imports WHERE id = 'import-b'
    `).get()).toEqual({
      status: "pending",
      finalization_id: null,
      workbook_asset_key: null,
      manifest_asset_key: null,
    });
    expect((await worker.fetch(new Request(
      "https://app.test/api/templates/template-b",
    ), env, executionContext)).status).toBe(404);
    database.close();
  });

  it("rebinds every durable legacy occurrence to an existing canonical winner and queues only the old locator", async () => {
    const database = legacyDatabase();
    const bytes = Uint8Array.from([137, 80, 78, 71, 71, 72, 73, 74]);
    const sha256 = await sha256Hex(bytesBuffer(bytes));
    seedSharedImportState(database, {
      importAStatus: "failed",
      importBStatus: "pending",
      assetStatus: "ready",
      assetSha256: null,
      assetByteSize: bytes.byteLength,
    });
    // This fixture represents a relationship written before 0024 introduced
    // the provider-availability insert guard.
    database.exec("DROP TRIGGER project_content_attachments_guard_integrity_insert;");
    database.exec(`
      UPDATE template_versions
      SET source_asset_key = 'imports/a/shared.png'
      WHERE id = 'template-b';

      UPDATE imports
      SET workbook_asset_key = 'imports/a/shared.png',
          manifest_asset_key = 'imports/a/shared.png'
      WHERE id = 'import-b';

      INSERT INTO metrology_template_references (
        id, template_version_id, asset_id, display_name, position, created_at
      ) VALUES (
        'reference-b', 'template-b', 'shared-asset', 'shared.png', 0,
        '2026-07-01T00:02:00.000Z'
      );

      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size, status, sha256,
        created_at
      ) VALUES (
        'canonical-winner', 'ready/canonical-shared.png', 'canonical.png',
        'image/png', ${bytes.byteLength}, 'ready', '${sha256}',
        '2026-06-01T00:00:00.000Z'
      );

      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES (
        'recovery-sample', 'RECOVERY', 'Recovery sample',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      );

      INSERT INTO events (
        id, sample_id, kind, asset_key, metadata_json, created_at
      ) VALUES (
        'recovery-event', 'recovery-sample', 'image',
        'imports/a/shared.png',
        '{"thumbnailKey":"imports/a/shared.png"}',
        '2026-07-01T00:03:00.000Z'
      );

      INSERT INTO projects (
        id, title, revision, next_created_sequence, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'recovery-project', 'Recovery project', 1, 1, 'project-create',
        'recovery@example.com', 'recovery@example.com',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      );

      INSERT INTO project_contents (
        id, project_id, content_type, markdown_source, attachment_caption,
        attachment_source_url, format_version, revision, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        'recovery-content', 'recovery-project', 'attachment', NULL, NULL,
        NULL, 1, 1, 'content-create', 'recovery@example.com',
        'recovery@example.com', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );

      INSERT INTO project_content_attachments (
        project_content_id, asset_id, storage_object_id, original_name,
        mime_type, byte_size, created_by, created_at, creation_operation_id
      ) VALUES (
        'recovery-content', 'shared-asset', NULL, 'shared.png', 'image/png',
        ${bytes.byteLength}, 'recovery@example.com',
        '2026-07-01T00:00:00.000Z', 'attachment-create'
      );
    `);
    finishRecoveryMigrations(database);

    const stored = new Map<string, Uint8Array>([
      ["imports/a/shared.png", bytes],
      ["ready/canonical-shared.png", bytes],
    ]);
    const { env, get } = recoveryEnv(database, stored);

    const result = await reapStaleFabubloxImports(env, NOW);
    expect(result).toEqual({
      staleImportsFailed: 1,
      staleImportAssetsReleased: 1,
      staleImportObjectsQueued: 1,
      staleImportRecoveryFailures: 0,
    });
    expect(get).toHaveBeenCalledWith("imports/a/shared.png");

    expect(database.prepare(`
      SELECT asset_id FROM state_representation_assets
      WHERE state_hash = 'shared-state'
    `).all()).toEqual([{ asset_id: "canonical-winner" }]);
    expect(database.prepare(`
      SELECT asset_id FROM metrology_template_references
      WHERE id = 'reference-b'
    `).get()).toEqual({ asset_id: "canonical-winner" });
    expect(database.prepare(`
      SELECT asset_id FROM project_content_attachments
      WHERE project_content_id = 'recovery-content'
    `).get()).toEqual({ asset_id: "canonical-winner" });
    expect(database.prepare(`
      SELECT asset_key,
             json_extract(metadata_json, '$.thumbnailKey') AS thumbnail_key
      FROM events WHERE id = 'recovery-event'
    `).get()).toEqual({
      asset_key: "ready/canonical-shared.png",
      thumbnail_key: "ready/canonical-shared.png",
    });
    expect(database.prepare(`
      SELECT workbook_asset_key, manifest_asset_key
      FROM imports WHERE id = 'import-b'
    `).get()).toEqual({
      workbook_asset_key: "ready/canonical-shared.png",
      manifest_asset_key: "ready/canonical-shared.png",
    });
    expect(database.prepare(`
      SELECT source_asset_key FROM template_versions WHERE id = 'template-b'
    `).get()).toEqual({
      source_asset_key: "ready/canonical-shared.png",
    });
    expect(database.prepare(`
      SELECT import_id, status, sha256
      FROM assets WHERE id = 'shared-asset'
    `).get()).toEqual({
      import_id: "import-a",
      status: "failed",
      sha256: null,
    });
    expect(database.prepare(`
      SELECT state, blob_record_id
      FROM blob_gc_ledger
      WHERE store_kind = 'r2' AND provider = 'r2'
        AND object_key = 'imports/a/shared.png'
    `).get()).toEqual({
      state: "orphaned",
      blob_record_id: "shared-asset",
    });
    expect(database.prepare(`
      SELECT status, sha256 FROM assets WHERE id = 'canonical-winner'
    `).get()).toEqual({ status: "ready", sha256 });

    const retry = await reapStaleFabubloxImports(
      env,
      new Date("2026-08-20T01:00:00.000Z"),
    );
    expect(retry).toEqual({
      staleImportsFailed: 0,
      staleImportAssetsReleased: 0,
      staleImportObjectsQueued: 0,
      staleImportRecoveryFailures: 0,
    });
    database.close();
  });

});

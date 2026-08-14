import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import { runBlobGarbageCollection } from "./blob-lifecycle/gc";
import { encodeReferenceRouteId } from "../shared/reference-destinations";
import worker from "./index";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";
import type { Env } from "./types";

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const NOW = "2026-08-14T18:00:00.000Z";

function streamBytes(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function r2Object(bytes: Uint8Array, contentType = "application/octet-stream") {
  return {
    body: streamBytes(bytes),
    size: bytes.byteLength,
    httpEtag: '"integrity-etag"',
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", contentType);
    },
  };
}

class HookedD1Statement {
  constructor(
    private readonly owner: HookedD1Database,
    readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new HookedD1Statement(this.owner, this.sql, bindings);
  }

  private statement(): StatementSync {
    return this.owner.database.prepare(this.sql);
  }

  async first<T>() {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement().all(...this.bindings) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    return this.execute();
  }

  execute() {
    this.owner.beforeExecute?.(this.sql, this.bindings);
    const statement = this.statement();
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } };
    }
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class HookedD1Database {
  constructor(
    readonly database: DatabaseSync,
    readonly beforeExecute?: (query: string, bindings: unknown[]) => void,
    readonly beforeBatch?: (statements: HookedD1Statement[]) => Promise<void> | void,
    readonly afterBatch?: (statements: HookedD1Statement[]) => Promise<void> | void,
  ) {}

  prepare(sql: string) {
    return new HookedD1Statement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    const hookedStatements = statements as unknown as HookedD1Statement[];
    await this.beforeBatch?.(hookedStatements);
    this.database.exec("BEGIN");
    try {
      const results = hookedStatements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      await this.afterBatch?.(hookedStatements);
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("quarantine-aware live delivery", () => {
  it("blocks quarantined R2 assets from ordinary and execution-image routes while export remains readable", async () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    database.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES ('r2', 'r2', 'reference/private/execution.png',
        'reference-execution-asset', 'size_mismatch', 11, 99,
        'operation-live-r2', ?, ?)
    `).run(NOW, NOW);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const get = vi.fn(async (key: string) =>
      key === "reference/private/execution.png" ? r2Object(bytes, "image/png") : null);
    const env = {
      AUTH_MODE: "disabled",
      DB: new SqliteD1Database(database) as unknown as D1Database,
      ASSETS: { get } as unknown as R2Bucket,
    } satisfies Env;

    const ordinary = await worker.fetch(new Request(
      "https://app.test/api/assets/reference/private/execution.png",
    ), env, executionContext);
    const execution = await worker.fetch(new Request(
      `https://app.test/api/references/media/execution_image/${encodeReferenceRouteId(REFERENCE_FIXTURE_IDS.executionImage)}?step=${REFERENCE_FIXTURE_IDS.stepA}`,
    ), env, executionContext);
    expect(ordinary.status).toBe(404);
    expect(execution.status).toBe(404);
    expect(get).not.toHaveBeenCalled();

    const exported = await worker.fetch(new Request(
      "https://app.test/api/exports/r2/reference/private/execution.png",
    ), env, executionContext);
    expect(exported.status).toBe(200);
    expect(new Uint8Array(await exported.arrayBuffer())).toEqual(bytes);
    expect(get).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("blocks a quarantined managed Comment attachment from live download while export still reads it", async () => {
    const database = referenceTestDatabase();
    database.exec(`
      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('sample-managed-live', 'M-LIVE', 'Managed live sample', '${NOW}', '${NOW}');
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES (
        'managed-live-object', 'switchdrive', 'comments/live/file.bin', 'file.bin',
        'application/octet-stream', 9,
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        'ready', 'user@example.com', '${NOW}'
      );
      INSERT INTO comment_submissions (
        id, context_kind, sample_id, body, status, actor_email,
        created_at, updated_at, completed_at
      ) VALUES (
        'managed-live-submission', 'sample', 'sample-managed-live', 'Attachment',
        'ready', 'user@example.com', '${NOW}', '${NOW}', '${NOW}'
      );
      INSERT INTO comment_submission_items (
        id, submission_id, kind, status, position, filename, mime_type,
        byte_size, storage_object_id, created_at, updated_at
      ) VALUES (
        'managed-live-item', 'managed-live-submission', 'attachment', 'ready', 0,
        'file.bin', 'application/octet-stream', 9, 'managed-live-object',
        '${NOW}', '${NOW}'
      );
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES (
        'managed', 'switchdrive', 'comments/live/file.bin', 'managed-live-object',
        'size_mismatch', 9, 12, 'operation-live-managed', '${NOW}', '${NOW}'
      );
    `);
    const bytes = Uint8Array.from([9, 8, 7]);
    const fetchMock = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        etag: '"managed-live"',
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      AUTH_MODE: "disabled",
      DB: new SqliteD1Database(database) as unknown as D1Database,
      ASSETS: {} as R2Bucket,
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
      SWITCHDRIVE_USERNAME: "user@example.ch",
      SWITCHDRIVE_APP_PASSWORD: "app-password",
    } satisfies Env;

    const live = await worker.fetch(new Request(
      "https://app.test/api/attachments/managed-live-item/download",
    ), env, executionContext);
    expect(live.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();

    const exported = await worker.fetch(new Request(
      "https://app.test/api/exports/attachments/managed-live-item",
    ), env, executionContext);
    expect(exported.status).toBe(200);
    expect(new Uint8Array(await exported.arrayBuffer())).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    database.close();
  });
  it("rejects a quarantined Sample thumbnail before creating the record", async () => {
    const database = referenceTestDatabase();
    database.exec(`
      INSERT INTO samples (id, code, title, status, location, pinned, created_at, updated_at)
      VALUES ('sample-thumbnail-route', 'TH-ROUTE', 'Thumbnail route', 'stored', NULL, 0,
        '${NOW}', '${NOW}');
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at
      ) VALUES
        ('asset-route-primary', 'records/route-primary.bin', 'primary.bin',
          'application/octet-stream', 4, 'ready',
          '6666666666666666666666666666666666666666666666666666666666666666', '${NOW}'),
        ('asset-route-thumbnail', 'records/route-thumbnail.bin', 'thumbnail.bin',
          'application/octet-stream', 4, 'ready',
          '7777777777777777777777777777777777777777777777777777777777777777', '${NOW}');
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES (
        'r2', 'r2', 'records/route-thumbnail.bin', 'asset-route-thumbnail',
        'missing', 4, NULL, 'operation-thumbnail-route', '${NOW}', '${NOW}'
      );
    `);
    const env = {
      AUTH_MODE: 'disabled',
      DB: new SqliteD1Database(database) as unknown as D1Database,
      ASSETS: {} as R2Bucket,
    } satisfies Env;

    const response = await worker.fetch(new Request(
      'https://app.test/api/samples/sample-thumbnail-route/records',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: NOW,
          status: 'stored',
          location: '',
          pinned: false,
          assetKey: 'records/route-primary.bin',
          thumbnailKey: 'records/route-thumbnail.bin',
        }),
      },
    ), env, executionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'One or more uploaded assets are unavailable',
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM events WHERE sample_id = 'sample-thumbnail-route'
    `).get()).toEqual({ count: 0 });
    database.close();
  });

  it("maps SQL quarantine guards to a deterministic 409 response", async () => {
    const database = referenceTestDatabase();
    database.exec(`
      INSERT INTO samples (id, code, title, status, location, pinned, created_at, updated_at)
      VALUES ('sample-quarantine-error', 'Q-409', 'Quarantine mapping', 'stored', NULL, 0,
        '${NOW}', '${NOW}');
    `);
    const d1 = new HookedD1Database(database, (query) => {
      if (/^\s*INSERT INTO events\b/i.test(query)) {
        throw new Error('blob locator is quarantined');
      }
    });
    const env = {
      AUTH_MODE: 'disabled',
      DB: d1 as unknown as D1Database,
      ASSETS: {} as R2Bucket,
    } satisfies Env;

    const response = await worker.fetch(new Request(
      'https://app.test/api/samples/sample-quarantine-error/records',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: NOW,
          status: 'stored',
          location: '',
          pinned: false,
          body: 'A record whose guarded relationship is rejected',
        }),
      },
    ), env, executionContext);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'The selected file failed an integrity check. Upload a verified replacement.',
    });
    expect(database.prepare(`
      SELECT updated_at FROM samples WHERE id = 'sample-quarantine-error'
    `).get()).toEqual({ updated_at: NOW });
    database.close();
  });
});

describe("FabuBlox storage winner recovery", () => {
  it("reconciles a valid winner inserted after initial verification and before asset registration", async () => {
    const database = referenceTestDatabase();
    const workbookBytes = Uint8Array.from([80, 75, 3, 4, 20, 26, 8, 0]);
    const workbookBuffer = workbookBytes.buffer.slice(
      workbookBytes.byteOffset,
      workbookBytes.byteOffset + workbookBytes.byteLength,
    ) as ArrayBuffer;
    const workbookSha = await sha256Hex(workbookBuffer);
    const winnerKey = "race/winner.xlsx";
    const stored = new Map<string, Uint8Array>([[winnerKey, workbookBytes]]);
    const deletedKeys: string[] = [];
    let injected = false;
    const d1 = new HookedD1Database(database, (query, bindings) => {
      if (injected || !/^\s*INSERT INTO assets\b/i.test(query)
        || bindings.at(-1) !== workbookSha) return;
      injected = true;
      database.prepare(`
        INSERT INTO assets (
          id, r2_key, original_name, mime_type, byte_size,
          status, actor_email, created_at, sha256
        ) VALUES (
          'fabublox-race-winner', ?, 'race.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ?,
          'ready', 'winner@example.com', ?, ?
        )
      `).run(winnerKey, workbookBytes.byteLength, NOW, workbookSha);
    });
    const put = vi.fn(async (key: string, value: unknown) => {
      if (!(value instanceof ArrayBuffer)) throw new Error("Expected an ArrayBuffer upload");
      stored.set(key, new Uint8Array(value.slice(0)));
    });
    const remove = vi.fn(async (key: string) => {
      deletedKeys.push(key);
      stored.delete(key);
    });
    const head = vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? r2Object(bytes) : null;
    });
    const env = {
      AUTH_MODE: "disabled",
      DB: d1 as unknown as D1Database,
      ASSETS: {
        put,
        delete: remove,
        head,
        get: vi.fn(async () => null),
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;
    const manifest = {
      schemaVersion: 2,
      title: "Race-safe imported process",
      source: {
        fileName: "race.xlsx",
        fileSha256: workbookSha,
        sheetName: "Process",
      },
      initialSubstrateStep: null,
      steps: [{
        localId: "step-1",
        sourceRow: 2,
        position: 0,
        stepNumber: "1",
        sectionName: null,
        name: "Lithography",
        toolName: null,
        parametersText: null,
        commentsText: null,
        imageIds: [],
        rawCells: {},
      }],
      images: [],
      initialStateImageIds: [],
      warnings: [],
    };
    const form = new FormData();
    form.set("workbook", new File([workbookBytes], "race.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    form.set("manifest", new File([JSON.stringify(manifest)], "manifest.json", {
      type: "application/json",
    }));

    const response = await worker.fetch(new Request(
      "https://app.test/api/imports/fabublox",
      { method: "POST", body: form },
    ), env, executionContext);
    expect(response.status).toBe(201);
    expect(injected).toBe(true);
    const result = await response.json<{ id: string; templateVersionId: string }>();
    expect(database.prepare(`
      SELECT status, workbook_asset_key, template_version_id
      FROM imports WHERE id = ?
    `).get(result.id)).toEqual({
      status: "ready",
      workbook_asset_key: winnerKey,
      template_version_id: result.templateVersionId,
    });
    expect(database.prepare(`
      SELECT source_asset_key FROM template_versions WHERE id = ?
    `).get(result.templateVersionId)).toEqual({ source_asset_key: winnerKey });
    expect(database.prepare(`
      SELECT status, import_id FROM assets WHERE id = 'fabublox-race-winner'
    `).get()).toEqual({ status: "ready", import_id: null });
    expect(deletedKeys.some((key) => key.includes("/source/race.xlsx"))).toBe(false);
    expect(deletedKeys).not.toContain(winnerKey);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM imports WHERE status = 'failed'
    `).get()).toEqual({ count: 0 });
    database.close();
  });

  it("recovers a committed finalization after its D1 response is lost", async () => {
    const database = referenceTestDatabase();
    const workbookBytes = Uint8Array.from([80, 75, 3, 4, 41, 42, 43, 44]);
    const workbookBuffer = workbookBytes.buffer.slice(
      workbookBytes.byteOffset,
      workbookBytes.byteOffset + workbookBytes.byteLength,
    ) as ArrayBuffer;
    const workbookSha = await sha256Hex(workbookBuffer);
    const stored = new Map<string, Uint8Array>();
    const deletedKeys: string[] = [];
    let finalizationCommittedResolve!: () => void;
    const finalizationCommitted = new Promise<void>((resolve) => {
      finalizationCommittedResolve = resolve;
    });
    let releaseLostResponse!: () => void;
    const lostResponseRelease = new Promise<void>((resolve) => {
      releaseLostResponse = resolve;
    });
    let injected = false;
    const d1 = new HookedD1Database(
      database,
      undefined,
      undefined,
      async (statements) => {
        if (injected || !statements.some((statement) =>
          statement.sql.includes("SET status = 'ready'")
          && statement.sql.includes('finalization_id'))) return;
        injected = true;
        finalizationCommittedResolve();
        await lostResponseRelease;
        throw new Error('injected D1 response loss after committed finalization');
      },
    );
    const put = vi.fn(async (key: string, value: unknown) => {
      if (!(value instanceof ArrayBuffer)) throw new Error('Expected an ArrayBuffer upload');
      stored.set(key, new Uint8Array(value.slice(0)));
    });
    const remove = vi.fn(async (key: string) => {
      deletedKeys.push(key);
      stored.delete(key);
    });
    const head = vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? r2Object(bytes) : null;
    });
    const get = vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? r2Object(bytes, 'image/png') : null;
    });
    const env = {
      AUTH_MODE: 'disabled',
      DB: d1 as unknown as D1Database,
      ASSETS: {
        put,
        delete: remove,
        head,
        get,
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;
    const manifest = {
      schemaVersion: 2,
      title: 'Committed finalization recovery',
      source: {
        fileName: 'committed.xlsx',
        fileSha256: workbookSha,
        sheetName: 'Process',
      },
      initialSubstrateStep: null,
      steps: [{
        localId: 'step-1',
        sourceRow: 2,
        position: 0,
        stepNumber: '1',
        sectionName: null,
        name: 'Growth',
        toolName: null,
        parametersText: null,
        commentsText: null,
        imageIds: [],
        rawCells: {},
      }],
      images: [],
      initialStateImageIds: [],
      warnings: [],
    };
    const form = new FormData();
    form.set('workbook', new File([workbookBytes], 'committed.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    form.set('manifest', new File([JSON.stringify(manifest)], 'manifest.json', {
      type: 'application/json',
    }));

    const importResponsePromise = worker.fetch(new Request(
      'https://app.test/api/imports/fabublox',
      { method: 'POST', body: form },
    ), env, executionContext);
    await finalizationCommitted;

    const published = database.prepare(`
      SELECT a.id, a.r2_key
      FROM assets a
      JOIN imports i ON i.id = a.import_id
      WHERE i.status = 'ready' AND a.status = 'ready' AND a.sha256 = ?
    `).get(workbookSha) as { id: string; r2_key: string };
    const concurrent = await worker.fetch(new Request(
      'https://app.test/api/assets',
      {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-filename': 'concurrent.png',
        },
        body: workbookBytes,
      },
    ), env, executionContext);
    expect(concurrent.status).toBe(200);
    expect(await concurrent.json()).toEqual({
      id: published.id,
      key: published.r2_key,
      deduplicated: true,
    });
    expect((await worker.fetch(new Request(
      `https://app.test/api/assets/${published.r2_key}`,
    ), env, executionContext)).status).toBe(200);

    releaseLostResponse();
    const recovered = await importResponsePromise;
    expect(recovered.status).toBe(201);
    expect(deletedKeys).not.toContain(published.r2_key);
    expect(database.prepare(`
      SELECT status, finalization_id IS NOT NULL AS finalized
      FROM imports WHERE id = (SELECT import_id FROM assets WHERE id = ?)
    `).get(published.id)).toEqual({ status: 'ready', finalized: 1 });
    expect((await worker.fetch(new Request(
      `https://app.test/api/assets/${published.r2_key}`,
    ), env, executionContext)).status).toBe(200);
    database.close();
  });

  it("does not publish a pending import asset before a later metadata failure", async () => {
    const database = referenceTestDatabase();
    const workbookBytes = Uint8Array.from([80, 75, 3, 4, 91, 92, 93, 94]);
    const workbookBuffer = workbookBytes.buffer.slice(
      workbookBytes.byteOffset,
      workbookBytes.byteOffset + workbookBytes.byteLength,
    ) as ArrayBuffer;
    const workbookSha = await sha256Hex(workbookBuffer);
    const stored = new Map<string, Uint8Array>();
    const deletedKeys: string[] = [];
    let metadataReachedResolve!: () => void;
    const metadataReached = new Promise<void>((resolve) => {
      metadataReachedResolve = resolve;
    });
    let releaseMetadata!: () => void;
    const metadataRelease = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    let blocked = false;
    const d1 = new HookedD1Database(database, undefined, async (statements) => {
      if (blocked || !statements.some((statement) =>
        statement.sql.includes('UPDATE imports SET template_version_id'))) return;
      blocked = true;
      metadataReachedResolve();
      await metadataRelease;
      throw new Error('injected FabuBlox metadata failure');
    });
    const put = vi.fn(async (key: string, value: unknown) => {
      if (!(value instanceof ArrayBuffer)) throw new Error('Expected an ArrayBuffer upload');
      stored.set(key, new Uint8Array(value.slice(0)));
    });
    const remove = vi.fn(async (key: string) => {
      deletedKeys.push(key);
      stored.delete(key);
    });
    const head = vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? r2Object(bytes) : null;
    });
    const get = vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? r2Object(bytes) : null;
    });
    const env = {
      AUTH_MODE: 'disabled',
      DB: d1 as unknown as D1Database,
      ASSETS: {
        put,
        delete: remove,
        head,
        get,
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;
    const manifest = {
      schemaVersion: 2,
      title: 'Pending import isolation',
      source: {
        fileName: 'pending.xlsx',
        fileSha256: workbookSha,
        sheetName: 'Process',
      },
      initialSubstrateStep: null,
      steps: [{
        localId: 'step-1',
        sourceRow: 2,
        position: 0,
        stepNumber: '1',
        sectionName: null,
        name: 'Etch',
        toolName: null,
        parametersText: null,
        commentsText: null,
        imageIds: [],
        rawCells: {},
      }],
      images: [],
      initialStateImageIds: [],
      warnings: [],
    };
    const form = new FormData();
    form.set('workbook', new File([workbookBytes], 'pending.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    form.set('manifest', new File([JSON.stringify(manifest)], 'manifest.json', {
      type: 'application/json',
    }));

    const importResponsePromise = worker.fetch(new Request(
      'https://app.test/api/imports/fabublox',
      { method: 'POST', body: form },
    ), env, executionContext);
    await metadataReached;
    const pendingImport = database.prepare(`
      SELECT id FROM imports WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };
    const pendingAsset = database.prepare(`
      SELECT id, r2_key FROM assets
      WHERE import_id = ? AND sha256 = ? AND status = 'pending'
    `).get(pendingImport.id, workbookSha) as { id: string; r2_key: string };

    const liveBeforeFailure = await worker.fetch(new Request(
      `https://app.test/api/assets/${pendingAsset.r2_key}`,
    ), env, executionContext);
    expect(liveBeforeFailure.status).toBe(404);
    expect(get).not.toHaveBeenCalled();

    const putCountBeforeConcurrent = put.mock.calls.length;
    const concurrent = await worker.fetch(new Request(
      'https://app.test/api/assets',
      {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-filename': 'concurrent.png',
        },
        body: workbookBytes,
      },
    ), env, executionContext);
    expect(concurrent.status).toBe(503);
    expect(await concurrent.json()).toMatchObject({
      error: expect.stringContaining('pending FabuBlox import'),
    });
    expect(put).toHaveBeenCalledTimes(putCountBeforeConcurrent);

    releaseMetadata();
    const failedImport = await importResponsePromise;
    expect(failedImport.status).toBe(500);
    expect(database.prepare(`
      SELECT status FROM imports WHERE id = ?
    `).get(pendingImport.id)).toEqual({ status: 'failed' });
    expect(database.prepare(`
      SELECT status, sha256 FROM assets WHERE id = ?
    `).get(pendingAsset.id)).toEqual({ status: 'failed', sha256: null });
    expect(deletedKeys).not.toContain(pendingAsset.r2_key);
    expect(stored.has(pendingAsset.r2_key)).toBe(true);
    expect(database.prepare(`
      SELECT state FROM blob_gc_ledger
      WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ?
    `).get(pendingAsset.r2_key)).toEqual({ state: 'orphaned' });

    const liveAfterFailure = await worker.fetch(new Request(
      `https://app.test/api/assets/${pendingAsset.r2_key}`,
    ), env, executionContext);
    expect(liveAfterFailure.status).toBe(404);
    database.close();
  });

  it("keeps staged revisions private and rebuilds image relationships after finalization failure and retry", async () => {
    const database = referenceTestDatabase();
    const workbookBytes = Uint8Array.from([80, 75, 3, 4, 140, 141, 142, 143]);
    const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 44, 45, 46]);
    const workbookBuffer = workbookBytes.buffer.slice(
      workbookBytes.byteOffset,
      workbookBytes.byteOffset + workbookBytes.byteLength,
    ) as ArrayBuffer;
    const imageBuffer = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    ) as ArrayBuffer;
    const workbookSha = await sha256Hex(workbookBuffer);
    const imageSha = await sha256Hex(imageBuffer);
    const title = "Atomic publication retry regression";
    const stored = new Map<string, Uint8Array>();
    const deletedKeys: string[] = [];

    let finalizationReachedResolve!: () => void;
    const finalizationReached = new Promise<void>((resolve) => {
      finalizationReachedResolve = resolve;
    });
    let releaseFinalization!: () => void;
    const finalizationRelease = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    let failFinalization = true;
    const d1 = new HookedD1Database(database, undefined, async (statements) => {
      if (!failFinalization || !statements.some((statement) =>
        statement.sql.includes("SET status = 'ready'")
        && statement.sql.includes("finalization_id"))) return;
      failFinalization = false;
      finalizationReachedResolve();
      await finalizationRelease;
      throw new Error("injected FabuBlox finalization failure before commit");
    });

    const put = vi.fn(async (key: string, value: unknown) => {
      if (!(value instanceof ArrayBuffer)) throw new Error("Expected an ArrayBuffer upload");
      stored.set(key, new Uint8Array(value.slice(0)));
    });
    const remove = vi.fn(async (key: string) => {
      deletedKeys.push(key);
      stored.delete(key);
    });
    const head = vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? r2Object(bytes) : null;
    });
    const get = vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? r2Object(bytes, key.endsWith(".png") ? "image/png" : "application/octet-stream") : null;
    });
    const env = {
      AUTH_MODE: "disabled",
      DB: d1 as unknown as D1Database,
      ASSETS: {
        put,
        delete: remove,
        head,
        get,
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;

    const manifest = {
      schemaVersion: 2,
      title,
      source: {
        fileName: "atomic-publication.xlsx",
        fileSha256: workbookSha,
        sheetName: "Process",
      },
      initialSubstrateStep: null,
      steps: [{
        localId: "step-1",
        sourceRow: 2,
        position: 0,
        stepNumber: "1",
        sectionName: null,
        name: "Image-bearing growth",
        toolName: null,
        parametersText: null,
        commentsText: null,
        imageIds: ["image-1"],
        rawCells: {},
      }],
      images: [{
        localId: "image-1",
        sourcePart: "xl/media/image1.png",
        mimeType: "image/png",
        assignedStepLocalId: "step-1",
        anchor: {},
      }],
      initialStateImageIds: [],
      warnings: [],
    };
    const importForm = () => {
      const form = new FormData();
      form.set("workbook", new File([workbookBytes], "atomic-publication.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }));
      form.set("manifest", new File([JSON.stringify(manifest)], "manifest.json", {
        type: "application/json",
      }));
      form.set("image:image-1", new File([imageBytes], "state.png", { type: "image/png" }));
      return form;
    };

    const firstImportPromise = worker.fetch(new Request(
      "https://app.test/api/imports/fabublox",
      { method: "POST", body: importForm() },
    ), env, executionContext);
    await finalizationReached;

    const pending = database.prepare(`
      SELECT id, template_version_id
      FROM imports
      WHERE status = 'pending' AND template_version_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; template_version_id: string };
    const pendingTemplate = database.prepare(`
      SELECT tv.id, ts.expected_state_hash
      FROM template_versions tv
      JOIN template_steps ts ON ts.template_version_id = tv.id
      WHERE tv.id = ?
    `).get(pending.template_version_id) as { id: string; expected_state_hash: string };
    const pendingImage = database.prepare(`
      SELECT id, r2_key
      FROM assets
      WHERE import_id = ? AND sha256 = ? AND status = 'pending'
    `).get(pending.id, imageSha) as { id: string; r2_key: string };

    const pendingSearch = await worker.fetch(new Request(
      "https://app.test/api/references/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: title, types: ["recipe_revision"] }),
      },
    ), env, executionContext);
    expect(pendingSearch.status).toBe(200);
    expect((await pendingSearch.json() as {
      results: Array<{ target: { id: string } }>;
    }).results.some((result) => result.target.id === pending.template_version_id)).toBe(false);

    const pendingResolve = await worker.fetch(new Request(
      "https://app.test/api/references/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: [{ type: "recipe_revision", id: pending.template_version_id }] }),
      },
    ), env, executionContext);
    expect(pendingResolve.status).toBe(200);
    expect((await pendingResolve.json() as {
      results: Array<{ resolution: string }>;
    }).results[0]?.resolution).not.toBe("resolved");

    expect((await worker.fetch(new Request(
      `https://app.test/api/templates/${pending.template_version_id}`,
    ), env, executionContext)).status).toBe(404);
    expect((await worker.fetch(new Request(
      `https://app.test/api/templates/${pending.template_version_id}/clone`,
      { method: "POST" },
    ), env, executionContext)).status).toBe(404);
    expect((await worker.fetch(new Request(
      `https://app.test/api/templates/${pending.template_version_id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `${title} changed`, version: 1 }),
      },
    ), env, executionContext)).status).toBe(404);

    expect(() => database.prepare(`
      UPDATE template_versions SET name = name WHERE id = ?
    `).run(pending.template_version_id)).toThrow("template version is not published");
    expect(() => database.prepare(`
      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES (?, ?, 0)
    `).run(pendingTemplate.expected_state_hash, pendingImage.id))
      .toThrow("asset owning import is not ready");

    releaseFinalization();
    const firstImport = await firstImportPromise;
    expect(firstImport.status).toBe(500);

    expect(database.prepare(`
      SELECT status, template_version_id FROM imports WHERE id = ?
    `).get(pending.id)).toEqual({
      status: "failed",
      template_version_id: pending.template_version_id,
    });
    expect(database.prepare(`
      SELECT archived_at IS NOT NULL AS archived,
             deleted_at IS NOT NULL AS deleted,
             source_asset_key, initial_state_hash
      FROM template_versions WHERE id = ?
    `).get(pending.template_version_id)).toEqual({
      archived: 1,
      deleted: 1,
      source_asset_key: null,
      initial_state_hash: null,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM template_steps WHERE template_version_id = ?
    `).get(pending.template_version_id)).toEqual({ count: 0 });

    const failedAssets = database.prepare(`
      SELECT id, r2_key, status, sha256
      FROM assets WHERE import_id = ? ORDER BY r2_key
    `).all(pending.id) as Array<{
      id: string; r2_key: string; status: string; sha256: string | null;
    }>;
    expect(failedAssets).toHaveLength(3);
    expect(failedAssets.every((asset) => asset.status === "failed" && asset.sha256 === null)).toBe(true);
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM state_representation_assets
      WHERE asset_id IN (SELECT id FROM assets WHERE import_id = ?)
    `).get(pending.id)).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
      WHERE store_kind = 'r2' AND provider = 'r2'
        AND object_key IN (SELECT r2_key FROM assets WHERE import_id = ?)
    `).get(pending.id)).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_gc_ledger
      WHERE store_kind = 'r2' AND provider = 'r2'
        AND object_key IN (SELECT r2_key FROM assets WHERE import_id = ?)
        AND state = 'orphaned'
    `).get(pending.id)).toEqual({ count: 3 });
    expect(failedAssets.every((asset) => stored.has(asset.r2_key))).toBe(true);

    const retry = await worker.fetch(new Request(
      "https://app.test/api/imports/fabublox",
      { method: "POST", body: importForm() },
    ), env, executionContext);
    expect(retry.status).toBe(201);
    const retried = await retry.json() as { id: string; templateVersionId: string; version: number };

    const detail = await worker.fetch(new Request(
      `https://app.test/api/templates/${retried.templateVersionId}`,
    ), env, executionContext);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      template: { steps: Array<{ imageKeys: string[] }> };
    };
    expect(detailBody.template.steps[0]?.imageKeys).toHaveLength(1);
    const readyImageKey = detailBody.template.steps[0]!.imageKeys[0]!;
    expect(stored.has(readyImageKey)).toBe(true);

    const readyRelationship = database.prepare(`
      SELECT a.id AS asset_id, a.r2_key, ts.expected_state_hash
      FROM template_steps ts
      JOIN state_representation_assets sra ON sra.state_hash = ts.expected_state_hash
      JOIN assets a ON a.id = sra.asset_id
      JOIN imports i ON i.id = a.import_id
      WHERE ts.template_version_id = ? AND a.sha256 = ?
        AND a.status = 'ready' AND i.status = 'ready'
    `).get(retried.templateVersionId, imageSha) as {
      asset_id: string; r2_key: string; expected_state_hash: string;
    };
    expect(readyRelationship.r2_key).toBe(readyImageKey);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_retention_edges
      WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ?
    `).get(readyImageKey)).toEqual({ count: 1 });

    const readySearch = await worker.fetch(new Request(
      "https://app.test/api/references/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: title, types: ["recipe_revision"] }),
      },
    ), env, executionContext);
    expect(readySearch.status).toBe(200);
    expect((await readySearch.json() as {
      results: Array<{ target: { id: string }; resolution: { resolution: string } }>;
    }).results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: { type: "recipe_revision", id: retried.templateVersionId },
        resolution: expect.objectContaining({ resolution: "resolved" }),
      }),
    ]));

    const future = new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000);
    const gc = await runBlobGarbageCollection(env, future);
    expect(gc.failures).toBe(0);
    for (const asset of failedAssets) {
      expect(deletedKeys).toContain(asset.r2_key);
      expect(stored.has(asset.r2_key)).toBe(false);
      expect(database.prepare(`
        SELECT state FROM blob_gc_ledger
        WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ?
      `).get(asset.r2_key)).toEqual({ state: "deleted" });
    }
    expect(deletedKeys).not.toContain(readyImageKey);
    expect(stored.has(readyImageKey)).toBe(true);
    expect((await worker.fetch(new Request(
      `https://app.test/api/templates/${retried.templateVersionId}`,
    ), env, executionContext)).status).toBe(200);
    database.close();
  });

});

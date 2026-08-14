import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
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
    private readonly sql: string,
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
  ) {}

  prepare(sql: string) {
    return new HookedD1Statement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as unknown as HookedD1Statement).execute());
      this.database.exec("COMMIT");
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
    expect(deletedKeys.some((key) => key.includes("/source/race.xlsx"))).toBe(true);
    expect(deletedKeys).not.toContain(winnerKey);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM imports WHERE status = 'failed'
    `).get()).toEqual({ count: 0 });
    database.close();
  });
});

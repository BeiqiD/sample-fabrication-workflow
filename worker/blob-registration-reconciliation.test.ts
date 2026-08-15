import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
} from "./reference-test-support";
import type { Env } from "./types";

class FaultD1Statement {
  constructor(
    private readonly owner: FaultD1Database,
    readonly query: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new FaultD1Statement(this.owner, this.query, bindings);
  }

  private statement(): StatementSync {
    return this.owner.database.prepare(this.query);
  }

  async first<T>() {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement().all(...this.bindings) as T[],
      meta: {},
    };
  }

  async run() {
    const result = this.statement().run(...this.bindings);
    const response = {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
    this.owner.afterMutation(this.query);
    return response;
  }

  execute() {
    if (/^\s*SELECT\b/i.test(this.query)) {
      return {
        success: true,
        results: this.statement().all(...this.bindings),
        meta: { changes: 0 },
      };
    }
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

class FaultD1Database {
  private injected = false;

  constructor(
    readonly database: DatabaseSync,
    private readonly insertTarget: "assets" | "managed_storage_objects",
  ) {}

  prepare(query: string) {
    return new FaultD1Statement(this, query);
  }

  withSession() {
    return this;
  }

  afterMutation(query: string) {
    if (this.injected) return;
    const pattern = this.insertTarget === "assets"
      ? /INSERT\s+INTO\s+assets\s*\(/i
      : /INSERT\s+INTO\s+managed_storage_objects\s*\(/i;
    if (!pattern.test(query)) return;
    this.injected = true;
    throw new Error(`injected committed ${this.insertTarget} response loss`);
  }

  async batch(statements: FaultD1Statement[]) {
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

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function databaseWithUpload(
  kind: "comment_image" | "attachment",
  byteSize: number,
) {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
  database.exec(`
    INSERT INTO samples (id, code, title, status, created_at, updated_at)
    VALUES (
      'sample-upload', 'UPLOAD-1', 'Upload sample', 'stored',
      '2026-08-15T10:00:00.000Z', '2026-08-15T10:00:00.000Z'
    );

    INSERT INTO comment_submissions (
      id, context_kind, sample_id, scope, body, status, actor_email,
      created_at, updated_at, retry_until
    ) VALUES (
      'submission-upload', 'sample', 'sample-upload', NULL, '', 'uploading',
      'local-development', '2026-08-15T10:01:00.000Z',
      '2026-08-15T10:01:00.000Z', '2026-08-16T10:01:00.000Z'
    );

    INSERT INTO comment_submission_items (
      id, submission_id, kind, status, position, filename, mime_type,
      byte_size, created_at, updated_at
    ) VALUES (
      'item-upload', 'submission-upload', '${kind}', 'pending', 0,
      '${kind === "comment_image" ? "image.png" : "result.dat"}',
      '${kind === "comment_image" ? "image/png" : "application/octet-stream"}',
      ${byteSize}, '2026-08-15T10:01:00.000Z', '2026-08-15T10:01:00.000Z'
    );
  `);
  return database;
}

function bytesBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function r2Object(bytes: Uint8Array, contentType: string) {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: bytes.byteLength,
    httpEtag: '"registration-test"',
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", contentType);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uncertain blob registration reconciliation", () => {
  it("keeps a committed Comment image and does not delete its own R2 key after response loss", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 31, 32, 33]);
    const database = databaseWithUpload("comment_image", bytes.byteLength);
    const stored = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    const put = vi.fn(async (key: string, value: unknown) => {
      if (!(value instanceof ArrayBuffer)) throw new Error("Expected an ArrayBuffer");
      stored.set(key, new Uint8Array(value.slice(0)));
    });
    const remove = vi.fn(async (key: string) => {
      deleted.push(key);
      stored.delete(key);
    });
    const env = {
      AUTH_MODE: "disabled",
      DB: new FaultD1Database(database, "assets") as unknown as D1Database,
      ASSETS: {
        put,
        delete: remove,
        head: vi.fn(async (key: string) => {
          const value = stored.get(key);
          return value ? r2Object(value, "image/png") : null;
        }),
        get: vi.fn(async (key: string) => {
          const value = stored.get(key);
          return value ? r2Object(value, "image/png") : null;
        }),
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;

    const response = await worker.fetch(new Request(
      "https://app.test/api/comment-submissions/submission-upload/items/item-upload/content",
      {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-upload-size": String(bytes.byteLength),
        },
        body: bytes,
      },
    ), env, executionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deduplicated: false });

    const row = database.prepare(`
      SELECT a.id, a.r2_key, a.status, csi.status AS item_status,
             csi.asset_id
      FROM comment_submission_items csi
      JOIN assets a ON a.id = csi.asset_id
      WHERE csi.id = 'item-upload'
    `).get() as {
      id: string;
      r2_key: string;
      status: string;
      item_status: string;
      asset_id: string;
    };
    expect(row).toEqual({
      id: row.id,
      r2_key: row.r2_key,
      status: "ready",
      item_status: "ready",
      asset_id: row.id,
    });
    expect(deleted).not.toContain(row.r2_key);
    expect(stored.get(row.r2_key)).toEqual(bytes);

    const live = await worker.fetch(new Request(
      `https://app.test/api/assets/${row.r2_key}`,
    ), env, executionContext);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(bytes);
    database.close();
  });

  it("keeps a committed managed Comment attachment and does not delete its own provider key after response loss", async () => {
    const bytes = Uint8Array.from([41, 42, 43, 44, 45]);
    const sha256 = await sha256Hex(bytesBuffer(bytes));
    const database = databaseWithUpload("attachment", bytes.byteLength);
    const stored = new Map<string, Uint8Array>();
    const deletedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (method === "MKCOL") return new Response(null, { status: 201 });
      if (method === "PUT") {
        const body = await new Response(init?.body as BodyInit).arrayBuffer();
        stored.set(url, new Uint8Array(body));
        return new Response(null, { status: 201 });
      }
      if (method === "HEAD") {
        const value = stored.get(url);
        if (!value) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(value.byteLength),
            "content-type": "application/octet-stream",
            etag: '"managed-registration-test"',
          },
        });
      }
      if (method === "GET") {
        const value = stored.get(url);
        if (!value) return new Response(null, { status: 404 });
        return new Response(value, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            etag: '"managed-registration-test"',
          },
        });
      }
      if (method === "DELETE") {
        deletedUrls.push(url);
        stored.delete(url);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected SWITCHdrive method ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      AUTH_MODE: "disabled",
      DB: new FaultD1Database(
        database,
        "managed_storage_objects",
      ) as unknown as D1Database,
      ASSETS: {} as R2Bucket,
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL:
        "https://drive.switch.ch/remote.php/dav/files/test-user/",
      SWITCHDRIVE_USERNAME: "test-user",
      SWITCHDRIVE_APP_PASSWORD: "test-password",
    } satisfies Env;

    const response = await worker.fetch(new Request(
      "https://app.test/api/comment-submissions/submission-upload/items/item-upload/content",
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-upload-size": String(bytes.byteLength),
          "x-content-sha256": sha256,
        },
        body: bytes,
      },
    ), env, executionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deduplicated: false });

    const row = database.prepare(`
      SELECT mso.id, mso.object_key, mso.status,
             csi.status AS item_status, csi.storage_object_id
      FROM comment_submission_items csi
      JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
      WHERE csi.id = 'item-upload'
    `).get() as {
      id: string;
      object_key: string;
      status: string;
      item_status: string;
      storage_object_id: string;
    };
    expect(row).toEqual({
      id: row.id,
      object_key: row.object_key,
      status: "ready",
      item_status: "ready",
      storage_object_id: row.id,
    });
    expect(deletedUrls).toEqual([]);
    const objectUrl = [
      "https://drive.switch.ch/remote.php/dav/files/test-user",
      "sample-fabrication-workflow",
      ...row.object_key.split("/").map(encodeURIComponent),
    ].join("/");
    expect(stored.get(objectUrl)).toEqual(bytes);

    const live = await worker.fetch(new Request(
      "https://app.test/api/exports/attachments/item-upload",
    ), env, executionContext);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(bytes);
    database.close();
  });

  it("keeps a committed metrology reference asset after its INSERT response is lost", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 61, 62, 63, 64]);
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    const stored = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    const env = {
      AUTH_MODE: "disabled",
      DB: new FaultD1Database(database, "assets") as unknown as D1Database,
      ASSETS: {
        put: vi.fn(async (key: string, value: unknown) => {
          if (!(value instanceof ArrayBuffer)) throw new Error("Expected an ArrayBuffer");
          stored.set(key, new Uint8Array(value.slice(0)));
        }),
        delete: vi.fn(async (key: string) => {
          deleted.push(key);
          stored.delete(key);
        }),
        head: vi.fn(async (key: string) => {
          const value = stored.get(key);
          return value ? r2Object(value, "image/png") : null;
        }),
        get: vi.fn(async (key: string) => {
          const value = stored.get(key);
          return value ? r2Object(value, "image/png") : null;
        }),
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;

    const response = await worker.fetch(new Request(
      `https://app.test/api/metrology-templates/${REFERENCE_FIXTURE_IDS.metrologyRevision}/references`,
      {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-filename": "response-loss.png",
        },
        body: bytes,
      },
    ), env, executionContext);
    expect(response.status).toBe(201);
    const body = await response.json() as {
      reference: { id: string; assetKey: string };
    };
    const row = database.prepare(`
      SELECT mtr.id, a.id AS asset_id, a.r2_key, a.status
      FROM metrology_template_references mtr
      JOIN assets a ON a.id = mtr.asset_id
      WHERE mtr.id = ?
    `).get(body.reference.id) as {
      id: string;
      asset_id: string;
      r2_key: string;
      status: string;
    };
    expect(row).toEqual({
      id: body.reference.id,
      asset_id: row.asset_id,
      r2_key: body.reference.assetKey,
      status: "ready",
    });
    expect(deleted).not.toContain(row.r2_key);
    expect(stored.get(row.r2_key)).toEqual(bytes);
    const live = await worker.fetch(new Request(
      `https://app.test/api/assets/${row.r2_key}`,
    ), env, executionContext);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(bytes);
    database.close();
  });

  it("keeps a committed Project upload after its INSERT response is lost", async () => {
    const bytes = Uint8Array.from([80, 68, 70, 71, 72, 73]);
    const database = referenceTestDatabase();
    const stored = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    const env = {
      AUTH_MODE: "disabled",
      DB: new FaultD1Database(database, "assets") as unknown as D1Database,
      ASSETS: {
        put: vi.fn(async (key: string, value: unknown) => {
          if (!(value instanceof ArrayBuffer)) throw new Error("Expected an ArrayBuffer");
          stored.set(key, new Uint8Array(value.slice(0)));
        }),
        delete: vi.fn(async (key: string) => {
          deleted.push(key);
          stored.delete(key);
        }),
        head: vi.fn(async (key: string) => {
          const value = stored.get(key);
          return value ? r2Object(value, "application/pdf") : null;
        }),
        get: vi.fn(async (key: string) => {
          const value = stored.get(key);
          return value ? r2Object(value, "application/pdf") : null;
        }),
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;

    const response = await worker.fetch(new Request(
      "https://app.test/api/project-assets",
      {
        method: "POST",
        headers: {
          "content-type": "application/pdf",
          "x-project-filename-uri": encodeURIComponent("response-loss.pdf"),
        },
        body: bytes,
      },
    ), env, executionContext);
    expect(response.status).toBe(201);
    const body = await response.json() as {
      id: string;
      key: string;
      deduplicated: boolean;
    };
    expect(body.deduplicated).toBe(false);
    expect(deleted).not.toContain(body.key);
    expect(stored.get(body.key)).toEqual(bytes);
    expect(database.prepare(`
      SELECT id, r2_key, status FROM assets WHERE id = ?
    `).get(body.id)).toEqual({
      id: body.id,
      r2_key: body.key,
      status: "ready",
    });
    database.close();
  });

});

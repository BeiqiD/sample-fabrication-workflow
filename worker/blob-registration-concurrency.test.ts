import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    httpEtag: '"concurrency-test"',
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", contentType);
    },
  };
}

function uploadRequest(bytes: Uint8Array, kind: "comment_image" | "attachment", sha256?: string) {
  const headers: Record<string, string> = {
    "content-type": kind === "comment_image"
      ? "image/png"
      : "application/octet-stream",
    "x-upload-size": String(bytes.byteLength),
  };
  if (sha256) headers["x-content-sha256"] = sha256;
  return new Request(
    "https://app.test/api/comment-submissions/submission-upload/items/item-upload/content",
    {
      method: "PUT",
      headers,
      body: bytes,
    },
  );
}

async function runConcurrentR2Uploads(
  firstBytes: Uint8Array,
  secondBytes: Uint8Array,
) {
  const database = databaseWithUpload("comment_image", firstBytes.byteLength);
  const stored = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const firstPutEntered = deferred();
  const releaseFirstPut = deferred();
  let putCount = 0;
  const env = {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {
      put: vi.fn(async (key: string, value: unknown) => {
        if (!(value instanceof ArrayBuffer)) {
          throw new Error("Expected an ArrayBuffer");
        }
        putCount += 1;
        if (putCount === 1) {
          firstPutEntered.resolve();
          await releaseFirstPut.promise;
        }
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

  const first = worker.fetch(
    uploadRequest(firstBytes, "comment_image"),
    env,
    executionContext,
  );
  await firstPutEntered.promise;
  const second = await worker.fetch(
    uploadRequest(secondBytes, "comment_image"),
    env,
    executionContext,
  );
  releaseFirstPut.resolve();
  const firstResponse = await first;
  return { database, stored, deleted, firstResponse, second };
}

async function runConcurrentManagedUploads(
  firstBytes: Uint8Array,
  secondBytes: Uint8Array,
) {
  const database = databaseWithUpload("attachment", firstBytes.byteLength);
  const firstSha = await sha256Hex(bytesBuffer(firstBytes));
  const secondSha = await sha256Hex(bytesBuffer(secondBytes));
  const stored = new Map<string, Uint8Array>();
  const deletedUrls: string[] = [];
  const firstPutEntered = deferred();
  const releaseFirstPut = deferred();
  let putCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (method === "MKCOL") return new Response(null, { status: 201 });
    if (method === "PUT") {
      putCount += 1;
      if (putCount === 1) {
        firstPutEntered.resolve();
        await releaseFirstPut.promise;
      }
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
          etag: '"managed-concurrency-test"',
        },
      });
    }
    if (method === "GET") {
      const value = stored.get(url);
      return value
        ? new Response(value, {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              etag: '"managed-concurrency-test"',
            },
          })
        : new Response(null, { status: 404 });
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
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {} as R2Bucket,
    MANAGED_STORAGE_PROVIDER: "switchdrive",
    SWITCHDRIVE_WEBDAV_URL:
      "https://drive.switch.ch/remote.php/dav/files/test-user/",
    SWITCHDRIVE_USERNAME: "test-user",
    SWITCHDRIVE_APP_PASSWORD: "test-password",
  } satisfies Env;

  const first = worker.fetch(
    uploadRequest(firstBytes, "attachment", firstSha),
    env,
    executionContext,
  );
  await firstPutEntered.promise;
  const second = await worker.fetch(
    uploadRequest(secondBytes, "attachment", secondSha),
    env,
    executionContext,
  );
  releaseFirstPut.resolve();
  const firstResponse = await first;
  return {
    database,
    stored,
    deletedUrls,
    firstResponse,
    second,
    firstSha,
    secondSha,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("concurrent Comment provider registration", () => {
  it("keeps the canonical R2 bytes when same-SHA uploads race for one item", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);
    const result = await runConcurrentR2Uploads(bytes, bytes);
    expect(result.firstResponse.status).toBe(200);
    expect(result.second.status).toBe(200);
    expect(result.deleted).toEqual([]);

    const rows = result.database.prepare(`
      SELECT id, r2_key, status, sha256
      FROM assets
      ORDER BY id
    `).all() as Array<{
      id: string;
      r2_key: string;
      status: string;
      sha256: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.r2_key)).size).toBe(2);
    expect(rows.map((row) => row.status).sort()).toEqual(["failed", "ready"]);
    expect(result.stored.size).toBe(2);

    const winner = result.database.prepare(`
      SELECT a.r2_key, a.status
      FROM comment_submission_items csi
      JOIN assets a ON a.id = csi.asset_id
      WHERE csi.id = 'item-upload'
    `).get() as { r2_key: string; status: string };
    expect(winner.status).toBe("ready");
    expect(result.stored.get(winner.r2_key)).toEqual(bytes);
    result.database.close();
  });

  it("uses distinct R2 locators for different-SHA same-size uploads racing for one item", async () => {
    const firstBytes = Uint8Array.from([137, 80, 78, 71, 11, 12, 13, 14]);
    const secondBytes = Uint8Array.from([137, 80, 78, 71, 21, 22, 23, 24]);
    const result = await runConcurrentR2Uploads(firstBytes, secondBytes);
    expect(result.firstResponse.status).toBe(200);
    expect(result.second.status).toBe(200);
    expect(result.deleted).toEqual([]);

    const rows = result.database.prepare(`
      SELECT r2_key, status, sha256
      FROM assets
      ORDER BY id
    `).all() as Array<{
      r2_key: string;
      status: string;
      sha256: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "ready")).toBe(true);
    expect(new Set(rows.map((row) => row.r2_key)).size).toBe(2);
    expect(new Set(rows.map((row) => row.sha256)).size).toBe(2);
    expect([...result.stored.values()]).toEqual(
      expect.arrayContaining([firstBytes, secondBytes]),
    );

    const winner = result.database.prepare(`
      SELECT a.r2_key
      FROM comment_submission_items csi
      JOIN assets a ON a.id = csi.asset_id
      WHERE csi.id = 'item-upload'
    `).get() as { r2_key: string };
    expect(result.stored.has(winner.r2_key)).toBe(true);
    result.database.close();
  });

  it("keeps the canonical managed bytes when same-SHA uploads race for one item", async () => {
    const bytes = Uint8Array.from([41, 42, 43, 44, 45, 46]);
    const result = await runConcurrentManagedUploads(bytes, bytes);
    expect(result.firstResponse.status).toBe(200);
    expect(result.second.status).toBe(200);
    expect(result.deletedUrls).toEqual([]);

    const rows = result.database.prepare(`
      SELECT id, object_key, status, sha256
      FROM managed_storage_objects
      ORDER BY id
    `).all() as Array<{
      id: string;
      object_key: string;
      status: string;
      sha256: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.object_key)).size).toBe(2);
    expect(rows.map((row) => row.status).sort()).toEqual(["failed", "ready"]);
    expect(result.stored.size).toBe(2);

    const winner = result.database.prepare(`
      SELECT mso.object_key, mso.status
      FROM comment_submission_items csi
      JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
      WHERE csi.id = 'item-upload'
    `).get() as { object_key: string; status: string };
    expect(winner.status).toBe("ready");
    const winnerUrl = [
      "https://drive.switch.ch/remote.php/dav/files/test-user",
      "sample-fabrication-workflow",
      ...winner.object_key.split("/").map(encodeURIComponent),
    ].join("/");
    expect(result.stored.get(winnerUrl)).toEqual(bytes);
    result.database.close();
  });

  it("uses distinct managed locators for different-SHA same-size uploads racing for one item", async () => {
    const firstBytes = Uint8Array.from([51, 52, 53, 54, 55, 56]);
    const secondBytes = Uint8Array.from([61, 62, 63, 64, 65, 66]);
    const result = await runConcurrentManagedUploads(firstBytes, secondBytes);
    expect(result.firstResponse.status).toBe(200);
    expect(result.second.status).toBe(200);
    expect(result.deletedUrls).toEqual([]);

    const rows = result.database.prepare(`
      SELECT object_key, status, sha256
      FROM managed_storage_objects
      ORDER BY id
    `).all() as Array<{
      object_key: string;
      status: string;
      sha256: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "ready")).toBe(true);
    expect(new Set(rows.map((row) => row.object_key)).size).toBe(2);
    expect(new Set(rows.map((row) => row.sha256)).size).toBe(2);
    expect([...result.stored.values()]).toEqual(
      expect.arrayContaining([firstBytes, secondBytes]),
    );

    const winner = result.database.prepare(`
      SELECT mso.object_key
      FROM comment_submission_items csi
      JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
      WHERE csi.id = 'item-upload'
    `).get() as { object_key: string };
    const winnerUrl = [
      "https://drive.switch.ch/remote.php/dav/files/test-user",
      "sample-fabrication-workflow",
      ...winner.object_key.split("/").map(encodeURIComponent),
    ].join("/");
    expect(result.stored.has(winnerUrl)).toBe(true);
    result.database.close();
  });
});

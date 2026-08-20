import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
import {
  referenceTestDatabase,
  SqliteD1Database,
} from "./reference-test-support";
import type { Env } from "./types";

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function bytesBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function r2Object(bytes: Uint8Array, contentType = "image/png") {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: bytes.byteLength,
    httpEtag: '"attachment-ingestion"',
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", contentType);
    },
  };
}

function envFor(database: ReturnType<typeof referenceTestDatabase>) {
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: unknown) => {
    if (!(value instanceof ArrayBuffer)) throw new Error("Expected ArrayBuffer upload bytes");
    stored.set(key, new Uint8Array(value.slice(0)));
  });
  const head = vi.fn(async (key: string) => {
    const value = stored.get(key);
    return value ? r2Object(value) : null;
  });
  const env = {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {
      put,
      delete: vi.fn(async (key: string) => stored.delete(key)),
      head,
      get: vi.fn(async (key: string) => {
        const value = stored.get(key);
        return value ? r2Object(value) : null;
      }),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket,
  } satisfies Env;
  return { env, stored, put, head };
}

function request(env: Env, path: string, init?: RequestInit) {
  return worker.fetch(
    new Request(`https://app.test/api${path}`, init),
    env,
    executionContext,
  );
}

function seedCommentImageUpload(
  database: ReturnType<typeof referenceTestDatabase>,
  byteSize: number,
  filename = "shared-comment.png",
) {
  database.exec(`
    INSERT INTO samples (id, code, title, status, created_at, updated_at)
    VALUES ('ingestion-sample', 'INGEST-1', 'Ingestion sample', 'stored',
      '2026-08-19T10:00:00.000Z', '2026-08-19T10:00:00.000Z');
    INSERT INTO comment_submissions
      (id, context_kind, sample_id, body, status, actor_email,
       created_at, updated_at, retry_until)
    VALUES ('ingestion-submission', 'sample', 'ingestion-sample', '', 'uploading',
      'local-development', '2026-08-19T10:01:00.000Z', '2026-08-19T10:01:00.000Z',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'));
    INSERT INTO comment_submission_items
      (id, submission_id, kind, status, position, filename, mime_type,
       byte_size, created_at, updated_at)
    VALUES ('ingestion-item', 'ingestion-submission', 'comment_image', 'pending', 0,
      '${filename}', 'image/png', ${byteSize},
      '2026-08-19T10:01:00.000Z', '2026-08-19T10:01:00.000Z');
  `);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared attachment ingestion adapters", () => {
  it("deduplicates identical bytes across ordinary and Project R2 upload adapters", async () => {
    const database = referenceTestDatabase();
    const { env, put } = envFor(database);
    const bytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);

    const ordinary = await request(env, "/assets", {
      method: "POST",
      headers: { "content-type": "image/png", "x-filename": "shared.png" },
      body: bytes,
    });
    expect(ordinary.status).toBe(201);
    const ordinaryPayload = await ordinary.json() as {
      id: string; key: string; deduplicated: boolean;
    };
    expect(ordinaryPayload.deduplicated).toBe(false);

    const project = await request(env, "/project-assets", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-project-filename-uri": encodeURIComponent("shared.png"),
      },
      body: bytes,
    });
    expect(project.status).toBe(200);
    expect(await project.json()).toEqual({
      id: ordinaryPayload.id,
      key: ordinaryPayload.key,
      deduplicated: true,
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM assets").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("lets Project reuse identical bytes with different contextual upload metadata", async () => {
    const database = referenceTestDatabase();
    const { env, put } = envFor(database);
    const bytes = Uint8Array.from([137, 80, 78, 71, 5, 6, 7, 8]);

    const ordinary = await request(env, "/assets", {
      method: "POST",
      headers: { "content-type": "image/png", "x-filename": "canonical.png" },
      body: bytes,
    });
    expect(ordinary.status).toBe(201);
    const ordinaryPayload = await ordinary.json() as { id: string; key: string };

    const project = await request(env, "/project-assets", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-project-filename-uri": encodeURIComponent("renamed.bin"),
      },
      body: bytes,
    });
    expect(project.status).toBe(200);
    expect(await project.json()).toEqual({
      id: ordinaryPayload.id,
      key: ordinaryPayload.key,
      deduplicated: true,
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(database.prepare(`
      SELECT original_name, mime_type, byte_size FROM assets WHERE id = ?
    `).get(ordinaryPayload.id)).toEqual({
      original_name: "canonical.png",
      mime_type: "image/png",
      byte_size: bytes.byteLength,
    });
    database.close();
  });

  it("lets a Comment image adopt an ordinary R2 winner without another provider write", async () => {
    const database = referenceTestDatabase();
    const { env, put } = envFor(database);
    const bytes = Uint8Array.from([137, 80, 78, 71, 9, 10, 11, 12]);
    seedCommentImageUpload(database, bytes.byteLength);

    const ordinary = await request(env, "/assets", {
      method: "POST",
      headers: { "content-type": "image/png", "x-filename": "shared-comment.png" },
      body: bytes,
    });
    expect(ordinary.status).toBe(201);
    const ordinaryPayload = await ordinary.json() as { id: string };

    const comment = await request(
      env,
      "/comment-submissions/ingestion-submission/items/ingestion-item/content",
      {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-upload-size": String(bytes.byteLength),
        },
        body: bytes,
      },
    );
    expect(comment.status).toBe(200);
    expect(await comment.json()).toEqual({ ok: true, deduplicated: true });
    expect(database.prepare(`
      SELECT status, asset_id FROM comment_submission_items
      WHERE id = 'ingestion-item'
    `).get()).toEqual({ status: "ready", asset_id: ordinaryPayload.id });
    expect(put).toHaveBeenCalledTimes(1);
    database.close();
  });

  it.each(["ordinary", "project", "comment"] as const)(
    "maps verified-reuse provider failure consistently through the %s adapter",
    async (adapter) => {
      const database = referenceTestDatabase();
      const bytes = Uint8Array.from([137, 80, 78, 71, 21, 22, 23, 24]);
      const sha256 = await sha256Hex(bytesBuffer(bytes));
      database.prepare(`
        INSERT INTO assets
          (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
        VALUES ('provider-winner', 'shared/provider.png', 'provider.png', 'image/png',
          ?, 'ready', ?, '2026-08-19T10:00:00.000Z')
      `).run(bytes.byteLength, sha256);
      if (adapter === "comment") {
        seedCommentImageUpload(database, bytes.byteLength, "provider.png");
      }

      const { env, put, head } = envFor(database);
      head.mockRejectedValue(new Error("injected R2 outage"));
      const response = adapter === "ordinary"
        ? await request(env, "/assets", {
          method: "POST",
          headers: { "content-type": "image/png", "x-filename": "provider.png" },
          body: bytes,
        })
        : adapter === "project"
          ? await request(env, "/project-assets", {
            method: "POST",
            headers: {
              "content-type": "image/png",
              "x-project-filename-uri": encodeURIComponent("provider.png"),
            },
            body: bytes,
          })
          : await request(
            env,
            "/comment-submissions/ingestion-submission/items/ingestion-item/content",
            {
              method: "PUT",
              headers: {
                "content-type": "image/png",
                "x-upload-size": String(bytes.byteLength),
              },
              body: bytes,
            },
          );

      expect(response.status).toBe(503);
      const payload = await response.json() as { error: string };
      expect(payload.error).toContain("could not be verified before deduplication");
      expect(put).not.toHaveBeenCalled();
      expect(database.prepare("SELECT COUNT(*) AS count FROM assets").get())
        .toEqual({ count: 1 });
      database.close();
    },
  );

  it("keeps low-level registration out of the three public attachment adapters", () => {
    const project = readFileSync(new URL("./project-foundation-routes.ts", import.meta.url), "utf8");
    const comment = readFileSync(new URL("./comment-submission-routes.ts", import.meta.url), "utf8");
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const ordinaryRoute = index.slice(
      index.indexOf('app.post("/assets"'),
      index.indexOf('app.get("/exports/r2/:key{.+}"'),
    );

    expect(project).toContain('from "./attachment-ingestion"');
    expect(project).toContain("ingestR2Attachment");
    expect(project).not.toContain("registerR2Asset");
    expect(project).not.toContain("findReusableR2Asset");

    expect(comment).toContain('from "./attachment-ingestion"');
    expect(comment).toContain("ingestR2Attachment");
    expect(comment).toContain("ingestManagedAttachment");
    expect(comment).not.toContain("registerR2Asset");
    expect(comment).not.toContain("registerManagedObject");
    expect(comment).not.toContain("findReusableR2Asset");
    expect(comment).not.toContain("findReusableManagedObject");

    expect(ordinaryRoute).toContain("ingestR2Attachment");
    expect(ordinaryRoute).not.toContain("registerR2Asset");
    expect(ordinaryRoute).not.toContain("findReusableR2Asset");
  });
});

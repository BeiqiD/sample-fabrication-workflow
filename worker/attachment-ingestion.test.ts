import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import worker from "./index";
import { acceptCommentUpload } from "./comment-acceptance-test-support";
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
    R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "test-assets" }),
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

async function request(env: Env, path: string, init?: RequestInit) {
  if (init?.method === "POST" && ["/assets", "/project-assets"].includes(path)) {
    const headers = new Headers(init.headers);
    headers.set("x-upload-request-id", crypto.randomUUID());
    init = { ...init, headers };
  }
  if (init?.method === "PUT" && path.startsWith("/comment-submissions/") && init.body instanceof Uint8Array) {
    const headers = new Headers(init.headers);
    headers.set("x-content-sha256", await sha256Hex(bytesBuffer(init.body)));
    init = { ...init, headers };
  }
  return worker.fetch(
    new Request(`https://app.test/api${path}`, init),
    env,
    executionContext,
  );
}

async function seedCommentImageUpload(
  database: ReturnType<typeof referenceTestDatabase>,
  env: Env,
  bytes: Uint8Array,
  filename = "shared-comment.png",
) {
  database.exec(`
    INSERT INTO samples (id, code, title, status, created_at, updated_at)
    VALUES ('ingestion-sample', 'INGEST-1', 'Ingestion sample', 'stored',
      '2026-08-19T10:00:00.000Z', '2026-08-19T10:00:00.000Z');
  `);
  await acceptCommentUpload(database, env, { kind: "comment_image", bytes, filename,
    sampleId: "ingestion-sample", submissionId: "ingestion-submission", itemId: "ingestion-item" });
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
    await seedCommentImageUpload(database, env, bytes);

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
    expect(await comment.json()).toMatchObject({ ok: true, deduplicated: true, request: { status: "pending",
      items: [{ id: "ingestion-item", status: "ready" }] } });
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
      const { env, put, head } = envFor(database);
      if (adapter === "comment") {
        await seedCommentImageUpload(database, env, bytes, "provider.png");
      }
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
      expect(payload.error).toContain(adapter === "comment" ? "Comment outcome could not be determined" : "could not be verified before deduplication");
      expect(put).not.toHaveBeenCalled();
      expect(database.prepare("SELECT COUNT(*) AS count FROM assets").get())
        .toEqual({ count: 1 });
      database.close();
    },
  );

  it("keeps low-level registration out of the three public attachment adapters", () => {
    const project = readFileSync(new URL("./project-foundation-routes.ts", import.meta.url), "utf8");
    const comment = readFileSync(new URL("./comment-submission-routes.ts", import.meta.url), "utf8");
    const ordinaryRoute = readFileSync(
      new URL("./blob-lifecycle/attachment-routes.ts", import.meta.url),
      "utf8",
    );

    expect(project).toContain('from "./uploads/r2-upload-acceptance"');
    expect(project).toContain("acceptAndUploadR2Asset");
    expect(project).not.toContain("registerR2Asset");
    expect(project).not.toContain("findReusableR2Asset");

    expect(comment).toContain('from "./uploads/comment-acceptance"');
    expect(comment).toContain("uploadAcceptedCommentItem");
    const acceptance = readFileSync(new URL("./uploads/comment-acceptance.ts", import.meta.url), "utf8");
    expect(acceptance).toContain('from "../attachment-ingestion"');
    expect(acceptance).toContain("ingestR2Attachment");
    expect(acceptance).toContain("ingestManagedAttachment");
    expect(acceptance).not.toMatch(/registerR2Asset|registerManagedObject|findReusableR2Asset|findReusableManagedObject/);
    expect(comment).not.toContain("registerR2Asset");
    expect(comment).not.toContain("registerManagedObject");
    expect(comment).not.toContain("findReusableR2Asset");
    expect(comment).not.toContain("findReusableManagedObject");

    expect(ordinaryRoute).toContain("acceptAndUploadR2Asset");
    expect(ordinaryRoute).not.toContain("registerR2Asset");
    expect(ordinaryRoute).not.toContain("findReusableR2Asset");
  });
});

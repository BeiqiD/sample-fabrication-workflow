import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const NOW = "2026-09-13T18:00:00.000Z";
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;
const databases: ReturnType<typeof referenceTestDatabase>[] = [];

function fixture(provider = "switchdrive") {
  const database = referenceTestDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO samples (id, code, title, created_at, updated_at)
    VALUES ('read-sample', 'READ', 'Read sample', '${NOW}', '${NOW}');
    INSERT INTO comment_submissions (
      id, context_kind, sample_id, body, status, created_at, updated_at, completed_at
    ) VALUES ('read-submission', 'sample', 'read-sample', 'Attachment',
      'ready', '${NOW}', '${NOW}', '${NOW}');
  `);
  database.prepare(`
    INSERT INTO managed_storage_objects (
      id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at
    ) VALUES ('read-object', ?, 'comments/opaque 文件.png', 'μ scan.png',
      'image/png', 4, ?, 'ready', ?)
  `).run(provider, "a".repeat(64), NOW);
  database.prepare(`
    INSERT INTO comment_submission_items (
      id, submission_id, kind, status, position, filename, mime_type,
      byte_size, storage_object_id, created_at, updated_at
    ) VALUES ('read-item', 'read-submission', 'attachment', 'ready', 0,
      'μ scan.png', 'image/png', 4, 'read-object', ?, ?)
  `).run(NOW, NOW);
  const env = {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {} as R2Bucket,
    MANAGED_STORAGE_PROVIDER: "switchdrive",
    SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
    SWITCHDRIVE_USERNAME: "user@example.ch",
    SWITCHDRIVE_APP_PASSWORD: "secret-app-password",
  } satisfies Env;
  return { database, env: env as Env };
}

function request(env: Env, path: string) {
  return worker.fetch(new Request(`https://app.test${path}`), env, executionContext);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

const livePath = "/api/attachments/read-item/download";
const exportPath = "/api/exports/attachments/read-item";

describe.each([
  { name: "live attachment", path: livePath },
  { name: "export attachment", path: exportPath },
])("$name byte-reader boundary", ({ path }) => {
  it("keeps attachment disposition, private caching, filename and unchanged streamed bytes", async () => {
    const { env } = fixture();
    const fetchMock = vi.fn(async () => new Response("data", {
      headers: { "content-type": "image/png", etag: '"attachment-etag"' },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await request(env, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition"))
      .toBe('attachment; filename="__scan.png"; filename*=UTF-8\'\'%CE%BC%20scan.png');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe('"attachment-etag"');
    expect(await response.text()).toBe("data");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://drive.switch.ch/remote.php/dav/files/user%40example.ch/sample-fabrication-workflow/comments/opaque%20%E6%96%87%E4%BB%B6.png",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([404, 401, 403, 503, 302])(
    "maps provider HTTP %s without disclosing response body or headers",
    async (status) => {
      const { env } = fixture();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider detail: secret-app-password", {
        status,
        headers: { location: "https://private-provider.example/token=secret" },
      })));
      const response = await request(env, path);
      expect(response.status).toBe(status === 404 ? 404 : 503);
      expect(await response.json()).toEqual({
        error: status === 404 ? "Attachment object not found" : "Attachment storage is unavailable",
      });
    },
  );

  it("does not expose a transport exception", async () => {
    const { env } = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("private endpoint and secret-app-password");
    }));
    const response = await request(env, path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Attachment storage is unavailable" });
  });

  it("does not read an old provider through a different configured provider", async () => {
    const { env } = fixture("other-provider");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await request(env, path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Attachment storage is unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unavailable metadata and unauthenticated requests before provider I/O", async () => {
    const { database, env } = fixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    database.prepare("UPDATE comment_submission_items SET status = 'pending' WHERE id = 'read-item'").run();
    expect((await request(env, path)).status).toBe(404);
    env.AUTH_MODE = "access";
    env.ACCESS_TEAM_DOMAIN = "https://access.example";
    env.ACCESS_AUD = "application-audience";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await request(env, path)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("live and export attachment authorization", () => {
  it.each(["quarantined", "deleted parent"])(
    "rejects %s attachments from live reads while retaining export access",
    async (reason) => {
      const { database, env } = fixture();
      if (reason === "quarantined") {
        database.prepare(`
          INSERT INTO blob_integrity_quarantine (
            store_kind, provider, object_key, blob_record_id, reason,
            expected_byte_size, observed_byte_size, operation_id, detected_at, last_checked_at
          ) VALUES ('managed', 'switchdrive', 'comments/opaque 文件.png', 'read-object',
            'size_mismatch', 4, 7, 'quarantine-operation', ?, ?)
        `).run(NOW, NOW);
      } else {
        database.prepare("UPDATE samples SET deleted_at = ? WHERE id = 'read-sample'").run(NOW);
      }
      const fetchMock = vi.fn(async () => new Response("data", {
        headers: { "content-type": "image/png" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      expect((await request(env, livePath)).status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
      const exported = await request(env, exportPath);
      expect(exported.status).toBe(200);
      expect(await exported.text()).toBe("data");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "shared/project-types.ts",
    "export const PROJECT_EXPORT_SCHEMA_VERSION = 4 as const;",
    "export const PROJECT_EXPORT_SCHEMA_VERSION = 5 as const;",
)

replace_once(
    "worker/project-foundation-routes.ts",
    'import { refreshOrphanGrace } from "./blob-lifecycle/reachability";',
    'import {\n  BlobReuseProviderUnavailableError,\n  findReusableR2Asset,\n} from "./blob-lifecycle/reuse";',
)
replace_once(
    "worker/project-foundation-routes.ts",
    '''async function reusableProjectAsset(\n  db: D1Database,\n  sha256: string,\n) {\n  return db.prepare(\n    `SELECT id, r2_key, original_name, mime_type, byte_size FROM assets a\n     WHERE sha256 = ? AND status = 'ready'\n       AND NOT EXISTS (\n         SELECT 1 FROM blob_gc_ledger bg\n         WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'\n           AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')\n       )\n     LIMIT 1`,\n  ).bind(sha256).first<ProjectAssetRow>();\n}\n\nasync function returnReusableProjectAsset(\n  db: D1Database,\n  row: ProjectAssetRow,\n  filename: string,\n  contentType: string,\n  byteSize: number,\n) {\n  requireMatchingProjectAssetMetadata(row, filename, contentType, byteSize);\n  if (!await refreshOrphanGrace(db, {\n    storeKind: "r2",\n    provider: "r2",\n    objectKey: row.r2_key,\n    blobRecordId: row.id,\n  }, crypto.randomUUID(), new Date())) return null;\n  return { id: row.id, key: row.r2_key, deduplicated: true as const };\n}\n''',
    '''async function reusableProjectAsset(\n  env: Env,\n  sha256: string,\n) {\n  try {\n    return await findReusableR2Asset(env, sha256);\n  } catch (error) {\n    if (error instanceof BlobReuseProviderUnavailableError) {\n      throw new HTTPException(503, { message: error.message });\n    }\n    throw error;\n  }\n}\n\nfunction returnReusableProjectAsset(\n  row: ProjectAssetRow,\n  filename: string,\n  contentType: string,\n  byteSize: number,\n) {\n  requireMatchingProjectAssetMetadata(row, filename, contentType, byteSize);\n  return { id: row.id, key: row.r2_key, deduplicated: true as const };\n}\n''',
)
replace_once(
    "worker/project-foundation-routes.ts",
    '''  blob_gc_ledger: "SELECT * FROM blob_gc_ledger ORDER BY store_kind, provider, object_key",\n  blob_retention_edges:''',
    '''  blob_gc_ledger: "SELECT * FROM blob_gc_ledger ORDER BY store_kind, provider, object_key",\n  blob_integrity_quarantine: "SELECT * FROM blob_integrity_quarantine ORDER BY store_kind, provider, object_key",\n  blob_retention_edges:''',
)
replace_once(
    "worker/project-foundation-routes.ts",
    '''  const sha256 = await sha256Hex(buffer);\n  const existing = await reusableProjectAsset(c.env.DB, sha256);\n  if (existing) {\n    const reusable = await returnReusableProjectAsset(\n      c.env.DB,\n      existing,\n      filename,\n      contentType,\n      buffer.byteLength,\n    );\n    if (reusable) return c.json(reusable);\n  }\n\n  const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${projectAssetKeyFilename(filename)}`;\n  const id = crypto.randomUUID();\n  const now = new Date().toISOString();\n  await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });\n  try {\n    await c.env.DB.prepare(\n      `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)\n       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,\n    ).bind(id, key, filename, contentType, buffer.byteLength, c.get("userEmail"), now, sha256).run();\n  } catch (error) {\n    await c.env.ASSETS.delete(key);\n    const winner = await reusableProjectAsset(c.env.DB, sha256);\n    if (winner) {\n      const reusable = await returnReusableProjectAsset(\n        c.env.DB,\n        winner,\n        filename,\n        contentType,\n        buffer.byteLength,\n      );\n      if (reusable) return c.json(reusable);\n    }\n    throw error;\n  }\n  return c.json({ id, key, deduplicated: false }, 201);''',
    '''  const sha256 = await sha256Hex(buffer);\n  const existing = await reusableProjectAsset(c.env, sha256);\n  if (existing) {\n    return c.json(returnReusableProjectAsset(\n      existing,\n      filename,\n      contentType,\n      buffer.byteLength,\n    ));\n  }\n\n  for (let attempt = 0; attempt < 2; attempt += 1) {\n    const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${projectAssetKeyFilename(filename)}`;\n    const id = crypto.randomUUID();\n    const now = new Date().toISOString();\n    await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });\n    try {\n      await c.env.DB.prepare(\n        `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)\n         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,\n      ).bind(id, key, filename, contentType, buffer.byteLength, c.get("userEmail"), now, sha256).run();\n      return c.json({ id, key, deduplicated: false }, 201);\n    } catch (error) {\n      await c.env.ASSETS.delete(key);\n      const winner = await reusableProjectAsset(c.env, sha256);\n      if (winner) {\n        return c.json(returnReusableProjectAsset(\n          winner,\n          filename,\n          contentType,\n          buffer.byteLength,\n        ));\n      }\n      if (attempt === 1) throw error;\n    }\n  }\n  throw new HTTPException(409, { message: "Project attachment registration could not be reconciled" });''',
)

replace_once(
    "worker/project-foundation-routes.test.ts",
    '''  "blob_gc_ledger",\n  "blob_retention_edges",''',
    '''  "blob_gc_ledger",\n  "blob_integrity_quarantine",\n  "blob_retention_edges",''',
)

replace_once(
    "worker/project-routes.test.ts",
    '''  const uploaded = new Map<string, Uint8Array>();\n  const bucket = {''',
    '''  const uploaded = new Map<string, Uint8Array>();\n  const head = vi.fn(async (key: string) => {\n    const body = key === "projects/route-asset.bin" ? bytes : uploaded.get(key);\n    if (!body) return null;\n    return {\n      size: body.byteLength,\n      httpEtag: '\"route-etag\"',\n      writeHttpMetadata(headers: Headers) {\n        headers.set("content-type", "application/octet-stream");\n      },\n    };\n  });\n  const bucket = {\n    head,''',
)
replace_once(
    "worker/project-routes.test.ts",
    '''  return { app, env, database, bytes, uploaded };''',
    '''  return { app, env, database, bytes, uploaded, head };''',
)
replace_once(
    "worker/project-routes.test.ts",
    '''    const exactDuplicate = await attachmentUploadRequest(app, env, "实验结果.pdf", "application/pdf", body);\n    expect(exactDuplicate.status).toBe(200);\n    expect(await exactDuplicate.json()).toMatchObject({\n      id: firstBody.id,\n      key: firstBody.key,\n      deduplicated: true,\n    });\n\n    const renamedDuplicate = await attachmentUploadRequest(app, env, "renamed.pdf", "application/pdf", body);''',
    '''    const exactDuplicate = await attachmentUploadRequest(app, env, "实验结果.pdf", "application/pdf", body);\n    expect(exactDuplicate.status).toBe(200);\n    expect(await exactDuplicate.json()).toMatchObject({\n      id: firstBody.id,\n      key: firstBody.key,\n      deduplicated: true,\n    });\n\n    uploaded.delete(firstBody.key);\n    const repaired = await attachmentUploadRequest(app, env, "实验结果.pdf", "application/pdf", body);\n    expect(repaired.status).toBe(201);\n    const repairedBody = await repaired.json<{ id: string; key: string; deduplicated: boolean }>();\n    expect(repairedBody).toMatchObject({ deduplicated: false });\n    expect(repairedBody.id).not.toBe(firstBody.id);\n    expect(database.prepare(`\n      SELECT reason, expected_byte_size, observed_byte_size\n      FROM blob_integrity_quarantine\n      WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ?\n    `).get(firstBody.key)).toEqual({\n      reason: "missing",\n      expected_byte_size: body.byteLength,\n      observed_byte_size: null,\n    });\n\n    const renamedDuplicate = await attachmentUploadRequest(app, env, "renamed.pdf", "application/pdf", body);''',
)

replace_once(
    "worker/switchdrive-storage.test.ts",
    '''  it("streams downloads and treats a missing object as absent", async () => {''',
    '''  it("stats objects with HEAD without downloading their bytes", async () => {\n    const fetchMock = vi.fn()\n      .mockResolvedValueOnce(new Response(null, {\n        status: 200,\n        headers: {\n          "content-length": "12",\n          "content-type": "application/pdf",\n          etag: '\"stat-etag\"',\n        },\n      }))\n      .mockResolvedValueOnce(new Response("", { status: 404 }));\n    vi.stubGlobal("fetch", fetchMock);\n    const storage = new SwitchdriveStorage(configuration);\n\n    await expect(storage.stat("comment-attachments/submission/file.pdf")).resolves.toEqual({\n      byteSize: 12,\n      contentType: "application/pdf",\n      etag: '\"stat-etag\"',\n    });\n    await expect(storage.stat("comment-attachments/submission/missing.pdf")).resolves.toBeNull();\n    expect(fetchMock.mock.calls.every((call) => call[1]?.method === "HEAD")).toBe(true);\n  });\n\n  it("does not reinterpret provider failures as missing objects", async () => {\n    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));\n    await expect(new SwitchdriveStorage(configuration).stat("file.bin"))\n      .rejects.toThrow("status 503");\n  });\n\n  it("streams downloads and treats a missing object as absent", async () => {''',
)

Path("worker/blob-integrity.test.ts").write_text(r'''import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlobReuseProviderUnavailableError,
  findReusableManagedObject,
  findReusableR2Asset,
} from "./blob-lifecycle/reuse";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const NOW = "2026-08-14T18:00:00.000Z";
const SHA = "a".repeat(64);

type TestDatabase = ReturnType<typeof referenceTestDatabase>;

function insertAsset(database: TestDatabase, input: { id: string; key: string; size?: number }) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (?, ?, 'file.bin', 'application/octet-stream', ?,
      'ready', 'user@example.com', ?, ?)
  `).run(input.id, input.key, input.size ?? 4, NOW, SHA);
}

function r2Environment(database: TestDatabase, head: (key: string) => Promise<unknown>) {
  return {
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: { head } as unknown as R2Bucket,
    AUTH_MODE: "disabled",
  } satisfies Env;
}

afterEach(() => vi.unstubAllGlobals());

describe("provider-verified blob reuse", () => {
  it("reuses an R2 locator only after a matching HEAD result", async () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-live", key: "objects/live.bin" });
    const head = vi.fn(async () => ({
      size: 4,
      httpEtag: '\"etag\"',
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", "application/octet-stream");
      },
    }));

    await expect(findReusableR2Asset(r2Environment(database, head), SHA))
      .resolves.toMatchObject({ id: "asset-live", r2_key: "objects/live.bin" });
    expect(head).toHaveBeenCalledWith("objects/live.bin");
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_integrity_quarantine").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("quarantines a definitely missing R2 locator and permits a fresh registration", async () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-missing", key: "objects/missing.bin" });
    await expect(findReusableR2Asset(r2Environment(database, async () => null), SHA))
      .resolves.toBeNull();
    expect(database.prepare(`
      SELECT reason, expected_byte_size, observed_byte_size
      FROM blob_integrity_quarantine
    `).get()).toEqual({
      reason: "missing",
      expected_byte_size: 4,
      observed_byte_size: null,
    });
    expect(database.prepare("SELECT status FROM assets WHERE id = 'asset-missing'").get())
      .toEqual({ status: "ready" });
    expect(() => insertAsset(database, { id: "asset-replacement", key: "objects/replacement.bin" }))
      .not.toThrow();
    database.close();
  });

  it("quarantines a definite size mismatch", async () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-mismatch", key: "objects/mismatch.bin" });
    await expect(findReusableR2Asset(r2Environment(database, async () => ({
      size: 7,
      httpEtag: null,
      writeHttpMetadata() {},
    })), SHA)).resolves.toBeNull();
    expect(database.prepare(`
      SELECT reason, expected_byte_size, observed_byte_size
      FROM blob_integrity_quarantine
    `).get()).toEqual({
      reason: "size_mismatch",
      expected_byte_size: 4,
      observed_byte_size: 7,
    });
    database.close();
  });

  it("keeps metadata untouched when R2 is temporarily unavailable", async () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-unavailable", key: "objects/unavailable.bin" });
    const env = r2Environment(database, async () => {
      throw new Error("temporary outage");
    });
    await expect(findReusableR2Asset(env, SHA)).rejects.toBeInstanceOf(
      BlobReuseProviderUnavailableError,
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_integrity_quarantine").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("verifies managed objects and releases their hash after quarantine", async () => {
    const database = referenceTestDatabase();
    database.prepare(`
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES (
        'managed-missing', 'switchdrive', 'objects/missing.bin', 'file.bin',
        'application/octet-stream', 4, ?, 'ready', 'user@example.com', ?
      )
    `).run(SHA, NOW);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const env = {
      DB: new SqliteD1Database(database) as unknown as D1Database,
      ASSETS: {} as R2Bucket,
      AUTH_MODE: "disabled",
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
      SWITCHDRIVE_USERNAME: "user@example.ch",
      SWITCHDRIVE_APP_PASSWORD: "app-password",
    } satisfies Env;

    await expect(findReusableManagedObject(env, "switchdrive", SHA, 4)).resolves.toBeNull();
    expect(database.prepare(`
      SELECT reason FROM blob_integrity_quarantine WHERE store_kind = 'managed'
    `).get()).toEqual({ reason: "missing" });
    expect(() => database.prepare(`
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES (
        'managed-replacement', 'switchdrive', 'objects/replacement.bin', 'file.bin',
        'application/octet-stream', 4, ?, 'ready', 'user@example.com', ?
      )
    `).run(SHA, NOW)).not.toThrow();
    database.close();
  });

  it("blocks new relationships to quarantined locators", () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-quarantined", key: "objects/quarantined.bin" });
    database.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES ('r2', 'r2', 'objects/quarantined.bin', 'asset-quarantined',
        'missing', 4, NULL, 'operation-quarantine', ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO state_representations (
        hash, hash_scheme, representation_type, content_json, created_at
      ) VALUES ('state-quarantine', 'v1', 'image_set', '{}', ?)
    `).run(NOW);
    expect(() => database.prepare(`
      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('state-quarantine', 'asset-quarantined', 0)
    `).run()).toThrow("blob locator is quarantined");
    database.close();
  });
});
''')

replace_once(
    "package.json",
    '''    "test:blob-lifecycle": "vitest run worker/blob-reachability.test.ts worker/blob-gc.test.ts worker/blob-export.test.ts worker/permanent-delete-protection.test.ts worker/blob-lifecycle-review-fixes.test.ts worker/blob-lifecycle-migration-safety.test.ts worker/blob-lifecycle-legacy-managed-migration.test.ts",''',
    '''    "test:blob-lifecycle": "vitest run worker/blob-reachability.test.ts worker/blob-gc.test.ts worker/blob-export.test.ts worker/permanent-delete-protection.test.ts worker/blob-lifecycle-review-fixes.test.ts worker/blob-lifecycle-migration-safety.test.ts worker/blob-lifecycle-legacy-managed-migration.test.ts",\n    "test:storage-integrity": "vitest run worker/blob-integrity.test.ts worker/switchdrive-storage.test.ts",''',
)
replace_once(
    "package.json",
    '''    "verify:blob-lifecycle": "npm run test:blob-lifecycle && npm run verify:d1-migrations",''',
    '''    "verify:blob-lifecycle": "npm run test:blob-lifecycle && npm run verify:d1-migrations",\n    "verify:storage-integrity": "npm run test:storage-integrity && npm run verify:d1-migrations",''',
)
replace_once(
    "package.json",
    '''    "verify:v3-deployment": "npm run test:blob-lifecycle && npm run test:reference-foundation''',
    '''    "verify:v3-deployment": "npm run test:blob-lifecycle && npm run test:storage-integrity && npm run test:reference-foundation''',
)

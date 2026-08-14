import { afterEach, describe, expect, it, vi } from "vitest";
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

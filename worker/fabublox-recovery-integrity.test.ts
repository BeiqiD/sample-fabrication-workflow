import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectFabubloxRecoveryAssets, FabubloxRecoveryProviderUnavailableError } from "./fabublox-recovery-assets";
import { queueFabubloxImportCleanup } from "./fabublox-import-recovery";
import { inspectLegacyRecoveryBytes } from "./files/legacy-byte-inspection";
import { MAX_VERIFIED_BYTES, type Sha256Factory } from "./files/byte-verification";
import type { ByteReadResult } from "./files/byte-reader";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6);
const expectedHash = hashOf(bytes);
const SAFE_MESSAGE = "FabuBlox recovery file bytes could not be verified. Retry later.";
const hashFactory: Sha256Factory = () => {
  const hash = createHash("sha256");
  return {
    async write(value) { hash.update(value); },
    async finish() { return hash.digest("hex"); },
    async abort() {},
  };
};
const stream = (value: Uint8Array) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(value); controller.close(); },
});
const available = (body: ReadableStream): ByteReadResult => ({
  outcome: "available", body, contentType: "application/octet-stream", etag: null, httpMetadata: {},
});

function recoveryFixture(sha256: string | null = expectedHash) {
  const sql = referenceTestDatabase();
  sql.prepare(`INSERT INTO imports
    (id, status, source_filename, source_sha256, sheet_name, template_type, operation_id, created_at)
    VALUES ('import', 'failed', 'source.xlsx', ?, 'Sheet1', 'process', 'upload-operation', '2026-01-01T00:00:00.000Z')`)
    .run("1".repeat(64));
  sql.prepare(`INSERT INTO assets
    (id, import_id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
    VALUES ('source', 'import', 'imports/source.png', 'source.png', 'image/png', ?, 'failed', ?, '2026-01-01T00:00:00.000Z')`)
    .run(bytes.byteLength, sha256);
  const objects = new Map<string, () => ReadableStream>([["imports/source.png", () => stream(bytes)]]);
  const get = vi.fn(async (key: string) => objects.has(key) ? {
    body: objects.get(key)!(), size: bytes.byteLength, httpEtag: '"untrusted-etag"',
    writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); },
  } : null);
  const head = vi.fn(async (key: string) => objects.has(key) ? {
    size: bytes.byteLength, httpEtag: '"untrusted-etag"',
    writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); },
  } : null);
  const remove = vi.fn();
  const put = vi.fn();
  const env = {
    AUTH_MODE: "disabled", DB: new SqliteD1Database(sql) as unknown as D1Database,
    ASSETS: { get, head, put, delete: remove } as unknown as R2Bucket,
  } satisfies Env;
  const snapshot = () => Object.fromEntries([
    "imports", "assets", "blob_integrity_quarantine", "blob_gc_ledger", "state_representation_assets",
  ].map(table => [table, sql.prepare(`SELECT * FROM ${table}`).all()]));
  const cleanup = () => queueFabubloxImportCleanup(env, {
    importId: "import", operationId: "upload-operation", recoveryOperationId: "cleanup-operation",
    error: "failed import", now: new Date("2026-09-13T00:00:00.000Z"),
  });
  return { sql, objects, env, get, head, remove, put, snapshot, cleanup };
}

describe("bounded recovery byte inspection", () => {
  it.each([expectedHash, null])("verifies full bytes with expected SHA %s", async sha256 => {
    const result = await inspectLegacyRecoveryBytes({ read: async () => available(stream(bytes)) }, "key",
      { byteSize: bytes.byteLength, sha256 }, hashFactory);
    expect(result).toEqual({ outcome: "available", byteSize: bytes.byteLength, sha256: expectedHash });
  });

  it.each([-1, 1.5, Number.NaN, MAX_VERIFIED_BYTES + 1])("rejects invalid size %s before provider access", async byteSize => {
    const read = vi.fn();
    await expect(inspectLegacyRecoveryBytes({ read }, "key", { byteSize, sha256: null }, hashFactory))
      .rejects.toMatchObject({ phase: "destination", reason: "invalid_expectation" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a malformed known hash before provider access", async () => {
    const read = vi.fn();
    await expect(inspectLegacyRecoveryBytes({ read }, "key", { byteSize: 6, sha256: "not-a-hash" }, hashFactory))
      .rejects.toMatchObject({ reason: "invalid_expectation" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects equal-size wrong-hash bytes without relabelling them as missing or size mismatch", async () => {
    await expect(inspectLegacyRecoveryBytes({ read: async () => available(stream(Uint8Array.of(6, 5, 4, 3, 2, 1))) }, "key",
      { byteSize: 6, sha256: expectedHash }, hashFactory)).rejects.toMatchObject({ reason: "hash_mismatch" });
  });

  it("retains expected length and reports a clean short EOF without computing a replacement hash", async () => {
    const finish = vi.fn(async () => expectedHash);
    const abort = vi.fn(async () => undefined);
    const body = stream(bytes.subarray(0, 5));
    expect(await inspectLegacyRecoveryBytes({ read: async () => available(body) }, "key",
      { byteSize: 6, sha256: null }, () => ({ write: async () => undefined, finish, abort })))
      .toEqual({ outcome: "size_mismatch", observedByteSize: 5 });
    expect(finish).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("cancels an overlong stream at the first observed excess without hashing that chunk", async () => {
    const cancel = vi.fn();
    const write = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(bytes); }, cancel }, { highWaterMark: 0 });
    expect(await inspectLegacyRecoveryBytes({ read: async () => available(body) }, "key",
      { byteSize: 5, sha256: null }, () => ({ ...hashFactory(), write })))
      .toEqual({ outcome: "size_mismatch", observedByteSize: 6 });
    expect(write).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("hashes views of one upstream chunk through sequential writes of at most 64 KiB", async () => {
    const source = new Uint8Array(150 * 1024 + 7).fill(19);
    const sizes: number[] = [];
    let active = 0;
    let maximum = 0;
    const actual = hashFactory();
    const result = await inspectLegacyRecoveryBytes({ read: async () => available(stream(source)) }, "key",
      { byteSize: source.byteLength, sha256: null }, () => ({ ...actual,
        async write(chunk) {
          sizes.push(chunk.byteLength);
          expect(chunk.buffer).toBe(source.buffer);
          maximum = Math.max(maximum, ++active);
          await Promise.resolve();
          await actual.write(chunk);
          active--;
        },
      }));
    expect(sizes).toEqual([65536, 65536, 22535]);
    expect(maximum).toBe(1);
    expect(result).toEqual({ outcome: "available", byteSize: source.byteLength, sha256: hashOf(source) });
  });

  it("does not read ahead while the hash sink is backpressured", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      pulls++;
      if (pulls === 1) c.enqueue(bytes);
      else c.close();
    } }, { highWaterMark: 0 });
    const actual = hashFactory();
    const writing = vi.fn(async (chunk: Uint8Array) => { await blocked; await actual.write(chunk); });
    const pending = inspectLegacyRecoveryBytes({ read: async () => available(body) }, "key",
      { byteSize: 6, sha256: null }, () => ({ ...actual, write: writing }));
    await vi.waitFor(() => expect(writing).toHaveBeenCalledTimes(1));
    expect(pulls).toBe(1);
    release();
    await expect(pending).resolves.toMatchObject({ outcome: "available", sha256: expectedHash });
    expect(pulls).toBe(2);
  });

  it("does not certify the expected prefix when the following read errors", async () => {
    let first = true;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      if (first) { first = false; c.enqueue(bytes); }
      else c.error(new Error("provider-secret-after-complete-prefix"));
    } }, { highWaterMark: 0 });
    await expect(inspectLegacyRecoveryBytes({ read: async () => available(body) }, "key",
      { byteSize: 6, sha256: expectedHash }, hashFactory)).rejects.toMatchObject({
      reason: "unavailable", message: "File bytes could not be verified. Retry later.",
    });
    expect(body.locked).toBe(false);
  });

  it.each(["denied", "unavailable", "throws"])("redacts provider %s without making an integrity diagnosis", async kind => {
    const read = async (): Promise<ByteReadResult> => {
      if (kind === "throws") throw new Error("provider-secret-key");
      return kind === "denied" ? { outcome: "denied", status: 403 } : { outcome: "unavailable" };
    };
    await expect(inspectLegacyRecoveryBytes({ read }, "key", { byteSize: 6, sha256: null }, hashFactory))
      .rejects.toMatchObject({ reason: "unavailable", message: "File bytes could not be verified. Retry later." });
  });

  it("reports confirmed absence without starting a hash", async () => {
    const hashing = vi.fn(hashFactory);
    expect(await inspectLegacyRecoveryBytes({ read: async () => ({ outcome: "missing" }) }, "key",
      { byteSize: 6, sha256: null }, hashing)).toEqual({ outcome: "missing" });
    expect(hashing).not.toHaveBeenCalled();
  });

  it("redacts hashing and cleanup failures and releases the stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(bytes); }, cancel() { throw new Error("cancel-secret"); },
    }, { highWaterMark: 0 });
    await expect(inspectLegacyRecoveryBytes({ read: async () => available(body) }, "key",
      { byteSize: 6, sha256: null }, () => ({
        async write() { throw new Error("digest-secret"); },
        async finish() { return expectedHash; },
        async abort() { throw new Error("abort-secret"); },
      }))).rejects.toMatchObject({ reason: "unavailable", message: "File bytes could not be verified. Retry later." });
    expect(body.locked).toBe(false);
  });

  it("rejects malformed body chunks and cancels the upstream stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull(c) { c.enqueue("not-bytes"); }, cancel }, { highWaterMark: 0 });
    await expect(inspectLegacyRecoveryBytes({ read: async () => available(body) }, "key",
      { byteSize: 6, sha256: null }, hashFactory)).rejects.toMatchObject({ reason: "unavailable" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("cancels the opened body when native hashing cannot initialize", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(bytes); }, cancel }, { highWaterMark: 0 });
    await expect(inspectLegacyRecoveryBytes({ read: async () => available(body) }, "key",
      { byteSize: 6, sha256: null }, () => { throw new Error("native-hash-secret"); }))
      .rejects.toMatchObject({ reason: "unavailable", message: "File bytes could not be verified. Retry later." });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});

describe("FabuBlox recovery publication integrity", () => {
  it.each([expectedHash, null])("fully inspects known/null SHA %s and returns a frozen preflight snapshot", async sha256 => {
    const f = recoveryFixture(sha256);
    try {
      const before = f.snapshot();
      const [result] = await inspectFabubloxRecoveryAssets(f.env, f.env.DB, "import");
      expect(result).toMatchObject({ available: true, sha256: expectedHash, byteSize: 6,
        snapshot: { id: "source", sha256, byte_size: 6, status: "failed", gc_state: null },
      });
      expect(Object.isFrozen(result.snapshot)).toBe(true);
      expect(f.get).toHaveBeenCalledWith("imports/source.png");
      expect(f.head).not.toHaveBeenCalled();
      expect(f.snapshot()).toEqual(before);
    } finally { f.sql.close(); }
  });

  it("keeps wrong-hash source metadata and the unfinished import untouched before cleanup claim", async () => {
    const f = recoveryFixture();
    try {
      f.objects.set("imports/source.png", () => stream(Uint8Array.of(6, 5, 4, 3, 2, 1)));
      const before = f.snapshot();
      await expect(f.cleanup()).rejects.toMatchObject({ name: "FabubloxRecoveryProviderUnavailableError", message: SAFE_MESSAGE });
      expect(f.snapshot()).toEqual(before);
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.put).not.toHaveBeenCalled();
    } finally { f.sql.close(); }
  });

  it("rejects a corrupt canonical winner even when HEAD reports the expected size", async () => {
    const f = recoveryFixture();
    try {
      f.sql.prepare(`INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
        VALUES ('canonical', 'public/canonical.png', 'canonical.png', 'image/png', 6, 'ready', ?, '2026-01-02T00:00:00.000Z')`)
        .run(expectedHash);
      f.objects.set("public/canonical.png", () => stream(Uint8Array.of(6, 5, 4, 3, 2, 1)));
      const before = f.snapshot();
      await expect(f.cleanup()).rejects.toBeInstanceOf(FabubloxRecoveryProviderUnavailableError);
      expect(f.head).toHaveBeenCalledWith("public/canonical.png");
      expect(f.get).toHaveBeenCalledWith("public/canonical.png");
      expect(f.snapshot()).toEqual(before);
    } finally { f.sql.close(); }
  });

  it("keeps expected metadata untouched when a stream errors after delivering all expected bytes", async () => {
    const f = recoveryFixture();
    try {
      f.objects.set("imports/source.png", () => {
        let first = true;
        return new ReadableStream<Uint8Array>({ pull(c) {
          if (first) { first = false; c.enqueue(bytes); }
          else c.error(new Error("secret-provider-endpoint"));
        } }, { highWaterMark: 0 });
      });
      const before = f.snapshot();
      await expect(f.cleanup()).rejects.toMatchObject({ message: SAFE_MESSAGE });
      expect(f.snapshot()).toEqual(before);
    } finally { f.sql.close(); }
  });

  it("redacts provider failures before any durable recovery mutation", async () => {
    const f = recoveryFixture();
    try {
      f.get.mockRejectedValueOnce(new Error("https://credentials.example/private/key?secret=token"));
      const before = f.snapshot();
      await expect(f.cleanup()).rejects.toMatchObject({ message: SAFE_MESSAGE });
      expect(f.snapshot()).toEqual(before);
    } finally { f.sql.close(); }
  });
});

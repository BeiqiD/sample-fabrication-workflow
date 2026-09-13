import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { referenceTestDatabase } from "../reference-test-support";
import { assertR2BootstrapProfile, ensureR2BootstrapProfile, r2BootstrapNamespace, R2BootstrapUnavailableError } from "./r2-bootstrap-profile";

const NOW = "2026-09-13T12:00:00.000Z";
const CLOUD = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "source-bucket" });
const OTHER = JSON.stringify({ kind: "cloudflare-r2", accountId: "b".repeat(32), bucketName: "source-bucket" });
const LOCAL = JSON.stringify({ kind: "local-r2", installationId: "ed52e1b3-bc58-4bad-9aab-c803cfa6f14c", bucketName: "source-bucket" });
const ENV = { R2_BOOTSTRAP_NAMESPACE: CLOUD };
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const sql = referenceTestDatabase();
  databases.push(sql);
  let beforeRun: (() => void) | undefined;
  let failAfterRun = false;
  let failBeforeRun = false;
  let failReadback = false;
  let failInitialRead = false;
  class Statement {
    constructor(readonly query: string, readonly args: unknown[] = []) {}
    bind(...args: unknown[]) { return new Statement(this.query, args); }
    async all() {
      if (failInitialRead) throw new Error("private database details");
      return { success: true, results: sql.prepare(this.query).all(...this.args) };
    }
    async first() {
      if (failReadback) throw new Error("private database details");
      return sql.prepare(this.query).get(...this.args) ?? null;
    }
    async run() {
      beforeRun?.();
      if (failBeforeRun) throw new Error("private rejected write");
      const result = sql.prepare(this.query).run(...this.args);
      if (failAfterRun) throw new Error("private lost response");
      return { success: true, meta: { changes: result.changes } };
    }
  }
  return { sql, db: { prepare: (query: string) => new Statement(query) } as unknown as D1Database,
    beforeRun: (callback: () => void) => { beforeRun = callback; },
    failAfterRun: () => { failAfterRun = true; }, failBeforeRun: () => { failBeforeRun = true; },
    failReadback: () => { failReadback = true; }, failInitialRead: () => { failInitialRead = true; } };
}

function seed(sql: DatabaseSync, id: string, namespace = CLOUD) {
  sql.prepare(`INSERT INTO storage_profiles VALUES (?, 'r2', ?, 'bootstrap', NULL, 1, 'historical', ?)`).run(id, namespace, NOW);
}

function rows(sql: DatabaseSync) { return sql.prepare("SELECT * FROM storage_profiles ORDER BY id").all(); }

describe("explicit immutable R2 bootstrap profile", () => {
  it("accepts canonical remote/local namespaces and keeps the two physical kinds distinct", () => {
    expect(r2BootstrapNamespace(ENV)).toBe(CLOUD);
    expect(r2BootstrapNamespace({ R2_BOOTSTRAP_NAMESPACE: LOCAL })).toBe(LOCAL);
    expect(LOCAL).not.toBe(CLOUD);
  });

  it.each([undefined, "", "ASSETS", "r2:DB", "null", "{}", `${CLOUD} `,
    JSON.stringify({ bucketName: "source-bucket", kind: "cloudflare-r2", accountId: "a".repeat(32) }),
    JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "source-bucket", token: "private" }),
    JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "invalid/bucket" }),
    JSON.stringify({ kind: "cloudflare-r2", accountId: "not-an-account", bucketName: "source-bucket" }),
    JSON.stringify({ kind: "local-r2", installationId: "a".repeat(32), bucketName: "source-bucket" }),
  ])("rejects invalid/implicit namespace %s before touching the database", async (namespace) => {
    const db = { prepare: () => { throw new Error("database must not be read"); } } as unknown as D1Database;
    await expect(ensureR2BootstrapProfile(db, { R2_BOOTSTRAP_NAMESPACE: namespace }, NOW)).rejects.toThrow("R2 storage profile is unavailable");
  });

  it("captures a historical profile once and reuses it without changing timestamps or file authority", async () => {
    const { sql, db } = fixture();
    const first = await ensureR2BootstrapProfile(db, ENV, NOW);
    const before = rows(sql);
    expect(first).toEqual({ id: "storage-profile:r2:bootstrap", configurationRevision: 1, namespaceIdentity: CLOUD });
    expect(await ensureR2BootstrapProfile(db, ENV, "2026-09-13T13:00:00.000Z")).toEqual(first);
    expect(rows(sql)).toEqual(before);
    expect(rows(sql)[0]).toMatchObject({ state: "historical", configuration_revision: 1, created_at: NOW, credential_reference: null });
    for (const table of ["files", "file_locations", "legacy_file_mappings"]) expect(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    expect(await assertR2BootstrapProfile(db, ENV, first.id, 1)).toEqual(first);
  });

  it("reuses a matching pre-existing profile identity instead of creating an alias", async () => {
    const { sql, db } = fixture();
    seed(sql, "previous-inventory-profile");
    expect((await ensureR2BootstrapProfile(db, ENV, NOW)).id).toBe("previous-inventory-profile");
    expect(rows(sql)).toHaveLength(1);
  });

  it("does not switch an existing bootstrap namespace or treat local data as cloud data", async () => {
    for (const namespace of [OTHER, LOCAL]) {
      const { sql, db } = fixture();
      seed(sql, "historical", namespace);
      const before = rows(sql);
      await expect(ensureR2BootstrapProfile(db, ENV, NOW)).rejects.toBeInstanceOf(R2BootstrapUnavailableError);
      await expect(assertR2BootstrapProfile(db, ENV, "historical", 1)).rejects.toBeInstanceOf(R2BootstrapUnavailableError);
      expect(rows(sql)).toEqual(before);
    }
  });

  it("reconciles a committed INSERT with a lost response using authoritative readback", async () => {
    const fixtureDb = fixture();
    fixtureDb.failAfterRun();
    const profile = await ensureR2BootstrapProfile(fixtureDb.db, ENV, NOW);
    expect(rows(fixtureDb.sql)).toHaveLength(1);
    expect(profile.namespaceIdentity).toBe(CLOUD);
  });

  it("fails closed when the write did not commit or its readback remains unavailable", async () => {
    for (const failure of ["failBeforeRun", "failReadback", "failInitialRead"] as const) {
      const fixtureDb = fixture();
      fixtureDb[failure]();
      await expect(ensureR2BootstrapProfile(fixtureDb.db, ENV, NOW)).rejects.toThrow("R2 storage profile is unavailable");
      expect(rows(fixtureDb.sql)).toHaveLength(failure === "failReadback" ? 1 : 0);
    }
  });

  it("serializes concurrent first use of the same namespace without changing the winning row", async () => {
    const { sql, db } = fixture();
    const profiles = await Promise.all([ensureR2BootstrapProfile(db, ENV, NOW), ensureR2BootstrapProfile(db, ENV, "2026-09-13T13:00:00.000Z")]);
    expect(profiles[0]).toEqual(profiles[1]);
    expect(rows(sql)).toHaveLength(1);
    expect(rows(sql)[0].created_at).toBe(NOW);
  });

  it("rejects a different namespace winning the race between initial read and INSERT", async () => {
    const fixtureDb = fixture();
    fixtureDb.beforeRun(() => seed(fixtureDb.sql, "other-race-winner", OTHER));
    await expect(ensureR2BootstrapProfile(fixtureDb.db, ENV, NOW)).rejects.toThrow("R2 storage profile is unavailable");
    expect(rows(fixtureDb.sql)).toHaveLength(1);
    expect(rows(fixtureDb.sql)[0].namespace_identity).toBe(OTHER);
  });

  it("requires the accepted exact profile and revision for subsequent I/O", async () => {
    const { sql, db } = fixture();
    seed(sql, "captured");
    for (const [id, revision] of [["missing", 1], ["captured", 2], ["captured", NaN], ["captured\0", 1]] as const) {
      await expect(assertR2BootstrapProfile(db, ENV, id, revision)).rejects.toThrow("R2 storage profile is unavailable");
    }
    expect(await assertR2BootstrapProfile(db, ENV, "captured", 1)).toMatchObject({ id: "captured", configurationRevision: 1 });
  });

  it("does not adopt malformed profile metadata or write on invalid timestamps", async () => {
    const { sql, db } = fixture();
    await expect(ensureR2BootstrapProfile(db, ENV, "yesterday")).rejects.toThrow("R2 storage profile is unavailable");
    expect(rows(sql)).toHaveLength(0);
    const invalidDb = { prepare: () => ({ bind: () => ({ first: async () => ({ id: "captured", adapter_type: "r2", namespace_identity: CLOUD,
      configuration_source: "bootstrap", credential_reference: "private-token", configuration_revision: 1, state: "historical" }) }) }) } as unknown as D1Database;
    await expect(assertR2BootstrapProfile(invalidDb, ENV, "captured", 1)).rejects.toThrow("R2 storage profile is unavailable");
  });
});

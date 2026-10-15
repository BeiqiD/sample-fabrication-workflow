import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { referenceTestDatabase } from "../reference-test-support";
import { assertManagedBootstrapProfile, ensureManagedBootstrapProfile, managedBootstrapNamespace, ManagedBootstrapUnavailableError } from "./managed-bootstrap-profile";

const NOW = "2026-09-14T12:00:00.000Z";
const ENV = {
  MANAGED_STORAGE_PROVIDER: "switchdrive",
  SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/account%40example.ch",
  SWITCHDRIVE_USERNAME: "authentication-user",
  SWITCHDRIVE_APP_PASSWORD: "private-app-password",
  SWITCHDRIVE_ROOT: "research/comment-files",
};
const NAMESPACE = JSON.stringify({ kind: "switchdrive", webdavUrl: ENV.SWITCHDRIVE_WEBDAV_URL, root: ENV.SWITCHDRIVE_ROOT });
const OTHER = managedBootstrapNamespace({ ...ENV, SWITCHDRIVE_ROOT: "another-root" });
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const sql = referenceTestDatabase();
  databases.push(sql);
  let beforeRun: (() => void) | undefined;
  let failure: "before-run" | "after-run" | "readback" | "initial-read" | "initial-result" | null = null;
  let primaryReads = 0;
  class Statement {
    constructor(readonly query: string, readonly args: unknown[] = []) {}
    bind(...args: unknown[]) { return new Statement(this.query, args); }
    async all() {
      if (failure === "initial-read") throw new Error("private database details");
      return { success: failure !== "initial-result", results: sql.prepare(this.query).all(...this.args) };
    }
    async first() {
      if (failure === "readback") throw new Error("private database details");
      return sql.prepare(this.query).get(...this.args) ?? null;
    }
    async run() {
      beforeRun?.();
      if (failure === "before-run") throw new Error("private rejected write");
      const result = sql.prepare(this.query).run(...this.args);
      if (failure === "after-run") throw new Error("private lost response");
      return { success: true, meta: { changes: result.changes } };
    }
  }
  const session = { prepare: (query: string) => new Statement(query) };
  return { sql,
    db: { prepare: () => { throw new Error("replica must not be read"); }, withSession: (constraint: string) => {
      expect(constraint).toBe("first-primary"); primaryReads += 1; return session;
    } } as unknown as D1Database,
    session: session as unknown as D1Database,
    beforeRun: (callback: () => void) => { beforeRun = callback; },
    fail: (mode: NonNullable<typeof failure>) => { failure = mode; },
    primaryReads: () => primaryReads,
  };
}

function seed(sql: DatabaseSync, id: string, namespace = NAMESPACE) {
  sql.prepare(`INSERT INTO storage_profiles VALUES (?, 'switchdrive', ?, 'environment', 'environment:SWITCHDRIVE', 1, 'historical', ?)`).run(id, namespace, NOW);
}

function rows(sql: DatabaseSync) { return sql.prepare("SELECT * FROM storage_profiles ORDER BY id").all(); }

describe("immutable managed environment profile", () => {
  it("captures the effective account endpoint and root, excluding authentication and ignored URL fields", () => {
    expect(managedBootstrapNamespace(ENV)).toBe(NAMESPACE);
    expect(managedBootstrapNamespace({ ...ENV,
      MANAGED_STORAGE_PROVIDER: " SWITCHdrive ",
      SWITCHDRIVE_WEBDAV_URL: ` https://DRIVE.SWITCH.CH:443/remote.php/dav/files/account%40example.ch/?password=ignored-secret#ignored `,
      SWITCHDRIVE_ROOT: " /research//comment-files/ ",
      SWITCHDRIVE_USERNAME: "replacement-authentication-user",
      SWITCHDRIVE_APP_PASSWORD: "replacement-app-password",
    })).toBe(NAMESPACE);
    expect(NAMESPACE).not.toContain(ENV.SWITCHDRIVE_USERNAME);
    expect(NAMESPACE).not.toContain(ENV.SWITCHDRIVE_APP_PASSWORD);
    expect(managedBootstrapNamespace({ ...ENV, SWITCHDRIVE_ROOT: undefined }))
      .toBe(managedBootstrapNamespace({ ...ENV, SWITCHDRIVE_ROOT: " /sample-fabrication-workflow/ " }));
  });

  it("keeps distinct accounts, roots and literal encoded root segments distinct", () => {
    for (const change of [
      { SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/another-account" },
      { SWITCHDRIVE_ROOT: "another-root" },
      { SWITCHDRIVE_ROOT: "research%2Fcomment-files" },
      { SWITCHDRIVE_ROOT: "research/ comment-files" },
    ]) expect(managedBootstrapNamespace({ ...ENV, ...change })).not.toBe(NAMESPACE);
  });

  it.each([
    { MANAGED_STORAGE_PROVIDER: undefined }, { MANAGED_STORAGE_PROVIDER: "other" },
    { SWITCHDRIVE_USERNAME: " " }, { SWITCHDRIVE_APP_PASSWORD: undefined },
    { SWITCHDRIVE_WEBDAV_URL: "https://another.example/remote.php/dav/files/account" },
    { SWITCHDRIVE_WEBDAV_URL: "https://user:secret@drive.switch.ch/remote.php/dav/files/account" },
    { SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files" },
    { SWITCHDRIVE_ROOT: "/" }, { SWITCHDRIVE_ROOT: "root/../another" },
    { SWITCHDRIVE_ROOT: "root\\another" }, { SWITCHDRIVE_ROOT: "a".repeat(2048) },
  ])("rejects unavailable or invalid configuration before database access: %j", async (change) => {
    const db = { prepare: () => { throw new Error("database must not be read"); },
      withSession: () => { throw new Error("database must not be read"); } } as unknown as D1Database;
    await expect(ensureManagedBootstrapProfile(db, { ...ENV, ...change }, NOW)).rejects.toThrow("Managed storage profile is unavailable");
  });

  it("captures only the historical profile and reuses it after credential rotation without mutation", async () => {
    const { sql, db, primaryReads } = fixture();
    const first = await ensureManagedBootstrapProfile(db, ENV, NOW);
    expect(first).toEqual({ id: "storage-profile:switchdrive:environment", configurationRevision: 1, namespaceIdentity: NAMESPACE });
    const before = rows(sql);
    const rotated = { ...ENV, SWITCHDRIVE_USERNAME: "rotated-user", SWITCHDRIVE_APP_PASSWORD: "rotated-password" };
    expect(await ensureManagedBootstrapProfile(db, rotated, "2026-09-14T13:00:00.000Z")).toEqual(first);
    expect(await assertManagedBootstrapProfile(db, rotated, first.id, 1)).toEqual(first);
    expect(primaryReads()).toBe(3);
    expect(rows(sql)).toEqual(before);
    expect(rows(sql)[0]).toMatchObject({ state: "historical", configuration_source: "environment",
      configuration_revision: 1, created_at: NOW, credential_reference: "environment:SWITCHDRIVE" });
    expect(JSON.stringify(rows(sql))).not.toContain(ENV.SWITCHDRIVE_APP_PASSWORD);
    expect(JSON.stringify(rows(sql))).not.toContain(ENV.SWITCHDRIVE_USERNAME);
    for (const table of ["files", "file_locations", "legacy_file_mappings"]) expect(sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
  });

  it("reuses a matching existing ID and already-primary session without requiring an alias", async () => {
    const { sql, session } = fixture();
    seed(sql, "previous-managed-inventory");
    expect((await ensureManagedBootstrapProfile(session, ENV, NOW)).id).toBe("previous-managed-inventory");
    expect(rows(sql)).toHaveLength(1);
  });

  it("rejects changed physical roots/accounts without adopting or rewriting the old profile", async () => {
    for (const changed of [{ ...ENV, SWITCHDRIVE_ROOT: "another-root" },
      { ...ENV, SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/another-account" }]) {
      const { sql, db } = fixture();
      seed(sql, "captured");
      const before = rows(sql);
      await expect(ensureManagedBootstrapProfile(db, changed, NOW)).rejects.toBeInstanceOf(ManagedBootstrapUnavailableError);
      await expect(assertManagedBootstrapProfile(db, changed, "captured", 1)).rejects.toBeInstanceOf(ManagedBootstrapUnavailableError);
      expect(rows(sql)).toEqual(before);
    }
  });

  it("reconciles an INSERT whose acknowledgement was lost using primary readback", async () => {
    const f = fixture();
    f.fail("after-run");
    expect((await ensureManagedBootstrapProfile(f.db, ENV, NOW)).namespaceIdentity).toBe(NAMESPACE);
    expect(rows(f.sql)).toHaveLength(1);
    expect(f.primaryReads()).toBe(1);
  });

  it.each(["before-run", "readback", "initial-read", "initial-result"] as const)("fails closed on %s without exposing database diagnostics", async (failure) => {
    const f = fixture();
    f.fail(failure);
    await expect(ensureManagedBootstrapProfile(f.db, ENV, NOW)).rejects.toThrow("Managed storage profile is unavailable");
    expect(rows(f.sql)).toHaveLength(failure === "readback" ? 1 : 0);
  });

  it("serializes concurrent first use and preserves the winning timestamp", async () => {
    const { sql, db } = fixture();
    const profiles = await Promise.all([ensureManagedBootstrapProfile(db, ENV, NOW),
      ensureManagedBootstrapProfile(db, ENV, "2026-09-14T13:00:00.000Z")]);
    expect(profiles[0]).toEqual(profiles[1]);
    expect(rows(sql)).toHaveLength(1);
    expect(rows(sql)[0].created_at).toBe(NOW);
  });

  it("reads the winning ID for same-namespace races and rejects a different namespace race", async () => {
    for (const namespace of [NAMESPACE, OTHER]) {
      const f = fixture();
      f.beforeRun(() => seed(f.sql, "race-winner", namespace));
      if (namespace === NAMESPACE) expect((await ensureManagedBootstrapProfile(f.db, ENV, NOW)).id).toBe("race-winner");
      else await expect(ensureManagedBootstrapProfile(f.db, ENV, NOW)).rejects.toBeInstanceOf(ManagedBootstrapUnavailableError);
      expect(rows(f.sql)).toHaveLength(1);
      expect(rows(f.sql)[0].namespace_identity).toBe(namespace);
    }
  });

  it("requires the captured exact profile and revision and validates timestamps before writes", async () => {
    const { sql, db } = fixture();
    for (const now of ["yesterday", "2026-02-30T12:00:00.000Z", "2026-09-14T12:00:00Z"]) {
      await expect(ensureManagedBootstrapProfile(db, ENV, now)).rejects.toBeInstanceOf(ManagedBootstrapUnavailableError);
    }
    expect(rows(sql)).toHaveLength(0);
    seed(sql, "captured");
    for (const [id, revision] of [["missing", 1], ["captured", 2], ["captured", NaN], ["captured\0", 1]] as const) {
      await expect(assertManagedBootstrapProfile(db, ENV, id, revision)).rejects.toBeInstanceOf(ManagedBootstrapUnavailableError);
    }
  });

  it("does not adopt malformed existing profile metadata", async () => {
    const captured = { id: "captured", adapter_type: "switchdrive", namespace_identity: NAMESPACE,
      configuration_source: "environment", credential_reference: "environment:SWITCHDRIVE", configuration_revision: 1, state: "historical" };
    for (const change of [{ id: "" }, { adapter_type: "r2" }, { configuration_source: "bootstrap" },
      { credential_reference: null }, { credential_reference: "private-token" }, { configuration_revision: 2 }, { state: "active" }]) {
      const db = { prepare: () => ({ bind: () => ({ first: async () => ({ ...captured, ...change }) }) }) } as unknown as D1Database;
      await expect(assertManagedBootstrapProfile(db, ENV, "captured", 1)).rejects.toBeInstanceOf(ManagedBootstrapUnavailableError);
    }
  });
});

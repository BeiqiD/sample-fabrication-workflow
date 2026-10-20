import { mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupQuiescedSqliteDatabase, shutdownQuiescedSqliteDatabase, SqliteCheckpointBusyError } from "./sqlite-backup";

const fixtures: Array<{ directory: string; database: DatabaseSync }> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.database.isOpen) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rt2-native-backup-"));
  const backups = join(directory, "backups"); await mkdir(backups);
  const path = join(directory, "source.sqlite");
  const database = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
  fixtures.push({ directory, database });
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=250;
    CREATE TABLE parents(id INTEGER PRIMARY KEY,label TEXT NOT NULL,payload BLOB);
    CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER NOT NULL REFERENCES parents(id),note TEXT NOT NULL);
    CREATE TABLE audit(parent_id INTEGER REFERENCES parents(id),label TEXT NOT NULL);
    CREATE TRIGGER parent_audit AFTER INSERT ON parents BEGIN INSERT INTO audit VALUES(NEW.id,NEW.label); END;
    INSERT INTO parents VALUES(1,'checkpointed-base',NULL); INSERT INTO children VALUES(1,1,'base-child');`);
  expect(database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy).toBe(0);
  const mainBytes = (await stat(path)).size;
  database.exec("BEGIN IMMEDIATE");
  database.prepare("INSERT INTO parents VALUES(2,'committed-in-live-wal',?)").run(new Uint8Array(32 * 1024).fill(7));
  database.exec("INSERT INTO children VALUES(2,2,'wal-child'); COMMIT");
  expect((await stat(path)).size).toBe(mainBytes);
  expect((await stat(`${path}-wal`)).size).toBeGreaterThan(32);
  return { directory, backups, path, database, mainBytes };
}
function options(directory: string, extra: { filename?: string; maxBytes?: number; pagesPerStep?: number } = {}) {
  return { directory, filename: "snapshot.sqlite", maxBytes: 1024 * 1024, pagesPerStep: 1, ...extra };
}
async function noPublication(directory: string) { expect(await readdir(directory)).toEqual([]); }

describe("native WAL-safe SQLite snapshot publication", () => {
  it("backs up actual committed live-WAL bytes into an internally consistent nonempty standalone file", async () => {
    const f = await fixture();
    const receipt = await backupQuiescedSqliteDatabase(f.database, options(f.backups));
    expect(receipt).toMatchObject({ path: join(f.backups, "snapshot.sqlite"), journalMode: "delete" });
    expect(receipt.pageCount * receipt.pageSize).toBe(receipt.byteLength);
    expect(receipt.byteLength).toBeGreaterThan(f.mainBytes);
    expect((await stat(f.path)).size).toBe(f.mainBytes);
    expect((await stat(`${f.path}-wal`)).size).toBeGreaterThan(32);
    expect(await readdir(f.backups)).toEqual(["snapshot.sqlite"]);
    expect((await stat(receipt.path)).mode & 0o777).toBe(0o600);
    f.database.close();
    const restored = new DatabaseSync(receipt.path, { readOnly: true, allowExtension: false });
    try {
      expect(restored.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("delete");
      expect(restored.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(restored.prepare("SELECT p.label,c.note,a.label audit_label FROM parents p JOIN children c ON c.parent_id=p.id JOIN audit a ON a.parent_id=p.id ORDER BY p.id").all())
        .toEqual([{ label: "checkpointed-base", note: "base-child", audit_label: "checkpointed-base" },
          { label: "committed-in-live-wal", note: "wal-child", audit_label: "committed-in-live-wal" }]);
      const payload = restored.prepare("SELECT payload FROM parents WHERE id=2").get()!.payload;
      expect(payload).toEqual(new Uint8Array(32 * 1024).fill(7));
    } finally { restored.close(); }
  });

  it.each(["file", "directory", "symlink"] as const)("never overwrites an existing %s destination", async kind => {
    const f = await fixture(), destination = join(f.backups, "snapshot.sqlite"), outside = join(f.directory, "outside.txt");
    await writeFile(outside, "outside-original");
    if (kind === "file") await writeFile(destination, "existing-original");
    else if (kind === "directory") await mkdir(destination);
    else await symlink(outside, destination);
    await expect(backupQuiescedSqliteDatabase(f.database, options(f.backups))).rejects.toThrow("already exists");
    expect(await readFile(outside, "utf8")).toBe("outside-original");
    if (kind === "file") expect(await readFile(destination, "utf8")).toBe("existing-original");
    expect(await readdir(f.backups)).toEqual(["snapshot.sqlite"]);
    expect((await lstat(destination)).isSymbolicLink()).toBe(kind === "symlink");
    expect(f.database.isOpen).toBe(true);
  });

  it("refuses a destination created by another publisher after private staging starts", async () => {
    const f = await fixture(), destination = join(f.backups, "snapshot.sqlite");
    let raced = false, raceFailure: unknown;
    const watcher = watch(f.backups, (_event, filename) => {
      if (raced || !filename?.toString().startsWith(".sqlite-backup-")) return;
      // Observing our owned scratch directory proves destination preflight
      // has completed. A new competing target must still survive publication.
      try { writeFileSync(destination, "competing-original", { flag: "wx" }); raced = true; }
      catch (error) { raceFailure = error; }
    });
    try {
      await expect(backupQuiescedSqliteDatabase(f.database, options(f.backups))).rejects.toMatchObject({ code: "EEXIST" });
      expect(raceFailure).toBeUndefined();
      expect(raced).toBe(true);
      expect(await readFile(destination, "utf8")).toBe("competing-original");
      expect(await readdir(f.backups)).toEqual(["snapshot.sqlite"]);
    } finally { watcher.close(); }
  });

  it("rejects source size and malformed ceilings before creating a partial artifact", async () => {
    const f = await fixture();
    await expect(backupQuiescedSqliteDatabase(f.database, options(f.backups, { maxBytes: 1 }))).rejects.toThrow("byte ceiling");
    for (const maxBytes of [0, -1, NaN, Infinity, 2 * 1024 * 1024 * 1024 + 1]) {
      await expect(backupQuiescedSqliteDatabase(f.database, options(f.backups, { maxBytes }))).rejects.toThrow(RangeError);
    }
    for (const pagesPerStep of [0, -1, 1.5, 257]) {
      await expect(backupQuiescedSqliteDatabase(f.database, options(f.backups, { pagesPerStep }))).rejects.toThrow(RangeError);
    }
    await noPublication(f.backups);
  });

  it("removes a real native backup rejected after the owned source closes", async () => {
    const f = await fixture();
    // Deliberately violate maintenance ownership between async directory checks
    // and native backup invocation to qualify failure cleanup, not safe sharing.
    const pending = backupQuiescedSqliteDatabase(f.database, options(f.backups));
    f.database.close();
    await expect(pending).rejects.toThrow(/closed|not open/i);
    await noPublication(f.backups);
  });

  it("rejects a real foreign-key-invalid snapshot without publishing partial data", async () => {
    const f = await fixture();
    f.database.exec("PRAGMA foreign_keys=OFF; INSERT INTO children VALUES(99,999,'invalid'); PRAGMA foreign_keys=ON");
    expect(f.database.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    await expect(backupQuiescedSqliteDatabase(f.database, options(f.backups))).rejects.toThrow("integrity check failed");
    await noPublication(f.backups);
    expect(f.database.isOpen).toBe(true);
  });

  it("rejects escaping names and symlink directories without touching their targets", async () => {
    const f = await fixture();
    for (const filename of ["", ".hidden", "..", "../escape.sqlite", "nested/snapshot.sqlite", "back\\slash", "nul\0name", "x".repeat(201)]) {
      await expect(backupQuiescedSqliteDatabase(f.database, options(f.backups, { filename }))).rejects.toThrow("backup filename");
    }
    const linked = join(f.directory, "linked-backups"); await symlink(f.backups, linked);
    await expect(backupQuiescedSqliteDatabase(f.database, options(linked))).rejects.toThrow("canonical backup directory");
    await noPublication(f.backups);
  });

  it("refuses unowned transactions and memory databases without committing or closing them", async () => {
    const f = await fixture(); f.database.exec("BEGIN IMMEDIATE");
    await expect(backupQuiescedSqliteDatabase(f.database, options(f.backups))).rejects.toThrow("without a transaction");
    expect(() => shutdownQuiescedSqliteDatabase(f.database)).toThrow("without a transaction");
    expect(f.database.isTransaction).toBe(true); expect(f.database.isOpen).toBe(true); f.database.exec("ROLLBACK");
    const memory = new DatabaseSync(":memory:", { allowExtension: false });
    try {
      await expect(backupQuiescedSqliteDatabase(memory, options(f.backups))).rejects.toThrow("WAL is required");
      expect(() => shutdownQuiescedSqliteDatabase(memory)).toThrow("WAL is required");
      expect(memory.isOpen).toBe(true);
    } finally { memory.close(); }
    await noPublication(f.backups);
  });
});

describe("quiesced checkpoint and shutdown", () => {
  it("keeps the writer open while a second connection pins an older reader, then checkpoints and closes after release", async () => {
    const f = await fixture();
    const reader = new DatabaseSync(f.path, { readOnly: true, allowExtension: false });
    try {
      reader.exec("BEGIN"); expect(reader.prepare("SELECT count(*) n FROM parents").get()!.n).toBe(2);
      f.database.exec("BEGIN IMMEDIATE; INSERT INTO parents VALUES(3,'after-reader',NULL); INSERT INTO children VALUES(3,3,'later-child'); COMMIT");
      const started = performance.now();
      let failure: unknown;
      try { shutdownQuiescedSqliteDatabase(f.database, { busyTimeoutMs: 50 }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(SqliteCheckpointBusyError);
      const receipt = (failure as SqliteCheckpointBusyError).checkpoint;
      expect(receipt.busy).toBe(1); expect(receipt.logFrames).toBeGreaterThan(receipt.checkpointedFrames);
      expect(performance.now() - started).toBeGreaterThanOrEqual(25);
      expect(performance.now() - started).toBeLessThan(1500);
      expect(f.database.isOpen).toBe(true); expect(f.database.isTransaction).toBe(false);
      expect(f.database.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(250);
      expect(f.database.prepare("SELECT count(*) n FROM parents").get()!.n).toBe(3);
      expect(reader.prepare("SELECT count(*) n FROM parents").get()!.n).toBe(2);
      reader.exec("ROLLBACK"); reader.close();
      expect(shutdownQuiescedSqliteDatabase(f.database, { busyTimeoutMs: 50 }))
        .toEqual({ busy: 0, logFrames: 0, checkpointedFrames: 0 });
      expect(f.database.isOpen).toBe(false);
      const reopened = new DatabaseSync(f.path, { readOnly: true, allowExtension: false });
      try {
        expect(reopened.prepare("SELECT count(*) n FROM parents").get()!.n).toBe(3);
        expect(reopened.prepare("SELECT count(*) n FROM children").get()!.n).toBe(3);
        expect(reopened.prepare("SELECT count(*) n FROM audit").get()!.n).toBe(3);
        expect(reopened.prepare("PRAGMA quick_check").get()!.quick_check).toBe("ok");
        expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { reopened.close(); }
    } finally { if (reader.isOpen) { if (reader.isTransaction) reader.exec("ROLLBACK"); reader.close(); } }
  });

  it("rejects malformed shutdown deadlines while leaving the owned connection and policy unchanged", async () => {
    const f = await fixture();
    for (const busyTimeoutMs of [0, -1, 1.5, NaN, 5001]) {
      expect(() => shutdownQuiescedSqliteDatabase(f.database, { busyTimeoutMs })).toThrow(RangeError);
    }
    expect(f.database.isOpen).toBe(true);
    expect(f.database.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(250);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { collectBlobGarbage } from "./gc";
import { claimBlobDeletion, isBlobReachable, listRetentionEdges, markOrphanCandidate } from "./reachability";
import { recoveryHoldsInstalled } from "./recovery-retention";
import type { BlobLocator } from "./types";

const OLD = "2026-08-01T00:00:00.000Z";
const NOW = new Date("2026-10-06T00:00:00.000Z");
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));

function fixture(throughMigration?: string) {
  const sql = referenceTestDatabase({ throughMigration }); databases.push(sql);
  const db = new SqliteD1Database(sql);
  const remove = vi.fn(async () => undefined), stat = vi.fn(async () => ({ outcome: "missing" as const }));
  return { sql, db, remove, stat, dependencies: { db, storage: { remove, stat }, newOperationId: () => "recovery-gc" } };
}

function source(f: ReturnType<typeof fixture>, storeKind: "r2" | "managed"): BlobLocator {
  const locator = { storeKind, provider: storeKind === "r2" ? "r2" : "switchdrive",
    objectKey: "retained/source.bin", blobRecordId: "source" } satisfies BlobLocator;
  if (storeKind === "r2") f.sql.prepare(`INSERT INTO assets
    (id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
    VALUES('source',?,'source.bin','application/octet-stream',4,'ready',?,?)`)
    .run(locator.objectKey, "a".repeat(64), OLD);
  else f.sql.prepare(`INSERT INTO managed_storage_objects
    (id,provider,object_key,original_name,mime_type,byte_size,sha256,status,created_at)
    VALUES('source',?,?,'source.bin','application/octet-stream',4,?,'ready',?)`)
    .run(locator.provider, locator.objectKey, "a".repeat(64), OLD);
  return locator;
}

function hold(f: ReturnType<typeof fixture>, locator: BlobLocator, jobId = "backup") {
  f.sql.prepare(`INSERT OR IGNORE INTO system_recovery_jobs
    (id,request_id,actor,kind,state,phase,input_json,accepted_at,updated_at)
    VALUES(?,?,'admin@example.test','backup','queued','snapshot','{}',?,?)`).run(jobId, jobId, OLD, OLD);
  f.sql.prepare("INSERT INTO system_recovery_legacy_holds(job_id,store_kind,provider,object_key) VALUES(?,?,?,?)")
    .run(jobId, locator.storeKind, locator.provider, locator.objectKey);
}

describe("system backup source retention", () => {
  it.each(["r2", "managed"] as const)("holds an otherwise orphaned %s source until explicit release", async storeKind => {
    const f = fixture(), locator = source(f, storeKind); hold(f, locator);
    expect(await isBlobReachable(f.db as unknown as D1Database, locator)).toBe(true);
    expect(await listRetentionEdges(f.db as unknown as D1Database, locator)).toEqual([
      expect.objectContaining({ store_kind: storeKind, provider: locator.provider, object_key: locator.objectKey,
        source_type: "system_recovery_backup", source_id: "backup", retention_reason: "system_recovery_source_hold" }),
    ]);
    expect(await markOrphanCandidate(f.db, locator, "marked", NOW)).toBe(false);
    expect(await collectBlobGarbage(f.dependencies, NOW)).toEqual({ orphanCandidatesMarked: 0, imageDeleted: 0, managedDeleted: 0, failures: 0 });
    expect(f.remove).not.toHaveBeenCalled(); expect(f.stat).not.toHaveBeenCalled();
    f.sql.prepare("UPDATE system_recovery_legacy_holds SET released_at=? WHERE job_id='backup'").run(NOW.toISOString());
    expect(await isBlobReachable(f.db as unknown as D1Database, locator)).toBe(false);
    expect((await collectBlobGarbage(f.dependencies, NOW)).orphanCandidatesMarked).toBe(1);
    expect((await collectBlobGarbage(f.dependencies, new Date(NOW.getTime() + 7 * 86400000)))[storeKind === "r2" ? "imageDeleted" : "managedDeleted"]).toBe(1);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(locator);
  });

  it.each(["r2", "managed"] as const)("arbitrates the exact %s hold and irreversible deletion claim in SQL", async storeKind => {
    const f = fixture(), locator = source(f, storeKind);
    await markOrphanCandidate(f.db, locator, "marked", new Date(OLD));
    // Mark after registration grace and age it without changing retention.
    await markOrphanCandidate(f.db, locator, "marked", new Date("2026-08-03T00:00:00.000Z"));
    hold(f, locator);
    expect(await claimBlobDeletion(f.db, locator, "delete", NOW)).toBeNull();
    f.sql.prepare("UPDATE system_recovery_legacy_holds SET released_at=? WHERE job_id='backup'").run(NOW.toISOString());
    expect(await claimBlobDeletion(f.db, locator, "delete", NOW)).not.toBeNull();
    expect(() => hold(f, locator, "late-backup")).toThrow();
    expect(() => f.sql.prepare("UPDATE system_recovery_legacy_holds SET released_at=NULL WHERE job_id='backup'").run()).toThrow();
    expect(f.sql.prepare("SELECT state FROM blob_gc_ledger").get()).toMatchObject({ state: "deleting" });
  });

  it("keeps store and provider identity distinct for the same object key", async () => {
    const f = fixture(), locator = source(f, "r2");
    hold(f, { ...locator, storeKind: "managed", provider: "switchdrive" });
    expect(await isBlobReachable(f.db as unknown as D1Database, locator)).toBe(false);
    expect((await collectBlobGarbage(f.dependencies, NOW)).orphanCandidatesMarked).toBe(1);
    expect((await collectBlobGarbage(f.dependencies, new Date(NOW.getTime() + 7 * 86400000))).imageDeleted).toBe(1);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(locator);
  });

  it("retains historical behavior but fails closed when recovery is configured without its hold table", async () => {
    const f = fixture("0020_fp4_research_packages.sql"), locator = source(f, "r2");
    expect(await recoveryHoldsInstalled(f.db)).toBe(false);
    expect(await recoveryHoldsInstalled(f.db, true)).toBeNull();
    expect(await collectBlobGarbage({ ...f.dependencies, recoveryRetentionRequired: true }, NOW))
      .toEqual({ orphanCandidatesMarked: 0, imageDeleted: 0, managedDeleted: 0, failures: 0 });
    expect(f.sql.prepare("SELECT count(*) n FROM blob_gc_ledger").get()!.n).toBe(0);
    expect(f.remove).not.toHaveBeenCalled();
    expect((await collectBlobGarbage(f.dependencies, NOW)).orphanCandidatesMarked).toBe(1);
    expect((await collectBlobGarbage(f.dependencies, new Date(NOW.getTime() + 7 * 86400000))).imageDeleted).toBe(1);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(locator);
  });
});

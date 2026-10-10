import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SqliteD1Database } from "../reference-test-support";
import { RECOVERY_MIGRATIONS } from "./trusted-schema";
import { installLegacySystemBackupHolds } from "./backup-holds-legacy-test-support";
import { installSystemBackupHolds } from "./backup-snapshot";
import { installPortableSystemBackupHolds } from "./portable-backup-holds";

it("preserves frozen seven-source UNION results on actual populated 22-migration files for both V1 and current hold readers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "historical-hold-equivalence-"));
  const at = "2026-10-10T12:00:00.000Z", results = [];
  try {
    for (const [index, installer] of [installLegacySystemBackupHolds, installSystemBackupHolds, installPortableSystemBackupHolds].entries()) {
      const native = new DatabaseSync(join(directory, `${index}.sqlite`));
      try {
        native.exec("PRAGMA foreign_keys=ON");
        for (const migration of RECOVERY_MIGRATIONS) {
          const sql = readFileSync(new URL(`../../migrations/${migration.name}`, import.meta.url), "utf8");
          expect(createHash("sha256").update(sql).digest("hex")).toBe(migration.sha256); native.exec(sql);
        }
        expect(native.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='local_accounts'").get()?.n).toBe(0);
        native.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('kept','KEPT','Retained',?,?)").run(at, at);
        native.prepare("INSERT INTO system_recovery_jobs(id,request_id,actor,kind,state,phase,input_json,accepted_at,updated_at) VALUES('proof','proof','admin@example.test','backup','queued','snapshot','{}',?,?)").run(at, at);
        for (const key of ["Kept-Source", "kept-source", "claimed-source"])
          native.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,created_at) VALUES(?,?,'source.bin','application/octet-stream',4,'ready',?)").run(key, key, at);
        native.prepare("INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at) VALUES('duplicate','kept','image','kept-source','{}',?)").run(at);
        native.prepare("INSERT INTO blob_gc_ledger(store_kind,provider,object_key,state,operation_id,orphaned_at,deletion_started_at,deleted_at,attempt_count,updated_at) VALUES('r2','r2','claimed-source','deleted','old-claim',?,?,?,1,?)").run(at, at, at, at);
        expect(native.prepare("SELECT first_state FROM file_shadow_legacy_deletion_claims WHERE object_key='claimed-source'").get()?.first_state).toBe("deleted");
        const db = new SqliteD1Database(native) as unknown as D1Database;
        await db.batch(installer(db, "proof", at)); await db.batch(installer(db, "proof", at));
        results.push(native.prepare("SELECT job_id,store_kind,provider,object_key,released_at FROM system_recovery_legacy_holds ORDER BY object_key").all());
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { native.close(); }
    }
    const expected = ["Kept-Source", "kept-source"].map(object_key => ({ job_id: "proof", store_kind: "r2", provider: "r2", object_key, released_at: null }));
    expect(results).toEqual([expected, expected, expected]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20_000);

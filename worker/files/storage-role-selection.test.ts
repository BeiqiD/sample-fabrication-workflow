import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilePurpose } from "../../shared/contracts/files";
import { SqliteD1Database } from "../reference-test-support";
import { futureActiveRuntimeDatabase } from "./authority-runtime-test-support";
import { readStorageRoleDefaults, StorageRoleDefaultsUnavailableError } from "./storage-role-defaults";
import { prepareStorageRoleAcceptanceModeFence, prepareStorageRoleSelection, resolveStorageRoleProfiles, roleForFilePurpose } from "./storage-role-selection";

const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "role-selection-assets" });
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function fixture() {
  const now = new Date().toISOString();
  const sql = futureActiveRuntimeDatabase(db => {
    db.prepare("INSERT INTO storage_profiles VALUES('existing-r2','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
    db.prepare("INSERT INTO file_shadow_profile_enablements VALUES('existing-r2',1,'role-selection-test',?)").run(now);
  }, { throughMigration: "0017_fp2_native_storage_profiles.sql" });
  databases.push(sql);
  return { sql, db: new SqliteD1Database(sql) as unknown as D1Database, env: { R2_BOOTSTRAP_NAMESPACE: namespace }, now };
}

describe("fresh acceptance storage role selection", () => {
  it("resolves all File purposes and rejects a whole-import target that cannot represent distinct role destinations", () => {
    const profiles = {
      internal: { id: "internal-r2", configurationRevision: 1 as const, namespaceIdentity: namespace },
      originals: { id: "originals-r2", configurationRevision: 1 as const, namespaceIdentity: namespace },
    };
    const purposes: FilePurpose[] = ["research_source", "provenance", "embedded_content", "derived_preview", "job_output"];
    const selection = resolveStorageRoleProfiles(purposes, profiles);
    for (const purpose of ["research_source", "provenance"] as const) {
      expect(roleForFilePurpose(purpose)).toBe("originals");
      expect(selection.profileFor(purpose).id).toBe("originals-r2");
    }
    for (const purpose of ["embedded_content", "derived_preview", "job_output"] as const) {
      expect(roleForFilePurpose(purpose)).toBe("internal");
      expect(selection.profileFor(purpose).id).toBe("internal-r2");
    }
    expect(() => selection.uniformProfile()).toThrow(StorageRoleDefaultsUnavailableError);
    const originals = resolveStorageRoleProfiles(["provenance", "research_source", "provenance"], profiles);
    profiles.originals.id = "later-destination";
    expect(originals.uniformProfile().id).toBe("originals-r2");
    expect(() => originals.profileFor("embedded_content")).toThrow(StorageRoleDefaultsUnavailableError);
  });

  it("fails closed on empty and unknown purpose input before consulting the database", async () => {
    const prepare = vi.fn();
    const db = { prepare } as unknown as D1Database;
    for (const purposes of [[], ["toString"], ["unknown"], ["embedded_content", null]] as unknown as FilePurpose[][]) {
      await expect(prepareStorageRoleSelection(db, { R2_BOOTSTRAP_NAMESPACE: namespace }, purposes, new Date().toISOString()))
        .rejects.toThrow(StorageRoleDefaultsUnavailableError);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("prepares the actual R2 destinations without writing defaults and rolls defaults back with rejected acceptance", async () => {
    const f = fixture();
    const selection = await prepareStorageRoleSelection(f.db, f.env, ["provenance", "embedded_content"], f.now);
    expect(selection.rolePolicyRevision).toBe(2);
    expect(selection.uniformProfile()).toEqual({ id: "existing-r2", configurationRevision: 1, namespaceIdentity: namespace });
    expect(await readStorageRoleDefaults(f.db)).toBeNull();
    await expect(f.db.batch([...selection.statements, f.db.prepare("SELECT json('rejected business acceptance')")])).rejects.toThrow();
    expect(await readStorageRoleDefaults(f.db)).toBeNull();
    await f.db.batch(selection.statements);
    expect(await readStorageRoleDefaults(f.db)).toMatchObject({
      internal: { storageProfileId: selection.profileFor("embedded_content").id, policyRevision: 2 },
      originals: { storageProfileId: selection.profileFor("provenance").id, policyRevision: 2 },
    });
  });

  it("rejects a prepared selection when runtime admission changes before the acceptance batch", async () => {
    const f = fixture();
    const selection = await prepareStorageRoleSelection(f.db, f.env, ["research_source"], f.now);
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    await expect(f.db.batch(selection.statements)).rejects.toThrow();
    expect(await readStorageRoleDefaults(f.db)).toBeNull();
    expect(f.sql.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id='existing-r2'").get()!.state).toBe("read_write");
  });

  it("fences the exact observed authority mode and rolls back earlier business statements on a stale mode", async () => {
    const f = fixture();
    f.sql.exec("CREATE TABLE mode_fence_business_receipts(id TEXT PRIMARY KEY)");
    await expect(f.db.batch([f.db.prepare("INSERT INTO mode_fence_business_receipts VALUES('must-rollback')"),
      prepareStorageRoleAcceptanceModeFence(f.db, "overlap")])).rejects.toThrow();
    expect(f.sql.prepare("SELECT count(*) AS count FROM mode_fence_business_receipts").get()!.count).toBe(0);
    await f.db.batch([prepareStorageRoleAcceptanceModeFence(f.db, "active"),
      f.db.prepare("INSERT INTO mode_fence_business_receipts VALUES('accepted')")]);
    expect(f.sql.prepare("SELECT id FROM mode_fence_business_receipts").get()!.id).toBe("accepted");
  });
});

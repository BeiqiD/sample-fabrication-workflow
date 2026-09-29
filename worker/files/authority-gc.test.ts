import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { collectBlobGarbage, runBlobGarbageCollection } from "../blob-lifecycle/gc";
import { findReusableManagedObject, findReusableR2Asset } from "../blob-lifecycle/reuse";
import type { Env } from "../types";
import { managedBootstrapNamespace } from "./managed-bootstrap-profile";
import { runFileGarbageCollection } from "./authority-gc";

const NOW = new Date("2026-09-29T00:00:00.000Z");
const OLD = "2026-09-01T00:00:00.000Z";
const SHA = "a".repeat(64);
const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "runtime-files" });
const later = (days: number, minutes = 0) => new Date(NOW.getTime() + days * 86400000 + minutes * 60000);
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); });

function fixture(options: { ready?: boolean; managed?: boolean; mode?: "active" | "overlap"; hold?: boolean;
  setup?: (sql: ReturnType<typeof referenceTestDatabase>) => void } = {}) {
  const sql = referenceTestDatabase(); databases.push(sql);
  const db = new SqliteD1Database(sql);
  const remove = vi.fn(async () => undefined);
  const head = vi.fn(async () => null);
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetch);
  const env = {
    DB: db as unknown as D1Database, ASSETS: { delete: remove, head } as unknown as R2Bucket,
    R2_BOOTSTRAP_NAMESPACE: namespace, MANAGED_STORAGE_PROVIDER: "switchdrive",
    SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
    SWITCHDRIVE_USERNAME: "user@example.ch", SWITCHDRIVE_APP_PASSWORD: "fixture-only",
  } satisfies Env;
  // Model a future active database without adding an activation path. All
  // production lifecycle guards are reinstalled before any collector executes.
  const triggers = sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as { name: string; sql: string }[];
  for (const trigger of triggers) sql.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  sql.prepare("UPDATE file_authority_control SET mode=?,activated_at=?,updated_at=?")
    .run(options.mode ?? "active", NOW.toISOString(), NOW.toISOString());
  sql.prepare(`INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
    VALUES('profile',?,?,?,?,1,'historical',?)`).run(options.managed ? "switchdrive" : "r2",
    options.managed ? managedBootstrapNamespace(env) : namespace, options.managed ? "environment" : "bootstrap",
    options.managed ? "environment:SWITCHDRIVE" : null, OLD);
  sql.prepare("INSERT INTO storage_profile_runtime VALUES('profile','read_write',?,?,NULL)").run(OLD, OLD);
  sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES('file','embedded_content','system',4,?,'unresolved',?)").run(SHA, OLD);
  sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES('location','file','profile','owned/file','unresolved',?)").run(OLD);
  sql.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,
    verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
    VALUES('location','file','profile','owned/file',4,?,'full_read_sha256','verified',?,?)`).run(SHA, OLD, OLD);
  if (options.ready) sql.prepare(`INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at)
    VALUES('file','embedded_content','system',4,?,'location','ready',?)`).run(SHA, OLD);
  if (options.hold) sql.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
    VALUES('hold','location','operator','hold-operation','retained by operator',?)`).run(OLD);
  // A namespace-less legacy registry must not drive active deletion/dedup.
  sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
    VALUES('legacy','owned/file','file.png','image/png',4,'ready',?,?)`).run(SHA, OLD);
  options.setup?.(sql);
  for (const trigger of triggers) sql.exec(trigger.sql);
  return { sql, db, env, remove, head, fetch,
    ledger: () => sql.prepare("SELECT * FROM file_location_gc_ledger WHERE location_id='location'").get() };
}

describe("active File location garbage collection", () => {
  it("protects a retained ready File even when quarantined and legacy GC/dedup are called directly", async () => {
    const f = fixture({ ready: true, hold: true });
    f.sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,expected_sha256,operation_id,detected_at,last_checked_at)
      VALUES('location','missing',4,?,'quarantine',?,?)`).run(SHA, OLD, OLD);
    expect(await runBlobGarbageCollection(f.env, NOW)).toEqual({ orphanCandidatesMarked: 0, imageDeleted: 0, managedDeleted: 0, failures: 0 });
    const storage = { remove: vi.fn(), stat: vi.fn() };
    await collectBlobGarbage({ db: f.db, storage, newOperationId: () => "legacy-gc" }, NOW);
    expect(f.ledger()).toBeUndefined();
    expect(f.sql.prepare("SELECT COUNT(*) n FROM blob_gc_ledger").get()!.n).toBe(0);
    await expect(findReusableR2Asset(f.env, SHA)).rejects.toThrow("purpose-scoped File reuse");
    await expect(findReusableManagedObject(f.env, "switchdrive", SHA, 4)).rejects.toThrow("purpose-scoped File reuse");
    expect(storage.remove).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.head).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("settles terminal candidates and retires unretained Files before orphan grace, preserving pending and unknown receipts", async () => {
    const receiptIds = { terminal: crypto.randomUUID(), pending: crypto.randomUUID(), unknown: crypto.randomUUID() };
    const f = fixture({ ready: true, hold: true, setup(sql) {
      for (const [name, id] of Object.entries(receiptIds)) {
        sql.prepare(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
          VALUES(?,'embedded_content','system',4,?,'unresolved',?)`).run(name, SHA, OLD);
        sql.prepare(`INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
          VALUES(?,?,'profile',?,'unresolved',?)`).run(name, name, `owned/${name}`, OLD);
        if (name !== "unknown") sql.prepare(`INSERT INTO r2_upload_requests(id,actor_email,client_request_id,operation_id,
          ingress,purpose,request_sha256,request_input_json,request_scope,storage_profile_id,storage_profile_revision,
          storage_policy_revision,candidate_asset_id,candidate_object_key,status,created_at,expires_at)
          VALUES(?,'operator@example.test',?,?,'ordinary_image','embedded_content',?,?,'system','profile',1,1,?,?,'pending',?,?)`)
          .run(id, crypto.randomUUID(), crypto.randomUUID(), SHA,
            JSON.stringify({ file: { byteSize: 4, sha256: SHA } }), crypto.randomUUID(), `owned/${name}`,
            OLD, "2026-09-02T00:00:00.000Z");
        sql.prepare(`INSERT INTO file_acceptance_candidates(acceptance_kind,acceptance_id,item_id,purpose,access_scope,
          storage_profile_id,expected_byte_size,expected_sha256,candidate_file_id,candidate_location_id,
          candidate_object_key,state,created_at)
          VALUES('r2_upload',?,'','embedded_content','system','profile',4,?,?,?,?,'candidate',?)`)
          .run(id, SHA, name, name, `owned/${name}`, OLD);
      }
    } });
    expect((await runFileGarbageCollection(f.env, NOW)).orphanCandidatesMarked).toBe(0);
    f.sql.prepare("UPDATE r2_upload_requests SET status='failed',completed_at=? WHERE id=?")
      .run(NOW.toISOString(), receiptIds.terminal);
    f.sql.prepare("UPDATE file_location_holds SET released_at=? WHERE id='hold'").run(NOW.toISOString());
    expect((await runFileGarbageCollection(f.env, NOW)).orphanCandidatesMarked).toBe(2);
    expect(f.sql.prepare("SELECT state,active_location_id FROM file_publications WHERE file_id='file'").get())
      .toMatchObject({ state: "retired", active_location_id: null });
    expect(f.sql.prepare("SELECT candidate_file_id,state FROM file_acceptance_candidates ORDER BY candidate_file_id").all())
      .toEqual([{ candidate_file_id: "pending", state: "candidate" },
        { candidate_file_id: "terminal", state: "cancelled" }, { candidate_file_id: "unknown", state: "candidate" }]);
    expect((await runFileGarbageCollection(f.env, later(6))).imageDeleted).toBe(0);
    expect((await runFileGarbageCollection(f.env, later(7))).imageDeleted).toBe(2);
    expect(f.remove).toHaveBeenCalledTimes(2);
    expect(f.remove).toHaveBeenCalledWith("owned/file");
    expect(f.remove).toHaveBeenCalledWith("owned/terminal");
    expect(f.sql.prepare("SELECT location_id FROM file_location_gc_ledger ORDER BY location_id").all())
      .toEqual([{ location_id: "location" }, { location_id: "terminal" }]);
    expect(f.sql.prepare("SELECT status FROM r2_upload_requests WHERE id=?").get(receiptIds.pending))
      .toMatchObject({ status: "pending" });
  });

  it("preserves registration and orphan grace before deleting only the frozen location", async () => {
    const f = fixture();
    expect((await runFileGarbageCollection(f.env, new Date(OLD))).orphanCandidatesMarked).toBe(0);
    expect((await runBlobGarbageCollection(f.env, NOW)).orphanCandidatesMarked).toBe(1);
    expect((await runFileGarbageCollection(f.env, later(6))).imageDeleted).toBe(0);
    expect((await runFileGarbageCollection(f.env, later(7))).imageDeleted).toBe(1);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith("owned/file");
    expect(f.ledger()).toMatchObject({ state: "deleted", attempt_count: 1, deleted_at: later(7).toISOString() });
    expect((await runFileGarbageCollection(f.env, later(8))).imageDeleted).toBe(0);
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  it.each([{ mode: "overlap" as const }, { hold: true }])("does not collect without active authority or while held: %j", async options => {
    const f = fixture(options);
    expect((await runFileGarbageCollection(f.env, NOW)).orphanCandidatesMarked).toBe(0);
    expect(f.ledger()).toBeUndefined(); expect(f.remove).not.toHaveBeenCalled();
  });

  it("fails closed on a changed namespace and does not expose provider/configuration errors", async () => {
    const f = fixture();
    await runFileGarbageCollection(f.env, NOW);
    f.env.R2_BOOTSTRAP_NAMESPACE = namespace.replace("runtime-files", "other-files");
    expect((await runFileGarbageCollection(f.env, later(7))).failures).toBe(1);
    expect(f.ledger()).toMatchObject({ state: "deleting", last_error: "deletion_unavailable" });
    expect(f.remove).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled();
  });

  it("keeps uncertain deletion fenced and observes a stale lease before retrying", async () => {
    const f = fixture();
    f.remove.mockRejectedValueOnce(new Error("private provider details"));
    await runFileGarbageCollection(f.env, NOW);
    expect((await runFileGarbageCollection(f.env, later(7))).failures).toBe(1);
    expect(f.ledger()).toMatchObject({ state: "deleting", attempt_count: 1, last_error: "deletion_unavailable" });
    await runFileGarbageCollection(f.env, later(7, 14));
    expect(f.head).not.toHaveBeenCalled();
    f.head.mockRejectedValueOnce(new Error("provider outage"));
    expect((await runFileGarbageCollection(f.env, later(7, 16))).failures).toBe(1);
    expect(f.ledger()).toMatchObject({ state: "deleting", attempt_count: 2, last_error: "deletion_confirmation_unavailable" });
    expect((await runFileGarbageCollection(f.env, later(7, 32))).imageDeleted).toBe(1);
    expect(f.ledger()).toMatchObject({ state: "deleted", attempt_count: 3 });
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  it("does not let an old DELETE acknowledgement finalize a reclaimed lease", async () => {
    const f = fixture();
    await runFileGarbageCollection(f.env, NOW);
    f.remove.mockImplementationOnce(async () => {
      f.sql.prepare(`UPDATE file_location_gc_ledger SET attempt_count=attempt_count+1,
        deletion_started_at=?,updated_at=? WHERE location_id='location'`)
        .run(later(7, 16).toISOString(), later(7, 16).toISOString());
    });
    expect((await runFileGarbageCollection(f.env, later(7))).failures).toBe(1);
    expect(f.ledger()).toMatchObject({ state: "deleting", attempt_count: 2, deleted_at: null, last_error: null });
    expect((await runFileGarbageCollection(f.env, later(7, 32))).imageDeleted).toBe(1);
    expect(f.remove).toHaveBeenCalledTimes(1);
  });

  it("resolves managed deletion through the persisted endpoint/account/root profile", async () => {
    const f = fixture({ managed: true });
    await runFileGarbageCollection(f.env, NOW);
    expect((await runFileGarbageCollection(f.env, later(7))).managedDeleted).toBe(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(String(f.fetch.mock.calls[0][0])).toContain("/owned/file");
    expect(f.fetch.mock.calls[0][1]).toMatchObject({ method: "DELETE", redirect: "manual" });
    expect(f.remove).not.toHaveBeenCalled();
  });
});

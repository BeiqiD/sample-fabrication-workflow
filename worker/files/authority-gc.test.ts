import worker from "../index";
import { acceptAndUploadR2Asset } from "../uploads/r2-upload-acceptance";
import { futureActiveRuntimeDatabase } from "./authority-runtime-test-support";
import { snapshotFullExportV20 } from "../export-v20-snapshot";
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
  sql.prepare("UPDATE file_authority_runtime_guard SET incarnation='gc-test',enabled=1,enabled_by='test',updated_at=?").run(NOW.toISOString());
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

  it("keeps an acknowledged DELETE uncertain when execution is paused before finalization", async () => {
    const f = fixture();
    await runFileGarbageCollection(f.env, NOW);
    f.remove.mockImplementationOnce(async () => {
      f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    });
    await expect(runFileGarbageCollection(f.env, later(7))).resolves.toEqual({
      orphanCandidatesMarked: 0, imageDeleted: 0, managedDeleted: 0, failures: 1,
    });
    expect(f.remove).toHaveBeenCalledExactlyOnceWith("owned/file");
    expect(f.ledger()).toMatchObject({ state: "deleting", attempt_count: 1, deleted_at: null, last_error: null });
    expect((await runFileGarbageCollection(f.env, later(7, 16))).failures).toBe(0);
    expect(f.head).not.toHaveBeenCalled();
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it.each(["HEAD", "DELETE"] as const)("rejects an old %s result after execution resumes with a fresh incarnation", async phase => {
    const f = fixture();
    await runFileGarbageCollection(f.env, NOW);
    const replaceExecution = () => {
      // These transitions use the installed local-runtime admission guard. A
      // paused active installation can explicitly admit a fresh incarnation.
      f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
      f.sql.prepare("UPDATE file_authority_runtime_guard SET enabled=1,incarnation='gc-next',updated_at=?")
        .run(later(7, 16).toISOString());
    };
    if (phase === "HEAD") {
      f.remove.mockRejectedValueOnce(new Error("uncertain fixture DELETE"));
      expect((await runFileGarbageCollection(f.env, later(7))).failures).toBe(1);
      f.head.mockImplementationOnce(async () => { replaceExecution(); return null; });
    } else f.remove.mockImplementationOnce(async () => { replaceExecution(); });
    const result = await runFileGarbageCollection(f.env, phase === "HEAD" ? later(7, 16) : later(7));
    expect(result).toMatchObject({ imageDeleted: 0, managedDeleted: 0, failures: 1 });
    expect(f.sql.prepare("SELECT incarnation,enabled FROM file_authority_runtime_guard").get())
      .toEqual({ incarnation: "gc-next", enabled: 1 });
    expect(f.ledger()).toMatchObject({ state: "deleting", attempt_count: phase === "HEAD" ? 2 : 1,
      deleted_at: null, last_error: null });
    expect(f.remove).toHaveBeenCalledExactlyOnceWith("owned/file");
    expect(f.head).toHaveBeenCalledTimes(phase === "HEAD" ? 1 : 0);
    // Only a later run under the new incarnation can reconcile the original
    // location, using a stale-lease HEAD without repeating its DELETE.
    expect((await runFileGarbageCollection(f.env, later(7, 32))).imageDeleted).toBe(1);
    expect(f.ledger()).toMatchObject({ state: "deleted", attempt_count: phase === "HEAD" ? 3 : 2 });
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it("rechecks a late File hold in a fresh primary session at the bound deletion callback", async () => {
    const f = fixture({ ready: true });
    await runFileGarbageCollection(f.env, NOW);
    expect(f.sql.prepare("SELECT state FROM file_publications WHERE file_id='file'").get()!.state).toBe("retired");
    const guardedSessions: Array<{ id: number; kind: string }> = [];
    let nextSession = 0, deleteProfileChecked = false, holdInserted = false;
    const withSession = vi.fn((constraint: string) => {
      expect(constraint).toBe("first-primary");
      const session = { id: ++nextSession, executed: 0 };
      const wrap = (query: string, statement: D1PreparedStatement): D1PreparedStatement => {
        const observe = () => {
          const kind = query.includes("SELECT 1 AS writable") ? "profile"
            : /^SELECT 1 FROM file_location_gc_ledger/.test(query) ? "claim"
              : /^UPDATE file_location_gc_ledger SET last_error=/.test(query) ? "failure" : null;
          if (kind) {
            // A Session's first-primary constraint applies to its first query.
            // Reusing the run's Session here would not prove current ownership.
            expect(session.executed).toBe(0);
            guardedSessions.push({ id: session.id, kind });
          }
          session.executed++;
          if (kind === "profile") deleteProfileChecked = true;
          else if (kind === "claim" && deleteProfileChecked && !holdInserted) {
            // A retired File can receive an operator hold. Add it after the
            // outer GC checks, immediately before the bound deleter's callback.
            f.sql.prepare(`INSERT INTO file_holds(id,file_id,hold_kind,operation_id,reason,acquired_at)
              VALUES('late-hold','file','operator','late-hold-operation','retain retired File',?)`)
              .run(later(7).toISOString());
            holdInserted = true;
          }
        };
        return {
          bind: (...values: unknown[]) => wrap(query, statement.bind(...values)),
          async first<T>(column?: string) { observe(); return statement.first<T>(column); },
          async all<T>() { observe(); return statement.all<T>(); },
          async run<T>() { observe(); return statement.run<T>(); },
          execute() { observe(); return (statement as unknown as { execute(): unknown }).execute(); },
        } as D1PreparedStatement;
      };
      return {
        prepare: (query: string) => wrap(query, f.db.prepare(query) as unknown as D1PreparedStatement),
        batch: (statements: D1PreparedStatement[]) => { session.executed++; return f.db.batch(statements); },
      };
    });
    f.env.DB = { withSession } as unknown as D1Database;
    expect(await runFileGarbageCollection(f.env, later(7))).toMatchObject({ imageDeleted: 0, failures: 1 });
    expect(holdInserted).toBe(true);
    expect(guardedSessions.map(session => session.kind)).toEqual(["claim", "claim", "profile", "claim", "failure"]);
    expect(new Set(guardedSessions.map(session => session.id)).size).toBe(guardedSessions.length);
    expect(f.sql.prepare("SELECT released_at FROM file_holds WHERE id='late-hold'").get()!.released_at).toBeNull();
    expect(f.ledger()).toMatchObject({ state: "deleting", attempt_count: 1, deleted_at: null, last_error: null });
    expect(f.remove).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled();
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


it("releases explicitly detached event and verification bytes while keeping typed tombstones exportable", async () => {
  const now = new Date().toISOString();
  const sql = futureActiveRuntimeDatabase(database => {
    database.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
    database.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'operator',?)").run(now);
  });
  databases.push(sql);
  const db = new SqliteD1Database(sql) as unknown as D1Database;
  const stored = new Map<string, Uint8Array>();
  const get = async (key: string) => {
    const bytes = stored.get(key);
    return bytes ? { body: new Response(bytes).body!, size: bytes.length, httpEtag: '"file"', writeHttpMetadata() {} } : null;
  };
  const remove = vi.fn(async (key: string) => { stored.delete(key); });
  const env = { AUTH_MODE: "disabled", DB: db, R2_BOOTSTRAP_NAMESPACE: namespace,
    ASSETS: { get, head: get, delete: remove, async put(key: string, bytes: ArrayBuffer) { stored.set(key, new Uint8Array(bytes.slice(0))); } } as unknown as R2Bucket,
  } satisfies Env;
  const uploaded = await acceptAndUploadR2Asset(env, { actorEmail: "owner@example.test", requestId: crypto.randomUUID(),
    ingress: "ordinary_image", originalName: "evidence.png", mimeType: "image/png", bytes: Uint8Array.of(137,80,78,71).buffer });
  if (uploaded.state.status !== "ready") throw new Error("File did not publish");
  const { id: assetId, key: assetKey } = uploaded.state.result;
  const fileId = String(sql.prepare("SELECT result_file_id FROM file_acceptance_candidates").get()!.result_file_id);
  sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','Family','process',?)").run(now);
  sql.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at)
    VALUES('template','family','Template','process',1,'manifest','{}',?)`).run(now);
  sql.prepare("INSERT INTO samples(id,code,title,status,created_at,updated_at) VALUES('sample','S1','Sample','stored',?,?)").run(now, now);
  sql.prepare(`INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,
    template_name_snapshot,template_type_snapshot,template_version_snapshot,status,created_at,run_kind)
    VALUES('run','sample','family','template',1,'group','Template','process',1,'active',?,'process')`).run(now);
  sql.prepare(`INSERT INTO run_steps(id,run_id,position,origin,plan_status,title,status,entry_kind,created_at,updated_at)
    VALUES('step','run',1000,'ad_hoc','current','Step','pending','fabrication',?,?)`).run(now, now);
  sql.prepare(`INSERT INTO state_verifications(id,sample_id,after_run_step_id,result,evidence_asset_id,evidence_file_id,created_at)
    VALUES('verification','sample','step','matched',?,?,?)`).run(assetId, fileId, now);
  sql.prepare(`INSERT INTO events(id,sample_id,kind,body,asset_key,asset_file_id,metadata_json,created_at)
    VALUES('record','sample','image','Record',?,?,?,?),('evidence','sample','verification','Evidence',?,?,?,?)`)
    .run(assetKey, fileId, JSON.stringify({ action: "sample_record" }), now,
      assetKey, fileId, JSON.stringify({ verificationId: "verification" }), now);
  expect(sql.prepare("SELECT COUNT(*) n FROM file_direct_retention_edges WHERE file_id=?").get(fileId)!.n).toBe(2);
  const afterRegistration = new Date(Date.parse(now) + 2 * 86400000);
  const afterOrphanGrace = new Date(Date.parse(now) + 9 * 86400000);
  sql.prepare("UPDATE samples SET deleted_at=?,deleted_by='operator' WHERE id='sample'").run(now);
  expect((await runFileGarbageCollection(env, afterRegistration)).orphanCandidatesMarked).toBe(0);
  sql.prepare("UPDATE samples SET deleted_at=NULL,deleted_by=NULL WHERE id='sample'").run();
  const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const removeAt = async (path: string) => {
    const response = await worker.fetch(new Request(`https://app.test/api${path}`, { method: "DELETE" }), env, context);
    expect(response.status, await response.clone().text()).toBe(200);
  };
  await removeAt("/samples/sample/records/record");
  expect((await runFileGarbageCollection(env, afterRegistration)).orphanCandidatesMarked).toBe(0);
  await removeAt("/samples/sample/events/evidence/asset");
  expect(sql.prepare("SELECT COUNT(*) n FROM file_retention_edges WHERE file_id=?").get(fileId)!.n).toBe(0);
  expect(sql.prepare("SELECT COUNT(*) n FROM blob_retention_edges WHERE object_key=?").get(assetKey)!.n).toBe(0);
  expect((await runFileGarbageCollection(env, afterRegistration)).orphanCandidatesMarked).toBe(1);
  expect(sql.prepare("SELECT state FROM file_publications WHERE file_id=?").get(fileId)!.state).toBe("retired");
  expect((await runFileGarbageCollection(env, afterOrphanGrace)).imageDeleted).toBe(1);
  expect(remove).toHaveBeenCalledExactlyOnceWith(assetKey);
  expect(sql.prepare("SELECT asset_file_id,asset_key FROM events WHERE id IN ('record','evidence') ORDER BY id").all())
    .toEqual([{ asset_file_id: fileId, asset_key: assetKey }, { asset_file_id: fileId, asset_key: assetKey }]);
  expect(sql.prepare("SELECT evidence_file_id,evidence_asset_id FROM state_verifications").get())
    .toEqual({ evidence_file_id: fileId, evidence_asset_id: assetId });
  const exported = await snapshotFullExportV20(db);
  expect(exported.tables.file_publications[0].state).toBe("retired");
  expect(exported.tables.events.filter(event => ["record", "evidence"].includes(String(event.id)))
    .every(event => event.asset_file_id === fileId)).toBe(true);
}, 15_000);

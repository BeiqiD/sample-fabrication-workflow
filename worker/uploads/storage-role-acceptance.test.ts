import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableFutureFileAuthority, futureActiveRuntimeDatabase } from "../files/authority-runtime-test-support";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { acceptAndUploadR2Asset, rethrowR2UploadError } from "./r2-upload-acceptance";
import { acceptAndUploadMetrologyReference, rethrowMetrologyReferenceUploadError } from "./metrology-reference-acceptance";

const namespace = JSON.stringify({ kind: "local-r2", installationId: "1fc3f0ab-b7ca-4ca9-8b79-27c447d6ed4f", bucketName: "role-acceptance" });
const bytes = new TextEncoder().encode("role-selected acceptance bytes");
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); });
type Ingress = "ordinary_image" | "project_attachment" | "metrology_reference";
const ingresses: Ingress[] = ["ordinary_image", "project_attachment", "metrology_reference"];

function fixture(ingress: Ingress, active = true) {
  const now = new Date().toISOString();
  const prepareOverlap = (sql: DatabaseSync) => {
    sql.prepare("INSERT INTO storage_profiles VALUES('selected-r2','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
    sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('selected-r2',1,'acceptance-test',?)").run(now);
    sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','Family','module',?)").run(now);
    sql.prepare(`INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at,template_kind)
      VALUES('template','family','Metrology','module',1,'manifest','{}',?,'metrology')`).run(now);
  };
  let sql: DatabaseSync;
  if (active) sql = futureActiveRuntimeDatabase(prepareOverlap);
  else {
    sql = referenceTestDatabase();
    sql.exec("PRAGMA foreign_keys=ON");
    sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'acceptance-test',? FROM file_shadow_control").run(now);
    prepareOverlap(sql);
  }
  databases.push(sql);
  const adapter = new SqliteD1Database(sql);
  let failDefaultReads = false;
  let loseAcceptanceAcknowledgement = false;
  let beforeAcceptance: (() => void) | undefined;
  const table = ingress === "metrology_reference" ? "metrology_reference_upload_requests" : "r2_upload_requests";
  const db = {
    prepare(query: string) {
      if (failDefaultReads && query.includes("storage_role_defaults")) throw new Error("private defaults unavailable");
      const statement = adapter.prepare(query);
      if (!query.startsWith(`INSERT INTO ${table}`)) return statement;
      const wrap = (current: typeof statement): unknown => ({
        bind: (...args: unknown[]) => wrap(current.bind(...args)),
        async run() { const hook = beforeAcceptance; beforeAcceptance = undefined; hook?.(); return current.run(); },
        execute: () => current.execute(),
      });
      return wrap(statement);
    },
    async batch(statements: D1PreparedStatement[]) {
      if (beforeAcceptance) { const hook = beforeAcceptance; beforeAcceptance = undefined; hook(); }
      const result = await adapter.batch(statements);
      if (loseAcceptanceAcknowledgement) { loseAcceptanceAcknowledgement = false; throw new Error("private lost acceptance batch acknowledgement"); }
      return result;
    },
    withSession(constraint: string) { expect(constraint).toBe("first-primary"); return db; },
  } as unknown as D1Database;
  const stored = new Map<string, Uint8Array>();
  const get = vi.fn(async (key: string) => {
    const value = stored.get(key);
    return value ? { body: new Response(value).body!, size: value.length, httpEtag: '"roles"', writeHttpMetadata() {} } : null;
  });
  const put = vi.fn(async (key: string, body: BodyInit) => { stored.set(key, new Uint8Array(await new Response(body).arrayBuffer())); });
  const remove = vi.fn(async (key: string | string[]) => {
    for (const objectKey of typeof key === "string" ? [key] : key) stored.delete(objectKey);
  });
  const env = { DB: db, R2_BOOTSTRAP_NAMESPACE: namespace, ASSETS: { get, head: get, put, delete: remove } as unknown as R2Bucket } satisfies Env;
  const requestId = crypto.randomUUID();
  const upload = (id = requestId, name = "input.bin") => {
    const input = { requestId: id, actorEmail: "owner@example.test", originalName: name, mimeType: ingress === "ordinary_image" ? "image/png" : "application/octet-stream", bytes: bytes.buffer };
    return ingress === "metrology_reference"
      ? acceptAndUploadMetrologyReference(env, { ...input, templateId: "template" })
      : acceptAndUploadR2Asset(env, { ...input, ingress });
  };
  const classify = (error: unknown) => {
    try { if (ingress === "metrology_reference") rethrowMetrologyReferenceUploadError(error); else rethrowR2UploadError(error); }
    catch (classified) { return classified; }
  };
  return { sql, env, table, upload, put, get, classify, requestId,
    failDefaultReads: () => { failDefaultReads = true; },
    loseAcceptanceAcknowledgement: () => { loseAcceptanceAcknowledgement = true; },
    beforeAcceptance: (hook: () => void) => { beforeAcceptance = hook; },
  };
}

describe("fresh upload role selection", () => {
  it.each(ingresses)("freezes the selected %s target and replays without looking up current defaults", async ingress => {
    const f = fixture(ingress);
    const first = await f.upload();
    expect(first.state.status).toBe("ready");
    const row = f.sql.prepare(`SELECT * FROM ${f.table}`).get()!;
    expect(row).toMatchObject({ storage_profile_id: "selected-r2", storage_profile_revision: 1, storage_policy_revision: 1, role_policy_revision: 3,
      purpose: ingress === "ordinary_image" ? "embedded_content" : "research_source" });
    expect(f.sql.prepare("SELECT role,storage_profile_id,policy_revision FROM storage_role_defaults ORDER BY role").all())
      .toEqual([{ role: "internal", storage_profile_id: "selected-r2", policy_revision: 3 }, { role: "originals", storage_profile_id: "selected-r2", policy_revision: 3 }]);
    expect(f.sql.prepare("SELECT storage_profile_id FROM file_acceptance_candidates").get()!.storage_profile_id).toBe("selected-r2");
    f.failDefaultReads();
    expect(await f.upload()).toEqual({ ...first, fresh: false });
    await expect(f.upload(f.requestId, "changed.bin")).rejects.toMatchObject({ name: ingress === "metrology_reference" ? "MetrologyReferenceUploadConflictError" : "R2UploadRequestConflictError" });
    expect(f.sql.prepare(`SELECT * FROM ${f.table}`).get()).toEqual(row);
    expect(f.put).toHaveBeenCalledOnce();
  });

  it.each(ingresses)("reconciles a committed %s acceptance after its batch acknowledgement is lost", async ingress => {
    const f = fixture(ingress);
    f.loseAcceptanceAcknowledgement();
    const first = await f.upload();
    expect(first.state.status).toBe("ready");
    expect(await f.upload()).toEqual({ ...first, fresh: false });
    expect(f.sql.prepare(`SELECT count(*) n FROM ${f.table}`).get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()!.n).toBe(2);
    expect(f.put).toHaveBeenCalledOnce();
  });

  it.each(ingresses)("rolls both role rows back when %s business acceptance is rejected", async ingress => {
    const f = fixture(ingress);
    f.sql.exec(`CREATE TRIGGER reject_acceptance BEFORE INSERT ON ${f.table} BEGIN SELECT RAISE(ABORT,'private rejected acceptance'); END;`);
    await expect(f.upload()).rejects.toMatchObject({ name: ingress === "metrology_reference" ? "MetrologyReferenceUploadUnavailableError" : "R2UploadAcceptanceUnavailableError" });
    expect(f.sql.prepare("SELECT * FROM storage_role_defaults").all()).toEqual([]);
    expect(f.sql.prepare(`SELECT * FROM ${f.table}`).all()).toEqual([]);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });

  it.each(ingresses)("rolls both role rows back when %s business acceptance is silently suppressed", async ingress => {
    const f = fixture(ingress);
    f.sql.exec(`CREATE TRIGGER suppress_acceptance BEFORE INSERT ON ${f.table} BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(f.upload()).rejects.toMatchObject({ name: ingress === "metrology_reference" ? "MetrologyReferenceUploadUnavailableError" : "R2UploadAcceptanceUnavailableError" });
    expect(f.sql.prepare("SELECT * FROM storage_role_defaults").all()).toEqual([]);
    expect(f.sql.prepare(`SELECT * FROM ${f.table}`).all()).toEqual([]);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });

  it.each(ingresses)("refuses %s while active execution is disabled and maps availability to 503", async ingress => {
    const f = fixture(ingress);
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    const error = await f.upload().catch(error => error);
    expect(f.classify(error)).toMatchObject({ status: 503 });
    expect(f.sql.prepare("SELECT * FROM storage_role_defaults").all()).toEqual([]);
    expect(f.sql.prepare(`SELECT * FROM ${f.table}`).all()).toEqual([]);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });

  it.each(ingresses)("fences %s runtime changes between selection and acceptance", async ingress => {
    const f = fixture(ingress);
    f.beforeAcceptance(() => f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0"));
    await expect(f.upload()).rejects.toMatchObject({ name: ingress === "metrology_reference" ? "MetrologyReferenceUploadUnavailableError" : "R2UploadAcceptanceUnavailableError" });
    expect(f.sql.prepare("SELECT * FROM storage_role_defaults").all()).toEqual([]);
    expect(f.sql.prepare(`SELECT * FROM ${f.table}`).all()).toEqual([]);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });

  it.each(ingresses)("rejects changed deployment namespace for fresh %s before acceptance or byte I/O", async ingress => {
    const f = fixture(ingress);
    f.env.R2_BOOTSTRAP_NAMESPACE = namespace.replace("role-acceptance", "other-bucket");
    const error = await f.upload().catch(error => error);
    expect(f.classify(error)).toMatchObject({ status: 503 });
    expect(f.sql.prepare("SELECT * FROM storage_role_defaults").all()).toEqual([]);
    expect(f.sql.prepare(`SELECT * FROM ${f.table}`).all()).toEqual([]);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });

  it.each(ingresses)("rejects %s accepted after an overlap-to-active transition instead of bypassing role selection", async ingress => {
    const f = fixture(ingress, false);
    f.beforeAcceptance(() => enableFutureFileAuthority(f.sql));
    await expect(f.upload()).rejects.toMatchObject({ name: ingress === "metrology_reference" ? "MetrologyReferenceUploadUnavailableError" : "R2UploadAcceptanceUnavailableError" });
    expect(f.sql.prepare("SELECT * FROM storage_role_defaults").all()).toEqual([]);
    expect(f.sql.prepare(`SELECT * FROM ${f.table}`).all()).toEqual([]);
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });

  it("lets one active fresh owner finish while an identical concurrent request only observes its receipt", async () => {
    const f = fixture("ordinary_image");
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const normalPut = f.put.getMockImplementation()!;
    f.put.mockImplementationOnce(async (key, body) => { entered(); await waiting; await normalPut(key, body); });
    const first = f.upload();
    await writing;
    expect((await f.upload()).state.status).toBe("pending");
    release();
    expect((await first).state.status).toBe("ready");
    expect(f.put).toHaveBeenCalledOnce();
    expect(f.sql.prepare("SELECT count(*) n FROM r2_upload_requests").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_role_defaults").get()!.n).toBe(2);
  });
});

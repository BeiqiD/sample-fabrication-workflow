import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { readShadowBaseline } from "./shadow-baseline";
import { acceptShadowAdjudication, prepareShadowAdjudication, revokeShadowAdjudication, type ShadowAdjudicationContext, type ShadowAdjudicationResult } from "./shadow-adjudication-service";
import { convertShadowConsumer, type ShadowServiceContext } from "./shadow-service";
import type { ShadowAdjudicationRequest } from "../../shared/contracts/file-shadow-adjudication";
import type { ByteReadResult } from "./byte-reader";
import type { ByteWriteInput } from "./byte-writer";
import { activateFileAuthority, enableRecoveredFileAuthority } from "./authority-activation";
import { ensureFileAuthorityExecution } from "./authority-execution";
import { snapshotFullExportV19 } from "../export-v19-snapshot";
import { Log, LogLevel, Miniflare } from "miniflare";
import { canonicalR2UploadInput } from "../../shared/contracts/r2-upload";
import { readFileAuthorityStatus } from "./authority-activation";
const databases: DatabaseSync[] = [];
const now = "2026-09-28T08:00:00.000Z";
const bytes = new TextEncoder().encode("historical research bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const key = (consumerId = "content-a") => ({ consumerKind: "project_content_attachment" as const, consumerId, consumerSubId: "", fileSlot: "primary" as const });
function fixture(options: { throughMigration?: string } = {}) {
  const sql = referenceTestDatabase({ throughMigration: "0011_fp1_retire_legacy_test_projects.sql", ...options }); databases.push(sql);
  sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
    VALUES('asset','historical/source','registry.png','image/png',?,'ready',?,?)`).run(bytes.byteLength, sha, now);
  for (const suffix of ["a"]) {
    sql.prepare(`INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,'operator','operator',?,?)`).run(`project-${suffix}`, `Project ${suffix}`, `create-project-${suffix}`, now, now);
    sql.prepare(`INSERT INTO project_contents(id,project_id,content_type,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,'attachment',?,'operator','operator',?,?)`).run(`content-${suffix}`, `project-${suffix}`, `create-content-${suffix}`, now, now);
    sql.prepare(`INSERT INTO project_content_attachments(project_content_id,asset_id,original_name,mime_type,byte_size,created_by,created_at,creation_operation_id)
      VALUES(?,'asset',?,'image/png',?,'operator',?,?)`).run(`content-${suffix}`, `${suffix}.png`, bytes.byteLength, now, `create-attachment-${suffix}`);
  }
  sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2','r2:fixture:bucket','bootstrap',NULL,1,'historical',?)").run(now);
  sql.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) SELECT 1,epoch,'operator',? FROM file_shadow_control").run(now);
  const local = new SqliteD1Database(sql), db = local as unknown as D1Database;
  const assertProfile = vi.fn(async (profile: { profileId: string; configurationRevision: 1 }) => {
    if (profile.profileId !== "profile" || profile.configurationRevision !== 1) throw new Error("Wrong deployment profile");
  });
  const context: ShadowAdjudicationContext = { db, actor: "operator", assertProfile, now: () => now };
  async function request(consumerKey = key()): Promise<ShadowAdjudicationRequest> {
    const prepared = await prepareShadowAdjudication(context, consumerKey);
    expect(prepared).toMatchObject({ eligible: true, blockers: [], profiles: [{ profileId: "profile", configurationRevision: 1 }] });
    return { requestId: crypto.randomUUID(), key: consumerKey, ...prepared.preconditions!, sourceProfile: { profileId: "profile", configurationRevision: 1 },
      purpose: "research_source", purposeStatement: "Retain this attachment as the original measurement source.",
      namespaceStatement: "The archived deployment record binds this historical locator to this profile.", evidenceReference: "Fixture operator record A" };
  }
  const revoke = (receipt: ShadowAdjudicationResult, reason = "Correct the operator statement") => revokeShadowAdjudication(context, {
    requestId: crypto.randomUUID(), adjudicationId: receipt.requestId, adjudicationRequestSha256: receipt.requestSha256, reason,
  });
  return { sql, local, db, context, assertProfile, request, revoke };
}
function conversionFixture(f: ReturnType<typeof fixture>) {
  const incarnation = crypto.randomUUID(), created = new Date().toISOString();
  f.sql.prepare("INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES('profile',1,'operator',?)").run(created);
  f.sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='operator',updated_at=?").run(incarnation, created);
  const objects = new Map<string, Uint8Array>([["historical/source", bytes]]);
  const read = vi.fn(async (objectKey: string): Promise<ByteReadResult> => {
    const value = objects.get(objectKey); if (!value) return { outcome: "missing" };
    return { outcome: "available", body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(value.slice()); controller.close(); } }) };
  });
  const write = vi.fn(async (input: ByteWriteInput) => {
    if (input.body instanceof ArrayBuffer) { objects.set(input.key, new Uint8Array(input.body)); return; }
    const chunks: Uint8Array[] = [], reader = input.body.getReader();
    try { while (true) { const item = await reader.read(); if (item.done) break; chunks.push(item.value); } } finally { reader.releaseLock(); }
    const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    objects.set(input.key, result);
  });
  const context: ShadowServiceContext = { db: f.db, actor: "operator", runtimeIncarnation: incarnation,
    openProfile: async profile => ({ storage: { ...profile, adapterType: "r2", namespaceIdentity: "r2:fixture:bucket" },
      reader: { read, stat: vi.fn() }, writer: { accepts: "stream", write }, createHash: () => {
        const hash = createHash("sha256"); return { async write(value) { hash.update(value); }, async finish() { return hash.digest("hex"); }, async abort() {} };
      } }),
  };
  const request = async () => ({ operationId: crypto.randomUUID(), key: key(), expectedBaselineSha256: (await readShadowBaseline(f.db, key())).baselineSha256,
    destinationProfile: { profileId: "profile", configurationRevision: 1 } });
  const pause = () => f.sql.prepare("UPDATE file_shadow_runtime_guard SET enabled=0,updated_at=?").run(new Date().toISOString());
  const resume = () => {
    const next = crypto.randomUUID();
    f.sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,updated_at=?").run(next, new Date().toISOString());
    context.runtimeIncarnation = next;
  };
  return { context, request, pause, resume, objects, read, write };
}

afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); });
async function prepared() {
  const f = fixture();
  const runtime = conversionFixture(f);
  runtime.pause();
  await acceptShadowAdjudication(f.context, await f.request());
  runtime.resume();
  const converted = await convertShadowConsumer(runtime.context, await runtime.request());
  expect(converted.status).toBe("resolved");
  runtime.pause();
  for (const name of ["0012_fp1_file_authority_runtime.sql", "0013_fp1_r2_role_defaults.sql"]) {
    f.sql.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  const input = { requestId: crypto.randomUUID(), expectedEpoch: Number(f.sql.prepare("SELECT epoch FROM file_shadow_control").get()!.epoch),
    expectedShadowIncarnation: runtime.context.runtimeIncarnation };
  return { ...f, runtime, converted, input };
}

describe("atomic File authority activation", () => {
  it("binds a genuinely adjudicated and shadow-verified Project occurrence with one replayable cutoff", async () => {
    const f = await prepared();
    expect(f.sql.prepare("SELECT file_id FROM project_content_attachments").get()!.file_id).toBeNull();
    const previousWrites = f.runtime.write.mock.calls.length;
    expect(await activateFileAuthority(f.db, "operator", f.input)).toMatchObject({ mode: "active", enabled: 1, incarnation: f.input.requestId });
    expect(f.sql.prepare("SELECT file_id FROM project_content_attachments").get()!.file_id).toBe(f.converted.fileId);
    expect(await activateFileAuthority(f.db, "operator", f.input)).toMatchObject({ mode: "active", incarnation: f.input.requestId });
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_checkpoints").get()!.n).toBe(1);
    expect(f.runtime.write.mock.calls).toHaveLength(previousWrites);
    await ensureFileAuthorityExecution(f.db);
    expect((await snapshotFullExportV19(f.db)).schemaVersion).toBe(19);
  });
  it("rejects a stale cutoff without leaving a checkpoint or any partial typed binding", async () => {
    const f = await prepared();
    f.sql.prepare("UPDATE projects SET title='Updated',revision=revision+1,last_mutation_id='updated' WHERE id='project-a'").run();
    await expect(activateFileAuthority(f.db, "operator", f.input)).rejects.toThrow();
    expect(f.sql.prepare("SELECT mode FROM file_authority_control").get()!.mode).toBe("overlap");
    expect(f.sql.prepare("SELECT file_id FROM project_content_attachments").get()!.file_id).toBeNull();
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_checkpoints").get()!.n).toBe(0);
  });
  it("rolls back the complete switch if a typed binding guard rejects a consumer", async () => {
    const f = await prepared();
    f.sql.exec("CREATE TRIGGER simulate_binding_failure BEFORE UPDATE OF file_id ON project_content_attachments BEGIN SELECT RAISE(ABORT,'binding unavailable'); END");
    await expect(activateFileAuthority(f.db, "operator", f.input)).rejects.toThrow("binding unavailable");
    expect(f.sql.prepare("SELECT mode FROM file_authority_control").get()!.mode).toBe("overlap");
    expect(f.sql.prepare("SELECT enabled FROM file_authority_runtime_guard").get()!.enabled).toBe(0);
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_checkpoints").get()!.n).toBe(0);
  });
  it("requires explicit fresh local admission after a restored active database is paused", async () => {
    const f = await prepared();
    await activateFileAuthority(f.db, "operator", f.input);
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    await expect(ensureFileAuthorityExecution(f.db)).rejects.toThrow("paused");
    const requestId = crypto.randomUUID();
    await enableRecoveredFileAuthority(f.db, "operator", { requestId, expectedIncarnation: f.input.requestId });
    await ensureFileAuthorityExecution(f.db);
    expect(await enableRecoveredFileAuthority(f.db, "operator", { requestId, expectedIncarnation: f.input.requestId }))
      .toMatchObject({ enabled: 1, incarnation: requestId });
  });
  it("blocks an unexpired ready upload that has no resolved consumer for its result", async () => {
    const f = await prepared(), created = new Date().toISOString(), sha = "b".repeat(64);
    f.sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('unattached','unattached/key','image.png','image/png',3,'ready',?,?)")
      .run(sha, created);
    const accepted = await canonicalR2UploadInput("ordinary_image", { originalName: "image.png", mimeType: "image/png", byteSize: 3, sha256: sha });
    const id = crypto.randomUUID();
    f.sql.prepare(`INSERT INTO r2_upload_requests(id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,request_input_json,
      request_scope,storage_profile_id,storage_profile_revision,storage_policy_revision,candidate_asset_id,candidate_object_key,status,created_at,expires_at)
      VALUES(?,'operator@example.test',?,?,'ordinary_image','embedded_content',?,?,'system','profile',1,1,?,'unattached/candidate','pending',?,?)`)
      .run(id, crypto.randomUUID(), crypto.randomUUID(), accepted.sha256, accepted.json, crypto.randomUUID(), created, new Date(Date.parse(created)+86_400_000).toISOString());
    f.sql.prepare("UPDATE r2_upload_requests SET status='ready',accepted_result_json=?,completed_at=? WHERE id=?")
      .run(JSON.stringify({ id: "unattached", key: "unattached/key", deduplicated: true }), created, id);
    f.input.expectedEpoch = Number(f.sql.prepare("SELECT epoch FROM file_shadow_control").get()!.epoch);
    expect(await readFileAuthorityStatus(f.db)).toMatchObject({ current_count: 1, resolved_count: 1, pending_receipts: 0, unattached_ready_uploads: 1 });
    await expect(activateFileAuthority(f.db, "operator", f.input)).rejects.toThrow();
    expect(f.sql.prepare("SELECT mode FROM file_authority_control").get()!.mode).toBe("overlap");
    expect(f.sql.prepare("SELECT file_id FROM project_content_attachments").get()!.file_id).toBeNull();
  });
  it("runs the populated atomic binding transition on native D1 with the exact verified metadata", async () => {
    const f = await prepared();
    const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("File activation"); } }',
      compatibilityDate: "2026-07-20", d1Databases: ["DB"], log: new Log(LogLevel.ERROR) });
    try {
      const db = await mf.getD1Database("DB");
      const schema = f.sql.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { type: string; name: string; sql: string }[];
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const tables = schema.filter(entry => entry.type === "table");
      await db.batch(tables.map(entry => db.prepare(entry.sql)));
      await db.batch(schema.filter(entry => entry.type === "index").map(entry => db.prepare(entry.sql)));
      // Copy the fixture's genuine shadow verification records, preserving its
      // physical rowids exactly; then reinstall every production native guard.
      const inserts = [db.prepare("PRAGMA defer_foreign_keys=ON")];
      for (const table of tables) {
        const columns = f.sql.prepare(`PRAGMA table_info(${quote(table.name)})`).all().map(row => String(row.name));
        const withRowid = !/WITHOUT ROWID/i.test(table.sql);
        const names = [...(withRowid ? ["rowid"] : []), ...columns];
        const rows = f.sql.prepare(`SELECT ${names.map(quote).join(",")} FROM ${quote(table.name)}`).all();
        for (const row of rows) inserts.push(db.prepare(`INSERT INTO ${quote(table.name)}(${names.map(quote).join(",")}) VALUES(${names.map(() => "?").join(",")})`)
          .bind(...names.map(name => row[name])));
      }
      await db.batch(inserts);
      for (const kind of ["view", "trigger"]) await db.batch(schema.filter(entry => entry.type === kind).map(entry => db.prepare(entry.sql)));
      expect(await activateFileAuthority(db as unknown as D1Database, "operator", f.input))
        .toMatchObject({ mode: "active", enabled: 1, incarnation: f.input.requestId });
      expect(await db.prepare("SELECT file_id FROM project_content_attachments").first()).toEqual({ file_id: f.converted.fileId });
    } finally { await mf.dispose(); }
  }, 60_000);
});

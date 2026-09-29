import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { canonicalR2UploadInput } from "../../shared/contracts/r2-upload";
import { stageAuthorityCandidate, type StagedAuthorityCandidate } from "./authority-candidates";
import { writeAuthorityCandidate } from "./authority-publication";
import * as profiles from "./shadow-profile";
import type { ByteWriteInput } from "./byte-writer";
import type { Sha256Factory } from "./byte-verification";
import { futureActiveRuntimeDatabase } from "./authority-runtime-test-support";

const bytes = new TextEncoder().encode("same hash, distinct File purposes");
const sha = createHash("sha256").update(bytes).digest("hex");
const databases: DatabaseSync[] = [];
const migrationPath = new URL("../../migrations/0012_fp1_file_authority_runtime.sql", import.meta.url);
const hash: Sha256Factory = () => { const h = createHash("sha256"); return { async write(value) { h.update(value); }, async finish() { return h.digest("hex"); }, async abort() {} }; };
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

function fixture(active = true) {
  const now = new Date().toISOString();
  const seed = (sql: DatabaseSync) => {
    sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('runtime-sample','RUNTIME','Runtime',?,?)").run(now, now);
    sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2','r2:runtime:bucket','bootstrap',NULL,1,'historical',?)").run(now);
    sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'native-test',?)").run(now);
  };
  const sql = active ? futureActiveRuntimeDatabase(seed) : referenceTestDatabase();
  databases.push(sql);
  if (!active) {
    sql.exec("PRAGMA foreign_keys=ON");
    sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'native-test',? FROM file_shadow_control").run(now);
    seed(sql);
  }
  const db = new SqliteD1Database(sql) as unknown as D1Database;
  const objects = new Map<string, Uint8Array>();
  const write = vi.fn(async (input: ByteWriteInput) => { objects.set(input.key, new Uint8Array(await new Response(input.body as BodyInit).arrayBuffer())); });
  const read = vi.fn(async (key: string) => {
    const value = objects.get(key);
    return value ? { outcome: "available" as const, body: new Blob([value]).stream() } : { outcome: "missing" as const };
  });
  vi.spyOn(profiles, "openShadowProfile").mockResolvedValue({ storage: { profileId: "profile", configurationRevision: 1,
    adapterType: "r2", namespaceIdentity: "r2:runtime:bucket" }, reader: { read, stat: vi.fn() }, writer: { accepts: "both", write }, createHash: hash });
  return { sql, db, now, env: { DB: db } as Env, objects, write, read };
}
type Fixture = ReturnType<typeof fixture>;
async function receipt(f: Fixture, purpose: "embedded_content" | "research_source" = "embedded_content") {
  const id = crypto.randomUUID(), operationId = crypto.randomUUID(), assetId = crypto.randomUUID(), objectKey = `accepted/${crypto.randomUUID()}`;
  const ingress = purpose === "embedded_content" ? "ordinary_image" : "project_attachment";
  const input = await canonicalR2UploadInput(ingress, { originalName: "image.png", mimeType: "image/png", byteSize: bytes.length, sha256: sha });
  f.sql.prepare(`INSERT INTO r2_upload_requests
    (id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,request_input_json,request_scope,storage_profile_id,
     storage_profile_revision,storage_policy_revision,candidate_asset_id,candidate_object_key,status,created_at,expires_at)
    VALUES (?,'native@example.test',?,?,?,?,?,?,'system','profile',1,1,?,?,'pending',?,?)`)
    .run(id, crypto.randomUUID(), operationId, ingress, purpose, input.sha256, input.json, assetId, objectKey, f.now,
      new Date(Date.parse(f.now) + 86_400_000).toISOString());
  return { id, operationId, assetId, objectKey, purpose,
    owner: { kind: "r2_upload" as const, acceptanceId: id, actorEmail: "native@example.test", operationId } };
}
type Receipt = Awaited<ReturnType<typeof receipt>>;
function alias(f: Fixture, r: Pick<Receipt, "assetId" | "objectKey">, status = "ready", checksum = sha) {
  return f.db.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
    VALUES (?,?,'image.png','image/png',?,?,?,?)`).bind(r.assetId, r.objectKey, bytes.length, status, checksum, f.now);
}
function ready(f: Fixture, r: Receipt, result = { id: r.assetId, key: r.objectKey, deduplicated: false }) {
  return f.db.prepare("UPDATE r2_upload_requests SET status='ready',accepted_result_json=?,completed_at=? WHERE id=?")
    .bind(JSON.stringify(result), new Date().toISOString(), r.id);
}
async function stage(f: Fixture, r: Receipt) { return stageAuthorityCandidate(f.db, r.owner, new Date().toISOString()); }
async function verify(f: Fixture, r: Receipt, candidate: StagedAuthorityCandidate) {
  return writeAuthorityCandidate(f.env, r.owner, candidate, { body: bytes.buffer, contentType: "image/png", filename: "image.png" });
}
async function publish(f: Fixture, r: Receipt) {
  const candidate = await stage(f, r), verified = await verify(f, r, candidate);
  await f.db.batch([...verified.statements, alias(f, r), ready(f, r)]);
  return { candidate, verified };
}
function rows(f: Fixture) {
  return Object.fromEntries(["files", "file_locations", "file_publications", "file_location_publications", "file_acceptance_candidates", "r2_upload_requests", "assets", "events"]
    .map(table => [table, f.sql.prepare(`SELECT * FROM ${table}`).all()]));
}

describe("0012 native runtime guards (active cases simulate future cutover)", () => {
  it.each(["legacy", "overlap"] as const)("applies atomically without activating or changing %s profiles", mode => {
    const sql = referenceTestDatabase({ throughMigration: "0011_fp1_retire_legacy_test_projects.sql" });
    databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
    const now = new Date().toISOString();
    sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2','r2:runtime:bucket','bootstrap',NULL,1,'historical',?)").run(now);
    if (mode === "overlap") {
      sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'native-test',? FROM file_shadow_control").run(now);
      sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'native-test',?)").run(now);
    }
    const state = () => ["file_authority_control", "storage_profile_runtime", "file_shadow_control"]
      .map(table => sql.prepare(`SELECT * FROM ${table}`).all());
    const before = state(), control = sql.prepare("SELECT sql FROM sqlite_schema WHERE name='file_authority_control_update_guard'").get()!.sql;
    sql.exec("BEGIN"); sql.exec(readFileSync(migrationPath, "utf8")); sql.exec("COMMIT");
    expect(state()).toEqual(before);
    expect(sql.prepare("SELECT sql FROM sqlite_schema WHERE name='file_authority_control_update_guard'").get()!.sql).toBe(control);
    expect(() => sql.exec("UPDATE file_authority_control SET mode='active'")).toThrow(/activation remains unavailable/);
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps overlap legacy receipts and shadow-only publication unchanged", async () => {
    const f = fixture(false), r = await receipt(f);
    await f.db.batch([alias(f, r), ready(f, r)]);
    expect(f.sql.prepare("SELECT status FROM r2_upload_requests WHERE id=?").get(r.id)!.status).toBe("ready");
    expect(f.sql.prepare("SELECT * FROM files").all()).toEqual([]);
    await expect(alias(f, { assetId: "unbound", objectKey: "unbound" }).run()).rejects.toThrow(/SHA|sha|duplicate/);
    const next = await receipt(f), candidate = await stage(f, next), before = rows(f);
    expect(() => f.sql.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,
      verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
      VALUES(?,?,'profile',?,?,?,'full_read_sha256',?,?,?)`)
      .run(candidate.locationId, candidate.fileId, candidate.objectKey, bytes.length, sha, next.operationId, f.now, f.now))
      .toThrow(/File publication requires its exact verified executor candidate/);
    expect(rows(f)).toEqual(before);
  });

  it("allows separate same-hash purpose aliases only for the exact ready accepted candidate", async () => {
    const f = fixture(), embedded = await receipt(f), first = await publish(f, embedded);
    const research = await receipt(f, "research_source"), candidate = await stage(f, research), verified = await verify(f, research, candidate);
    expect(verified.result.fileId).toBe(candidate.fileId);
    expect(verified.result.fileId).not.toBe(first.candidate.fileId);
    const before = rows(f);
    await expect(f.db.batch([...verified.statements, alias(f, { ...research, assetId: "wrong-owner-alias" }), ready(f, research)]))
      .rejects.toThrow(/SHA|sha|duplicate/);
    expect(rows(f)).toEqual(before);
    await f.db.batch([...verified.statements, alias(f, research), ready(f, research)]);
    expect(f.sql.prepare("SELECT purpose,verified_sha256 FROM file_usable_publications ORDER BY purpose").all()).toEqual([
      { purpose: "embedded_content", verified_sha256: sha }, { purpose: "research_source", verified_sha256: sha },
    ]);
    expect(f.sql.prepare("SELECT id FROM assets WHERE sha256=?").all(sha)).toHaveLength(2);
    expect(f.sql.prepare("SELECT state FROM file_acceptance_candidates").all()).toEqual([{ state: "ready" }, { state: "ready" }]);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects an unbound duplicate ready alias on insert and pending-to-ready update", async () => {
    const f = fixture(); await publish(f, await receipt(f));
    const unbound = { assetId: "unbound", objectKey: "unbound" }, before = rows(f);
    await expect(alias(f, unbound).run()).rejects.toThrow(/SHA|sha|duplicate/);
    expect(rows(f)).toEqual(before);
    await alias(f, unbound, "pending").run();
    expect(() => f.sql.prepare("UPDATE assets SET status='ready' WHERE id=?").run(unbound.assetId)).toThrow(/SHA|sha|duplicate/);
    expect(f.sql.prepare("SELECT status FROM assets WHERE id=?").get(unbound.assetId)!.status).toBe("pending");
  });

  it("rejects old writers and wrong-purpose receipt results with atomic rollback", async () => {
    const f = fixture(), firstReceipt = await receipt(f), beforeOldWriter = rows(f);
    await expect(f.db.batch([alias(f, firstReceipt), ready(f, firstReceipt)]))
      .rejects.toThrow(/exact ready File candidate/);
    expect(rows(f)).toEqual(beforeOldWriter);
    await publish(f, firstReceipt);
    const research = await receipt(f, "research_source"), candidate = await stage(f, research), verified = await verify(f, research, candidate);
    const beforeMismatch = rows(f);
    await expect(f.db.batch([...verified.statements, alias(f, research), ready(f, research,
      { id: firstReceipt.assetId, key: firstReceipt.objectKey, deduplicated: true })]))
      .rejects.toThrow(/exact ready File candidate/);
    expect(rows(f)).toEqual(beforeMismatch);
    expect(f.objects.has(candidate.objectKey)).toBe(true);
  });

  it("reuses the same-purpose File and existing alias while retaining the new candidate proof", async () => {
    const f = fixture(), firstReceipt = await receipt(f), first = await publish(f, firstReceipt);
    const next = await receipt(f), candidate = await stage(f, next), verified = await verify(f, next, candidate);
    expect(verified.result).toEqual(first.verified.result);
    expect(candidate.objectKey).not.toBe(verified.result.objectKey);
    await f.db.batch([...verified.statements, ready(f, next,
      { id: firstReceipt.assetId, key: firstReceipt.objectKey, deduplicated: true })]);
    expect(f.sql.prepare("SELECT file_id FROM file_publications").all()).toEqual([{ file_id: first.candidate.fileId }]);
    expect(f.sql.prepare("SELECT location_id FROM file_location_publications").all()).toHaveLength(2);
    expect(f.sql.prepare("SELECT id FROM assets").all()).toEqual([{ id: firstReceipt.assetId }]);
    expect(f.sql.prepare("SELECT state,result_file_id,result_location_id FROM file_acceptance_candidates WHERE acceptance_id=?").get(next.id))
      .toEqual({ state: "ready", result_file_id: first.candidate.fileId, result_location_id: first.candidate.locationId });
    expect(JSON.parse(String(f.sql.prepare("SELECT accepted_result_json FROM r2_upload_requests WHERE id=?").get(next.id)!.accepted_result_json)))
      .toEqual({ id: firstReceipt.assetId, key: firstReceipt.objectKey, deduplicated: true });
  });

  it("requires a typed File binding for an active event asset and accepts its exact published File", async () => {
    const f = fixture(), r = await receipt(f), published = await publish(f, r);
    const insert = f.sql.prepare(`INSERT INTO events(id,sample_id,kind,asset_key,asset_file_id,metadata_json,created_at)
      VALUES(?,'runtime-sample','image',?,?,'{"action":"sample_record"}',?)`);
    expect(() => insert.run("unbound-event", r.objectKey, null, f.now)).toThrow(/File|binding/);
    expect(f.sql.prepare("SELECT * FROM events").all()).toEqual([]);
    insert.run("bound-event", r.objectKey, published.candidate.fileId, f.now);
    expect(f.sql.prepare("SELECT asset_key,asset_file_id FROM events").all())
      .toEqual([{ asset_key: r.objectKey, asset_file_id: published.candidate.fileId }]);
  });
});

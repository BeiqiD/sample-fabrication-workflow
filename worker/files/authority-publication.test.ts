import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { canonicalR2UploadInput } from "../../shared/contracts/r2-upload";
import { stageAuthorityCandidate } from "./authority-candidates";
import { writeAuthorityCandidate } from "./authority-publication";
import * as profiles from "./shadow-profile";
import type { ByteWriteInput } from "./byte-writer";
import type { Sha256Factory } from "./byte-verification";

const bytes = new TextEncoder().encode("future authority publication bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const databases: DatabaseSync[] = [];
const hash: Sha256Factory = () => { const h = createHash("sha256"); return { async write(value) { h.update(value); }, async finish() { return h.digest("hex"); }, async abort() {} }; };
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

async function futureSubstrateFixture(corruptDestination = false) {
  // Explicit prospective fixture, NOT evidence that V17 accepts ordinary File
  // publication. Only the two initial seed statements differ: all 0007 guards
  // are installed unchanged, and no 0008+ shadow publication rules are loaded.
  const sql = referenceTestDatabase({ throughMigration: "0006_comment_acceptance.sql" }); databases.push(sql);
  sql.exec("PRAGMA foreign_keys=ON");
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2','r2:prospective:bucket','bootstrap',NULL,1,'historical',?)").run(now);
  const migration = readFileSync(new URL("../../migrations/0007_fp1_file_authority_transition.sql", import.meta.url), "utf8");
  const authoritySeed = "VALUES (1, 'legacy', 1, '2026-09-14T00:00:00.000Z', NULL);";
  const runtimeSeed = "SELECT id, 'read_only', created_at, NULL, NULL FROM storage_profiles;";
  expect(migration).toContain(authoritySeed); expect(migration).toContain(runtimeSeed);
  sql.exec(migration.replace(authoritySeed, "VALUES (1, 'active', 1, '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z');")
    .replace(runtimeSeed, "SELECT id, 'read_write', created_at, created_at, NULL FROM storage_profiles;"));
  expect(sql.prepare("SELECT name FROM sqlite_schema WHERE name='file_shadow_operations'").all()).toEqual([]);
  expect(() => sql.exec("UPDATE file_authority_control SET mode='overlap'")).toThrow(/reviewed forward migration/);
  const db = new SqliteD1Database(sql) as unknown as D1Database;
  const id = crypto.randomUUID(), operationId = crypto.randomUUID(), assetId = crypto.randomUUID(), objectKey = `accepted/${crypto.randomUUID()}`;
  const input = await canonicalR2UploadInput("ordinary_image", { originalName: "image.png", mimeType: "image/png", byteSize: bytes.length, sha256: sha });
  sql.prepare(`INSERT INTO r2_upload_requests
    (id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,request_input_json,request_scope,storage_profile_id,
     storage_profile_revision,storage_policy_revision,candidate_asset_id,candidate_object_key,status,created_at,expires_at)
    VALUES (?,'owner@example.test',?,?,'ordinary_image','embedded_content',?,?,'system','profile',1,1,?,?,'pending',?,?)`)
    .run(id, crypto.randomUUID(), operationId, input.sha256, input.json, assetId, objectKey, now, new Date(Date.parse(now) + 86_400_000).toISOString());
  const owner = { kind: "r2_upload" as const, acceptanceId: id, actorEmail: "owner@example.test", operationId };
  const candidate = await stageAuthorityCandidate(db, owner, now);
  const objects = new Map<string, Uint8Array>();
  const write = vi.fn(async (value: ByteWriteInput) => {
    const uploaded = new Uint8Array(await new Response(value.body as BodyInit).arrayBuffer());
    objects.set(value.key, corruptDestination ? uploaded.map(byte => byte ^ 1) : uploaded);
  });
  let destinationEof = false;
  const read = vi.fn(async (key: string) => {
    const value = objects.get(key);
    let chunk = 0;
    return value ? { outcome: "available" as const, body: new ReadableStream<Uint8Array>({ pull(controller) {
      if (chunk++ === 0) controller.enqueue(value.slice(0, 3));
      else if (chunk === 2) controller.enqueue(value.slice(3));
      else { destinationEof = true; controller.close(); }
    } }, { highWaterMark: 0 }) } : { outcome: "missing" as const };
  });
  vi.spyOn(profiles, "openShadowProfile").mockResolvedValue({ storage: { profileId: "profile", configurationRevision: 1,
    adapterType: "r2", namespaceIdentity: "r2:prospective:bucket" }, reader: { read, stat: vi.fn() },
    writer: { accepts: "both", write }, createHash: hash });
  const env = { DB: db } as Env;
  const payload = { body: bytes.buffer, contentType: "image/png", filename: "image.png" };
  const business = () => [
    db.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
      VALUES (?,?,'image.png','image/png',?,'ready',?,?)`).bind(assetId, objectKey, bytes.length, sha, now),
    db.prepare(`UPDATE r2_upload_requests SET status='ready',accepted_result_json=?,completed_at=? WHERE id=? AND status='pending'`)
      .bind(JSON.stringify({ id: assetId, key: objectKey, deduplicated: false }), new Date().toISOString(), id),
  ];
  return { sql, db, env, owner, candidate, payload, write, read, objects, business, destinationEof: () => destinationEof };
}
function durableState(sql: DatabaseSync) {
  return Object.fromEntries(["files", "file_locations", "file_acceptance_candidates", "file_location_publications", "file_publications", "r2_upload_requests", "assets"]
    .map(table => [table, sql.prepare(`SELECT * FROM ${table}`).all()]));
}

describe("future 0007 File publication substrate (not current V17 activation)", () => {
  it("verifies full destination bytes, then commits publications, candidate result and business receipt together", async () => {
    const f = await futureSubstrateFixture();
    const verified = await writeAuthorityCandidate(f.env, f.owner, f.candidate, f.payload);
    expect(verified).toMatchObject({ state: "verified_unpublished", result: { fileId: f.candidate.fileId,
      locationId: f.candidate.locationId, objectKey: f.candidate.objectKey } });
    expect(f.write).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce(); expect(f.destinationEof()).toBe(true);
    expect(f.sql.prepare("SELECT * FROM file_location_publications").all()).toEqual([]);
    expect(f.sql.prepare("SELECT * FROM file_publications").all()).toEqual([]);
    expect(f.sql.prepare("SELECT state FROM file_acceptance_candidates").get()!.state).toBe("candidate");
    await f.db.batch([...verified.statements, ...f.business()]);
    expect(f.sql.prepare("SELECT file_id,verification_method,verified_sha256 FROM file_location_publications").all())
      .toEqual([{ file_id: f.candidate.fileId, verification_method: "full_read_sha256", verified_sha256: sha }]);
    expect(f.sql.prepare("SELECT file_id FROM file_usable_publications").all()).toEqual([{ file_id: f.candidate.fileId }]);
    expect(f.sql.prepare("SELECT state,result_file_id,result_location_id FROM file_acceptance_candidates").all())
      .toEqual([{ state: "ready", result_file_id: f.candidate.fileId, result_location_id: f.candidate.locationId }]);
    expect(f.sql.prepare("SELECT status FROM r2_upload_requests").get()!.status).toBe("ready");
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back every publication and candidate transition when the business receipt fails", async () => {
    const f = await futureSubstrateFixture();
    const verified = await writeAuthorityCandidate(f.env, f.owner, f.candidate, f.payload), before = durableState(f.sql);
    f.sql.exec(`CREATE TRIGGER qualification_reject_business BEFORE UPDATE ON r2_upload_requests WHEN NEW.status='ready'
      BEGIN SELECT RAISE(ABORT,'qualification business receipt rejected'); END;`);
    await expect(f.db.batch([...verified.statements, ...f.business()])).rejects.toThrow(/business receipt rejected/);
    expect(durableState(f.sql)).toEqual(before);
    expect(f.objects.has(f.candidate.objectKey)).toBe(true);
    expect(f.write).toHaveBeenCalledOnce();
  });

  it("returns no publication statements for a same-size destination hash mismatch", async () => {
    const f = await futureSubstrateFixture(true), before = durableState(f.sql);
    await expect(writeAuthorityCandidate(f.env, f.owner, f.candidate, f.payload)).rejects.toMatchObject({ phase: "destination", reason: "hash_mismatch" });
    expect(f.write).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce(); expect(f.destinationEof()).toBe(true);
    expect(durableState(f.sql)).toEqual(before);
  });
});

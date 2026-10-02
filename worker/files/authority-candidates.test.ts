import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { referenceTestDatabase, SqliteD1Database, seedReferenceGraph } from "../reference-test-support";
import type { Env } from "../types";
import { canonicalR2UploadInput } from "../../shared/contracts/r2-upload";
import { canonicalMetrologyReferenceUploadInput } from "../../shared/contracts/metrology-reference-upload";
import { createAcceptedComment } from "../uploads/comment-acceptance";
import { registerLegacyInventory } from "./legacy-inventory";
import { readShadowBaseline } from "./shadow-baseline";
import { convertShadowConsumer, type ShadowServiceContext } from "./shadow-service";
import type { ByteWriteInput } from "./byte-writer";
import type { Sha256Factory } from "./byte-verification";
import { stageAuthorityCandidate, findReusableAuthorityFile, type AuthorityCandidateOwner } from "./authority-candidates";

const bytes = new TextEncoder().encode("File candidate source bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const actor = "owner@example.test";
const namespace = JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "candidate-comments" });
const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });
const nextDay = (now: string) => new Date(Date.parse(now) + 86_400_000).toISOString();
const hash: Sha256Factory = () => { const h = createHash("sha256"); return { async write(value) { h.update(value); }, async finish() { return h.digest("hex"); }, async abort() {} }; };

async function fixture({ overlap = true, writable = true, legacySource = false } = {}) {
  const sql = referenceTestDatabase(); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  const adapter = new SqliteD1Database(sql), db = adapter as unknown as D1Database;
  const now = new Date().toISOString();
  if (legacySource) {
    sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('source-sample','SOURCE','Source',?,?)").run(now, now);
    sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('source-asset','legacy/source','source.png','image/png',?,'ready',?,?)").run(bytes.length, sha, now);
    sql.prepare("INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at) VALUES('source-event','source-sample','image','legacy/source','{\"action\":\"sample_record\"}',?)").run(now);
    await registerLegacyInventory(adapter, { observedAt: now, observations: [{ storeKind: "r2", provider: "r2", objectKey: "legacy/source",
      records: [{ table: "assets", id: "source-asset", byte_size: bytes.length, sha256: sha, status: "ready", import_id: null }], consumers: [], lifecycle: [] }] },
    [{ id: "profile", adapterType: "r2", namespaceIdentity: namespace, configurationSource: "bootstrap", credentialReference: null, configurationRevision: 1 }]);
  } else sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
  sql.prepare("INSERT INTO storage_profiles VALUES('other-profile','r2','r2:fixture:other-bucket','bootstrap',NULL,1,'historical',?)").run(now);
  if (overlap) sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'operator',? FROM file_shadow_control").run(now);
  if (overlap && writable) for (const profile of ["profile", "other-profile"]) {
    sql.prepare("INSERT INTO file_shadow_profile_enablements VALUES (?,1,'operator',?)").run(profile, now);
  }
  const network = vi.fn(() => { throw new Error("Candidate staging must not call a provider"); });
  vi.stubGlobal("fetch", network);
  return { sql, adapter, db, now, network };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function stagingRows(f: Fixture) {
  return Object.fromEntries(["files", "file_locations", "file_acceptance_candidates", "file_registry_rowid_claims", "file_publications", "file_location_publications"]
    .map(table => [table, f.sql.prepare(`SELECT * FROM ${table}`).all()]));
}
async function r2Receipt(f: Fixture, options: { kind?: "r2_upload" | "metrology_reference"; purpose?: "embedded_content" | "research_source";
  profileId?: string; byteSize?: number; checksum?: string; createdAt?: string } = {}) {
  const kind = options.kind ?? "r2_upload", purpose = options.purpose ?? "embedded_content";
  const id = crypto.randomUUID(), operationId = crypto.randomUUID(), objectKey = `accepted/${crypto.randomUUID()}`;
  const createdAt = options.createdAt ?? f.now, profileId = options.profileId ?? "profile";
  const file = { originalName: "source.png", mimeType: "image/png", byteSize: options.byteSize ?? bytes.length, sha256: options.checksum ?? sha };
  if (kind === "r2_upload") {
    const ingress = purpose === "research_source" ? "project_attachment" : "ordinary_image";
    const input = await canonicalR2UploadInput(ingress, file);
    f.sql.prepare(`INSERT INTO r2_upload_requests
      (id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,request_input_json,request_scope,storage_profile_id,
       storage_profile_revision,storage_policy_revision,candidate_asset_id,candidate_object_key,status,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,'system',?,1,1,?,?,'pending',?,?)`).run(id, actor, crypto.randomUUID(), operationId, ingress,
      input.input.purpose, input.sha256, input.json, profileId, crypto.randomUUID(), objectKey, createdAt, nextDay(createdAt));
  } else {
    seedReferenceGraph(f.sql);
    const input = await canonicalMetrologyReferenceUploadInput("reference-metrology-template", file);
    f.sql.prepare(`INSERT INTO metrology_reference_upload_requests
      (id,actor_email,client_request_id,operation_id,template_version_id,candidate_reference_id,publication_plan_json,
       ingress,purpose,request_sha256,request_input_json,request_scope,storage_profile_id,storage_profile_revision,storage_policy_revision,
       candidate_asset_id,candidate_object_key,status,created_at,expires_at)
      VALUES (?,?,?,?,'reference-metrology-template',?,?,'metrology_reference','research_source',?,?,'system',?,1,1,?,?,'pending',?,?)`)
      .run(id, actor, crypto.randomUUID(), operationId, crypto.randomUUID(), JSON.stringify({ schema: "metrology-reference-publication/1", action: "create", reference: null }),
        input.sha256, input.json, profileId, crypto.randomUUID(), objectKey, createdAt, nextDay(createdAt));
  }
  return { owner: { kind, acceptanceId: id, actorEmail: actor, operationId } as AuthorityCandidateOwner, objectKey, profileId, file };
}
async function importReceipt(f: Fixture) {
  const id = crypto.randomUUID(), operationId = crypto.randomUUID();
  const file = { byteSize: bytes.length, sha256: sha, mimeType: "application/octet-stream", originalName: "source.bin" };
  const input = { schema: "fabublox-import-request/1", workbook: { ...file, purpose: "provenance" },
    manifest: { ...file, purpose: "provenance" }, images: [{ ...file, purpose: "embedded_content", localId: "image-a" }] };
  const json = JSON.stringify(input);
  f.sql.prepare(`INSERT INTO imports (id,status,source_filename,source_sha256,sheet_name,template_type,actor_email,created_at,operation_id,
    lease_expires_at,client_request_id,request_sha256,request_input_json,request_scope,storage_profile_id,storage_profile_revision,storage_policy_revision)
    VALUES (?,'pending','source.xlsx',?,'Sheet1','process',?,?,?,?,?,?,?,'system','profile',1,1)`)
    .run(id, sha, actor, f.now, operationId, nextDay(f.now), crypto.randomUUID(), createHash("sha256").update(json).digest("hex"), json);
  return { kind: "import_file", acceptanceId: id, actorEmail: actor, operationId, itemId: "workbook" } as const;
}
async function commentReceipt(f: Fixture) {
  f.sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('comment-sample','COMMENT','Comment',?,?)").run(f.now, f.now);
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); }); app.post("/comments", createAcceptedComment);
  const provider = { put: vi.fn(), get: vi.fn(), head: vi.fn() };
  const env = { DB: f.db, ASSETS: provider, R2_BOOTSTRAP_NAMESPACE: namespace } as unknown as Env;
  const submissionId = "candidate-comment", itemId = "candidate-image";
  const response = await app.request("/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    protocol: "comment-submission/1", id: submissionId, body: "", context: { kind: "sample", sampleId: "comment-sample", expectedUpdatedAt: f.now },
    items: [{ id: itemId, kind: "comment_image", filename: "image.png", mimeType: "image/png", byteSize: bytes.length, sha256: sha,
      originalFilename: "image.png", originalMimeType: "image/png", originalByteSize: bytes.length }],
  }) }, env);
  expect(response.status, await response.text()).toBe(201);
  const row = f.sql.prepare(`SELECT p.operation_id,i.storage_profile_id FROM comment_submission_acceptances p
    JOIN comment_item_acceptances i ON i.submission_id=p.submission_id WHERE i.item_id=?`).get(itemId)!;
  expect(f.sql.prepare("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?").get(row.storage_profile_id)!.state).toBe("read_write");
  const executionToken = crypto.randomUUID();
  f.sql.prepare("UPDATE comment_item_acceptances SET execution_token=?,started_at=? WHERE item_id=?").run(executionToken, new Date().toISOString(), itemId);
  for (const method of Object.values(provider)) expect(method).not.toHaveBeenCalled();
  return { kind: "comment_item", acceptanceId: itemId, actorEmail: actor, operationId: String(row.operation_id), executionToken } as const;
}

async function publishSource(f: Fixture) {
  const incarnation = crypto.randomUUID(), now = new Date().toISOString();
  f.sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='operator',updated_at=?").run(incarnation, now);
  const objects = new Map([["legacy/source", bytes]]);
  const read = vi.fn(async (key: string) => {
    const value = objects.get(key);
    return value ? { outcome: "available" as const, body: new Blob([value]).stream() } : { outcome: "missing" as const };
  });
  const write = vi.fn(async (input: ByteWriteInput) => { objects.set(input.key, new Uint8Array(await new Response(input.body as BodyInit).arrayBuffer())); });
  const context: ShadowServiceContext = { db: f.db, actor: "operator", runtimeIncarnation: incarnation,
    openProfile: async profile => ({ storage: { ...profile, adapterType: "r2", namespaceIdentity: namespace },
      reader: { read, stat: vi.fn() }, writer: { accepts: "stream", write }, createHash: hash }) };
  const key = { consumerKind: "event", consumerId: "source-event", consumerSubId: "", fileSlot: "primary" };
  const baseline = await readShadowBaseline(f.db, key);
  const result = await convertShadowConsumer(context, { operationId: crypto.randomUUID(), key, expectedBaselineSha256: baseline.baselineSha256,
    destinationProfile: { profileId: "profile", configurationRevision: 1 } });
  expect(result.status).toBe("resolved"); expect(write).toHaveBeenCalledOnce();
  return { fileId: result.fileId!, locationId: result.locationId!, objectKey: String(f.sql.prepare("SELECT object_key FROM file_locations WHERE id=?").get(result.locationId)!.object_key) };
}

describe("File authority acceptance candidates", () => {
  it.each(["r2_upload", "metrology_reference"] as const)("stages %s from its immutable receipt and replays one candidate without publishing", async kind => {
    const f = await fixture(), receipt = await r2Receipt(f, { kind });
    const table = kind === "r2_upload" ? "r2_upload_requests" : "metrology_reference_upload_requests";
    const before = f.sql.prepare(`SELECT * FROM ${table}`).all();
    const staged = await stageAuthorityCandidate(f.db, receipt.owner, f.now);
    expect(staged).toMatchObject({ state: "staged", acceptance: { kind, id: receipt.owner.acceptanceId, itemId: "" },
      operationId: receipt.owner.operationId, purpose: kind === "r2_upload" ? "embedded_content" : "research_source", accessScope: "system",
      profile: { profileId: "profile", configurationRevision: 1 }, expectedBytes: { byteSize: bytes.length, sha256: sha }, objectKey: receipt.objectKey });
    expect(await stageAuthorityCandidate(f.db, receipt.owner, f.now)).toEqual(staged);
    expect(f.sql.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
    expect(f.sql.prepare("SELECT state,result_file_id,result_location_id FROM file_acceptance_candidates").all())
      .toEqual([{ state: "candidate", result_file_id: null, result_location_id: null }]);
    expect(f.sql.prepare("SELECT count(*) n FROM files").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT count(*) n FROM file_locations").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT * FROM file_publications").all()).toEqual([]);
    expect(f.sql.prepare("SELECT * FROM file_location_publications").all()).toEqual([]);
    expect(await findReusableAuthorityFile(f.db, staged)).toBeNull(); expect(f.network).not.toHaveBeenCalled();
  });

  it("recovers committed staging after a lost batch acknowledgement without allocating replacements", async () => {
    const f = await fixture(), receipt = await r2Receipt(f), batch = f.adapter.batch.bind(f.adapter);
    vi.spyOn(f.adapter, "batch").mockImplementationOnce(async statements => { await batch(statements); throw new Error("Lost commit response"); });
    const staged = await stageAuthorityCandidate(f.db, receipt.owner, f.now);
    expect(await stageAuthorityCandidate(f.db, receipt.owner, f.now)).toEqual(staged);
    expect(f.sql.prepare("SELECT count(*) n FROM files").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT count(*) n FROM file_locations").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT count(*) n FROM file_acceptance_candidates").get()!.n).toBe(1);
  });

  it.each(["wrong actor", "wrong operation", "expired", "legacy", "read only"] as const)("rejects %s without mutations", async mode => {
    const f = await fixture({ overlap: mode !== "legacy", writable: mode !== "read only" });
    const receipt = await r2Receipt(f, { createdAt: mode === "expired" ? "2020-01-01T00:00:00.000Z" : f.now });
    const owner = { ...receipt.owner, ...(mode === "wrong actor" ? { actorEmail: "other@example.test" } : {}),
      ...(mode === "wrong operation" ? { operationId: crypto.randomUUID() } : {}) };
    const before = stagingRows(f);
    await expect(stageAuthorityCandidate(f.db, owner, f.now)).rejects.toThrow();
    expect(stagingRows(f)).toEqual(before); expect(f.network).not.toHaveBeenCalled();
  });

  it("rolls back File and location allocation if the candidate insert fails", async () => {
    const f = await fixture(), receipt = await r2Receipt(f), before = stagingRows(f);
    f.sql.exec(`CREATE TRIGGER qualification_reject_candidate BEFORE INSERT ON file_acceptance_candidates
      BEGIN SELECT RAISE(ABORT,'qualification candidate insert rejection'); END;`);
    await expect(stageAuthorityCandidate(f.db, receipt.owner, f.now)).rejects.toThrow();
    expect(stagingRows(f)).toEqual(before); expect(f.network).not.toHaveBeenCalled();
  });

  it("allocates one stable location for each frozen import item and rejects unaccepted items", async () => {
    const f = await fixture(), owner = await importReceipt(f);
    const before = stagingRows(f);
    await expect(stageAuthorityCandidate(f.db, { ...owner, itemId: "image:missing" }, f.now)).rejects.toThrow();
    expect(stagingRows(f)).toEqual(before);
    const results = [];
    for (const itemId of ["workbook", "manifest", "image:image-a"]) {
      const staged = await stageAuthorityCandidate(f.db, { ...owner, itemId }, f.now);
      expect(staged.purpose).toBe(itemId.startsWith("image:") ? "embedded_content" : "provenance");
      expect(staged.expectedBytes).toEqual({ byteSize: bytes.length, sha256: sha });
      expect(await stageAuthorityCandidate(f.db, { ...owner, itemId }, f.now)).toEqual(staged);
      results.push(staged);
    }
    expect(new Set(results.map(result => result.objectKey)).size).toBe(3);
    expect(f.sql.prepare("SELECT count(*) n FROM file_acceptance_candidates").get()!.n).toBe(3);
    expect(f.sql.prepare("SELECT * FROM file_publications").all()).toEqual([]); expect(f.network).not.toHaveBeenCalled();
  });

  it("requires the accepted Comment parent operation and claimed item execution token", async () => {
    const f = await fixture(), owner = await commentReceipt(f), now = new Date().toISOString(), before = stagingRows(f);
    for (const changed of [{ ...owner, operationId: crypto.randomUUID() }, { ...owner, executionToken: crypto.randomUUID() }, { ...owner, actorEmail: "other@example.test" }]) {
      await expect(stageAuthorityCandidate(f.db, changed, now)).rejects.toThrow();
      expect(stagingRows(f)).toEqual(before);
    }
    const staged = await stageAuthorityCandidate(f.db, owner, now);
    expect(staged).toMatchObject({ acceptance: { kind: "comment_item", id: owner.acceptanceId, itemId: "" }, purpose: "embedded_content" });
    expect(await stageAuthorityCandidate(f.db, owner, now)).toEqual(staged);
    expect(f.sql.prepare("SELECT status FROM comment_submission_acceptances").all()).toEqual([{ status: "pending" }]);
    expect(f.sql.prepare("SELECT status FROM comment_item_acceptances").all()).toEqual([{ status: "pending" }]);
    expect(f.network).not.toHaveBeenCalled();
  });

  it("reuses only usable same-purpose, same-profile, exact-byte publications from real conversion", async () => {
    const f = await fixture({ legacySource: true }), published = await publishSource(f);
    const exact = await r2Receipt(f), staged = await stageAuthorityCandidate(f.db, exact.owner, new Date().toISOString());
    expect(await findReusableAuthorityFile(f.db, staged)).toEqual(published);
    for (const options of [{ purpose: "research_source" as const }, { profileId: "other-profile" }, { byteSize: bytes.length + 1 }, { checksum: "f".repeat(64) }]) {
      const receipt = await r2Receipt(f, options), mismatch = await stageAuthorityCandidate(f.db, receipt.owner, new Date().toISOString());
      expect(await findReusableAuthorityFile(f.db, mismatch)).toBeNull();
      expect(await findReusableAuthorityFile(f.db, { ...mismatch, purpose: staged.purpose, profile: staged.profile,
        expectedBytes: staged.expectedBytes })).toBeNull();
    }
    expect(f.sql.prepare("SELECT count(*) n FROM file_publications").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT state FROM file_acceptance_candidates").all().every(row => row.state === "candidate")).toBe(true);
    expect(f.network).not.toHaveBeenCalled();
  });
});

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { registerLegacyInventory } from "./legacy-inventory";
import { readFileConsumerBaseline, type LiveConsumerKey } from "./live-consumer-baseline";
import { readShadowBaseline } from "./shadow-baseline";
import { admitShadowUnresolved, cancelShadowOperation, convertShadowConsumer, reconcileShadowOperation, type ShadowServiceContext } from "./shadow-service";
import type { ByteReadResult } from "./byte-reader";
import type { ByteWriteInput } from "./byte-writer";
import type { Sha256Factory } from "./byte-verification";

const bytes = new TextEncoder().encode("complete source bytes 文件");
const SHA = createHash("sha256").update(bytes).digest("hex");
const databases: DatabaseSync[] = [];
const eventKey: LiveConsumerKey = { consumerKind: "event", consumerId: "event", consumerSubId: "", fileSlot: "primary" };
const hash: Sha256Factory = () => { const h = createHash("sha256"); return { async write(b) { h.update(b); }, async finish() { return h.digest("hex"); }, async abort() {} }; };
async function consume(input: ByteWriteInput) {
  if (input.body instanceof ArrayBuffer) return new Uint8Array(input.body);
  const reader = input.body.getReader(), chunks: Uint8Array[] = [];
  try { while (true) { const value = await reader.read(); if (value.done) break; chunks.push(value.value); } } finally { reader.releaseLock(); }
  const result = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0; for (const c of chunks) { result.set(c, offset); offset += c.byteLength; } return result;
}
async function fixture() {
  const sql = referenceTestDatabase(); databases.push(sql);
  const local = new SqliteD1Database(sql), db = local as unknown as D1Database;
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('s','S','Sample',?,?)").run(now, now);
  sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('asset','source','private-name.png','image/png',?,'ready',?,?)").run(bytes.length, SHA, now);
  sql.prepare("INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at) VALUES('event','s','image','source','{\"action\":\"sample_record\"}',?)").run(now);
  await registerLegacyInventory(local, { observedAt: now, observations: [{ storeKind: "r2", provider: "r2", objectKey: "source",
    records: [{ table: "assets", id: "asset", byte_size: bytes.length, sha256: SHA, status: "ready", import_id: null }], consumers: [], lifecycle: [] }] },
  [{ id: "profile", adapterType: "r2", namespaceIdentity: "r2:fixture:bucket", configurationSource: "bootstrap", credentialReference: null, configurationRevision: 1 }]);
  sql.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) SELECT 1,epoch,'operator',? FROM file_shadow_control").run(now);
  sql.prepare("INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES('profile',1,'operator',?)").run(now);
  const incarnation = crypto.randomUUID();
  sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='operator',updated_at=?").run(incarnation, now);
  const objects = new Map<string, Uint8Array>([["source", bytes]]);
  const read = vi.fn(async (key: string): Promise<ByteReadResult> => {
    const value = objects.get(key); if (!value) return { outcome: "missing" };
    return { outcome: "available", body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(value.slice()); c.close(); } }) };
  });
  const write = vi.fn(async (input: ByteWriteInput) => { objects.set(input.key, await consume(input)); });
  const openProfile = vi.fn(async (profile: { profileId: string; configurationRevision: number }) => {
    if (profile.profileId !== "profile" || profile.configurationRevision !== 1) throw new Error("Wrong frozen profile");
    return { storage: { ...profile, adapterType: "r2" as const, namespaceIdentity: "r2:fixture:bucket" }, reader: { read, stat: vi.fn() }, writer: { accepts: "stream" as const, write }, createHash: hash };
  });
  const context: ShadowServiceContext = { db, actor: "operator", runtimeIncarnation: incarnation, openProfile };
  async function request(key = eventKey) { const baseline = await readShadowBaseline(db, key); return { operationId: crypto.randomUUID(), key: { ...key },
    expectedBaselineSha256: baseline.baselineSha256, destinationProfile: { profileId: "profile", configurationRevision: 1 } }; }
  return { sql, local, db, context, objects, read, write, openProfile, request };
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("File shadow runtime against the complete SQLite schema", () => {
  it("qualifies exact V15 metadata while preserving the V14 protocol and private source metadata", async () => {
    const f = await fixture(), baseline = await readShadowBaseline(f.db, eventKey);
    expect(baseline).toMatchObject({ status: "ready_to_verify", purpose: "embedded_content", bytesVerified: false });
    expect(baseline.head).toHaveProperty("source_sha256"); expect(baseline.head).not.toHaveProperty("source_json");
    expect(JSON.stringify(baseline)).not.toContain("private-name");
    await expect(readFileConsumerBaseline(f.db)).rejects.toThrow(/schema generation/);
    f.sql.prepare("UPDATE events SET metadata_json=? WHERE id='event'").run(JSON.stringify({ action: ["PRIVATE ACTION"], thumbnailKey: { secret: "PRIVATE THUMB" } }));
    const malformed = await readShadowBaseline(f.db, eventKey);
    expect(JSON.stringify(malformed)).not.toContain("PRIVATE"); expect(malformed.status).toBe("ambiguous");
    expect(malformed.baselineSha256).not.toBe(baseline.baselineSha256);
  });

  it("holds the source before GET and candidate before PUT, then publishes one independent sidecar copy", async () => {
    const f = await fixture(), request = await f.request();
    f.read.mockImplementation(async (key) => {
      if (key === "source") expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_legacy_holds WHERE released_at IS NULL").get()!.n).toBe(1);
      const value = f.objects.get(key); return value ? { outcome: "available", body: new ReadableStream({ start(c) { c.enqueue(value); c.close(); } }) } : { outcome: "missing" };
    });
    f.write.mockImplementation(async (input) => { expect(f.sql.prepare("SELECT COUNT(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(1); f.objects.set(input.key, await consume(input)); });
    const result = await convertShadowConsumer(f.context, request);
    expect(result).toMatchObject({ status: "resolved", attemptState: "published", nextAction: "none" });
    expect(f.write).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledTimes(3);
    expect(f.sql.prepare("SELECT asset_key,asset_file_id FROM events WHERE id='event'").get()).toEqual({ asset_key: "source", asset_file_id: null });
    expect(f.sql.prepare("SELECT purpose,state,verified_sha256 FROM file_usable_publications WHERE file_id=?").get(result.fileId!)).toMatchObject({ purpose: "embedded_content", state: "ready", verified_sha256: SHA });
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_legacy_holds WHERE released_at IS NULL").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(0);
    expect(await convertShadowConsumer(f.context, request)).toEqual(result); expect(f.write).toHaveBeenCalledOnce();
  });

  it("reconciles a committed PUT with lost response by full reads and never repeats the write", async () => {
    const f = await fixture(), request = await f.request();
    f.write.mockImplementation(async (input) => { f.objects.set(input.key, await consume(input)); throw new Error("Private provider failure"); });
    expect(await convertShadowConsumer(f.context, request)).toMatchObject({ status: "pending", attemptState: "unknown", nextAction: "reconcile" });
    expect(await convertShadowConsumer(f.context, request)).toMatchObject({ attemptState: "unknown" }); expect(f.write).toHaveBeenCalledOnce();
    const reads = f.read.mock.calls.length;
    expect(await reconcileShadowOperation(f.context, request)).toMatchObject({ status: "resolved", attemptState: "published" });
    expect(f.read.mock.calls.length - reads).toBe(2); expect(f.write).toHaveBeenCalledOnce();
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_reconciliations").get()!.n).toBe(1);
  });

  it("admits only one pending operation for concurrent requests against the same occurrence", async () => {
    const f = await fixture(), first = await f.request(), second = { ...first, operationId: crypto.randomUUID() };
    const results = await Promise.allSettled([convertShadowConsumer(f.context, first), convertShadowConsumer(f.context, second)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_operations").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_decisions").get()!.n).toBe(1);
  });

  it("reconciles an unchanged occurrence at a fresh epoch after unrelated writes and fences changes during those reads", async () => {
    const f = await fixture(), request = await f.request();
    f.write.mockImplementation(async (input) => { f.objects.set(input.key, await consume(input)); throw new Error("Lost ACK"); });
    await convertShadowConsumer(f.context, request);
    const before = await readShadowBaseline(f.db, eventKey), captured = f.sql.prepare("SELECT captured_epoch FROM file_shadow_operations").get()!.captured_epoch;
    const insertUnrelated = (id: string) => f.sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES(?,?,'Unrelated',?,?)").run(id, id, new Date().toISOString(), new Date().toISOString());
    insertUnrelated("unrelated"); const after = await readShadowBaseline(f.db, eventKey);
    expect(after.epoch).toBeGreaterThan(before.epoch); expect(after.head!.occurrence_id).toBe(before.head!.occurrence_id);
    const read = f.read.getMockImplementation()!; let changed = false;
    f.read.mockImplementation(async (key) => { if (!changed) { changed = true; insertUnrelated("during-read"); } return read(key); });
    await expect(reconcileShadowOperation(f.context, request)).rejects.toThrow(/baseline changed/);
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_reconciliations").get()!.n).toBe(0);
    expect(await reconcileShadowOperation(f.context, request)).toMatchObject({ status: "resolved" });
    expect(f.sql.prepare("SELECT captured_epoch FROM file_shadow_operations").get()!.captured_epoch).toBe(captured);
    expect(f.sql.prepare("SELECT verified_epoch FROM file_shadow_reconciliations").get()!.verified_epoch).toBe(f.sql.prepare("SELECT epoch FROM file_shadow_control").get()!.epoch);
    expect(f.write).toHaveBeenCalledOnce();
  });

  it("keeps copied bytes held when an old writer changes the consumer during source IO", async () => {
    const f = await fixture(), request = await f.request(); let changed = false;
    const initialGeneration = (await readShadowBaseline(f.db, eventKey)).head!.generation;
    f.write.mockImplementation(async (input) => { f.objects.set(input.key, await consume(input)); if (!changed) { changed = true; f.sql.prepare("UPDATE events SET asset_key='replacement' WHERE id='event'").run(); } });
    await expect(convertShadowConsumer(f.context, request)).rejects.toThrow(/baseline changed/);
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_decisions").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_legacy_holds WHERE released_at IS NULL").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT generation FROM file_shadow_heads WHERE consumer_kind='event' AND file_slot='primary'").get()!.generation).toBe(initialGeneration + 1);
    const reads = f.read.mock.calls.length;
    await expect(reconcileShadowOperation(f.context, request)).rejects.toThrow(/baseline changed/);
    expect(f.read).toHaveBeenCalledTimes(reads); expect(f.write).toHaveBeenCalledOnce();
    await expect(cancelShadowOperation(f.context, request)).rejects.toThrow(/requires reconciliation/);
  });

  it("rejects corrupt source bytes before any candidate or provider write", async () => {
    const f = await fixture(); f.objects.set("source", new Uint8Array(bytes.length));
    const result = await convertShadowConsumer(f.context, await f.request());
    expect(result).toMatchObject({ status: "pending", attemptState: "failed", nextAction: "inspect" }); expect(f.write).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT candidate_file_id FROM file_shadow_attempts").get()!.candidate_file_id).toBeNull();
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_decisions").get()!.n).toBe(0);
    expect(await cancelShadowOperation(f.context, { operationId: result.operationId })).toMatchObject({ status: "cancelled", attemptState: "failed" });
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_legacy_holds WHERE released_at IS NULL").get()!.n).toBe(0);
  });

  it("retains an uncertain candidate when destination full-read bytes disagree", async () => {
    const f = await fixture(), request = await f.request();
    f.write.mockImplementation(async (input) => { await consume(input); f.objects.set(input.key, new Uint8Array(bytes.length)); });
    expect(await convertShadowConsumer(f.context, request)).toMatchObject({ attemptState: "unknown", nextAction: "reconcile" });
    expect(await reconcileShadowOperation(f.context, request)).toMatchObject({ attemptState: "unknown" });
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_location_publications").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(1);
    await expect(cancelShadowOperation(f.context, request)).rejects.toThrow(/requires reconciliation/);
  });

  it("atomically cancels never-written staged candidates after generation and incarnation change", async () => {
    const f = await fixture(), request = await f.request();
    const prepare = f.local.prepare.bind(f.local); let stop = true;
    vi.spyOn(f.local, "prepare").mockImplementation((query) => {
      if (stop && query.includes("SET state='write_started'")) { stop = false; throw new Error("Worker ended before writer admission"); }
      return prepare(query);
    });
    await expect(convertShadowConsumer(f.context, request)).rejects.toThrow(/baseline changed/);
    expect(f.sql.prepare("SELECT state,write_started_at FROM file_shadow_attempts").get()).toEqual({ state: "staged", write_started_at: null });
    f.sql.prepare("UPDATE events SET asset_key='new-source' WHERE id='event'").run();
    f.sql.prepare("UPDATE file_shadow_runtime_guard SET enabled=0,updated_at=?").run(new Date().toISOString());
    await expect(cancelShadowOperation(f.context, request)).rejects.toThrow(/cannot be safely abandoned/);
    const incarnation = crypto.randomUUID(); f.sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='operator',updated_at=?").run(incarnation, new Date().toISOString());
    const context = { ...f.context, runtimeIncarnation: incarnation };
    const cancelled = await cancelShadowOperation(context, request);
    expect(cancelled).toMatchObject({ status: "cancelled", attemptState: "cancelled", nextAction: "none" });
    expect(await cancelShadowOperation(context, request)).toEqual(cancelled);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_legacy_holds WHERE released_at IS NULL").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_location_holds WHERE released_at IS NULL").get()!.n).toBe(0);
  });

  it("resumes after a reconciliation proof commits but the verified update is interrupted", async () => {
    const f = await fixture(), request = await f.request();
    f.write.mockImplementation(async (input) => { f.objects.set(input.key, await consume(input)); throw new Error("Lost ACK"); });
    await convertShadowConsumer(f.context, request);
    const prepare = f.local.prepare.bind(f.local); let fail = true;
    vi.spyOn(f.local, "prepare").mockImplementation((query) => {
      if (fail && query.includes("SET state='verified'")) { fail = false; throw new Error("Worker ended after durable proof"); }
      return prepare(query);
    });
    await expect(reconcileShadowOperation(f.context, request)).rejects.toThrow(/outcome is unavailable/);
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_reconciliations").get()!.n).toBe(1);
    expect(await reconcileShadowOperation(f.context, request)).toMatchObject({ status: "resolved" });
    expect(f.sql.prepare("SELECT COUNT(*) n FROM file_shadow_reconciliations").get()!.n).toBe(1); expect(f.write).toHaveBeenCalledOnce();
  });

  it("detaches input before awaiting a profile or claim and rejects mismatched profile capabilities", async () => {
    const f = await fixture(), request = await f.request(); const operationId = request.operationId;
    const converting = convertShadowConsumer(f.context, request);
    request.operationId = crypto.randomUUID(); request.destinationProfile.profileId = "mutated"; request.key.consumerId = "other";
    request.expectedBaselineSha256 = "f".repeat(64); f.context.actor = "other-actor";
    expect(await converting).toMatchObject({ operationId, status: "resolved" });
    expect(f.sql.prepare("SELECT created_by,destination_profile_id FROM file_shadow_operations").get()).toEqual({ created_by: "operator", destination_profile_id: "profile" });
    const g = await fixture(), invalid = await g.request();
    const opener = g.openProfile.getMockImplementation()!;
    g.openProfile.mockImplementation(async (profile) => { const opened = await opener(profile); return { ...opened, storage: { ...opened.storage, profileId: "wrong" } }; });
    await expect(convertShadowConsumer(g.context, invalid)).rejects.toThrow(/frozen profile/);
    expect(g.read).not.toHaveBeenCalled(); expect(g.write).not.toHaveBeenCalled();
    expect(g.sql.prepare("SELECT COUNT(*) n FROM file_shadow_operations").get()!.n).toBe(0);
  });

  it("requires explicit current-incarnation reconciliation after restoring the execution gate", async () => {
    const f = await fixture(), request = await f.request();
    f.write.mockImplementation(async (input) => { f.objects.set(input.key, await consume(input)); throw new Error("ACK lost"); });
    await convertShadowConsumer(f.context, request);
    f.sql.prepare("UPDATE file_shadow_runtime_guard SET enabled=0,updated_at=?").run(new Date().toISOString());
    const reads = f.read.mock.calls.length;
    await expect(reconcileShadowOperation(f.context, request)).rejects.toThrow(/baseline changed/); expect(f.read).toHaveBeenCalledTimes(reads);
    const incarnation = crypto.randomUUID(); f.sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='operator',updated_at=?").run(incarnation, new Date().toISOString());
    expect(await reconcileShadowOperation({ ...f.context, runtimeIncarnation: incarnation }, request)).toMatchObject({ status: "resolved" });
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.sql.prepare("SELECT runtime_incarnation FROM file_shadow_attempts").get()!.runtime_incarnation).toBe(f.context.runtimeIncarnation);
    expect(f.sql.prepare("SELECT runtime_incarnation FROM file_shadow_reconciliations").get()!.runtime_incarnation).toBe(incarnation);
  });

  it("records a pending consumer as explicitly unresolved without provider capability or freezing later legacy writes", async () => {
    const f = await fixture(), now = new Date().toISOString();
    f.sql.prepare("INSERT INTO comment_submissions(id,context_kind,sample_id,body,status,created_at,updated_at) VALUES('comment','sample','s','private body','uploading',?,?)").run(now, now);
    f.sql.prepare("INSERT INTO comment_submission_items(id,submission_id,kind,status,position,created_at,updated_at) VALUES('pending','comment','comment_image','pending',0,?,?)").run(now, now);
    const key = { consumerKind: "comment_submission_item", consumerId: "pending", consumerSubId: "", fileSlot: "primary" }, request = await f.request(key);
    expect((await readShadowBaseline(f.db, key)).status).toBe("pending_no_locator");
    const result = await admitShadowUnresolved(f.context, { ...request, reason: "Awaiting the accepted legacy upload" });
    expect(result).toMatchObject({ status: "admitted_unresolved", attemptId: null, fileId: null });
    expect(f.openProfile).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    f.sql.prepare("UPDATE comment_submission_items SET asset_id='asset',sha256=?,byte_size=?,status='ready' WHERE id='pending'").run(SHA, bytes.length);
    const current = await readShadowBaseline(f.db, key); expect(current.decision).toBeNull(); expect(current.head!.generation).toBe(2);
  });
});

// SOURCE ONLY. Positive records, deletions, members and grants use their actual owners.
import { beforeAll, expect, it } from "vitest";
import { createSampleReadService } from "../worker/samples/read-service";
import { configurationSqlRow } from "../worker/runtime/configuration-sql";
import type { ReadSqlCell, ReadSqlDatabase, ReadSqlStatement } from "../worker/runtime/read-sql";
import type { SqliteStatement } from "./sqlite";
import type { SampleRecordRemovePermissionRequest } from "./collaboration/local-sample-record-remove-permission-v28-candidate";
import { SAMPLE_RECORD_REMOVE_SOURCE_CAPTURE_SQL } from "./collaboration/sample-record-remove-source-sql";
import { SAMPLE_DETAIL_SOURCE_CAPTURE_SQL } from "./collaboration/sample-detail-source-sql";
import { sampleRecordLifecycleFixture, type SampleRecordLifecycleFixture, type RunStartPreviewSession } from "./collaboration-sample-record-remove-history-v28-fixture.qualification";
import { configureLogicalFixture, original, operator, privateCopy } from "./collaboration-sample-v28-logical-fixture.qualification";
import { readLogicalSampleSource, hashClosedLogicalDatabase, assertLogicalSampleMembers, type LogicalSampleSource } from "./collaboration-sample-v28-logical-artifact.qualification";

let source: LogicalSampleSource;
beforeAll(() => original(async () => { await configureLogicalFixture(); source = await readLogicalSampleSource(); }), 20000);
function text(value: unknown): string {
  expect(typeof value).toBe("string"); if (typeof value !== "string") throw new Error("Actual record text required"); return value;
}
function rows(f: SampleRecordLifecycleFixture, table: string) {
  const order = table === "collaboration_resources" ? "root_kind,root_id"
    : table === "collaboration_grants" ? "root_kind,root_id,member_id" : "rowid";
  return f.native.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
}
function business(f: SampleRecordLifecycleFixture) {
  return Object.fromEntries(["samples", "events", "runs", "run_steps", "run_step_comments", "comment_submissions",
    "comment_submission_acceptances", "assets", "collaboration_resources", "collaboration_grants"].map(table => [table, rows(f, table)]));
}
async function fixture() {
  const path = await privateCopy(source.databasePath);
  expect(await hashClosedLogicalDatabase(source.databasePath)).toBe(source.databaseSha256);
  expect(await hashClosedLogicalDatabase(path)).toBe(source.databaseSha256);
  await assertLogicalSampleMembers(path, source);
  return sampleRecordLifecycleFixture(path);
}
async function fresh(f: SampleRecordLifecycleFixture, session: RunStartPreviewSession) {
  const response = await f.request("/api/samples", "POST", { code: `REMOVE-${crypto.randomUUID()}`, title: "Actual Group text record lifecycle Sample" }, session);
  expect(response.status).toBe(201); return text(response.value?.id);
}
async function record(f: SampleRecordLifecycleFixture, id: string, session: RunStartPreviewSession, body = "Genuine media-free removable text") {
  const row = f.native.prepare("SELECT status,location,pinned,updated_at FROM samples WHERE id=?").get(id)!;
  const before = rows(f, "events");
  const response = await f.request(`/api/samples/${id}/records`, "POST", {
    status: String(row.status), location: row.location === null ? "" : String(row.location), pinned: Boolean(row.pinned), expectedUpdatedAt: text(row.updated_at), body,
  }, session);
  expect(response.status).toBe(200);
  const added = rows(f, "events").filter(event => !before.some(old => old.id === event.id));
  expect(added).toHaveLength(1); expect(added[0]!.kind).toBe("comment");
  return { id: text(added[0]!.id), event: added[0]!, updatedAt: text(response.value?.updatedAt) };
}
async function grant(f: SampleRecordLifecycleFixture, actor: RunStartPreviewSession, id: string, capability: "read" | "operate" | "edit", enabled = true) {
  const root = f.native.prepare("SELECT revision FROM collaboration_resources WHERE root_kind='sample' AND root_id=?").get(id)!;
  const row = f.native.prepare("SELECT revision FROM collaboration_grants WHERE root_kind='sample' AND root_id=? AND member_id=?").get(id, source.bobMember);
  expect((await f.request(`/api/collaboration/resources/sample/${id}/grants/${source.bobMember}`, "PUT", {
    operation: "grant", expectedResourceRevision: root.revision, expectedGrantRevision: row?.revision ?? null, capability, enabled,
  }, actor)).status).toBe(200);
}
// Complete original typed service is only a serialization oracle here. It
// issues no Request/grant and does not substitute private body projections.
async function originalWire(f: SampleRecordLifecycleFixture, id: string, processing = false) {
  const wrap = (native: SqliteStatement): ReadSqlStatement => ({
    bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values)); },
    async first() { const row = (await f.database.batch([native]))[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row); },
    async all() { return { results: (await f.database.batch([native]))[0]!.results.map(configurationSqlRow) }; },
  });
  const database: ReadSqlDatabase = { prepare(sql: string) { return wrap(f.database.prepare(sql)); } };
  return f.lease.withWriter(() => createSampleReadService({ database: () => database, admit: async actor => {
    expect(actor).toBe(`local-account:${source.alice}`);
  } }).detail(id, key => key === "view" && processing ? "processing" : undefined, `local-account:${source.alice}`));
}

it("deletes one genuine text record with exact original event audit and Sample CAS and preserves mature normal and processing history", () => original(async () => {
  const f = await fixture(), alice = await f.login("alice"), id = await fresh(f, alice), created = await record(f, id, alice, "  Genuine deleted text  ");
  const before = business(f), result = await f.request(`/api/samples/${id}/records/${created.id}`, "DELETE", undefined, alice);
  expect(result.status).toBe(200); expect(result.value?.ok).toBe(true);
  const updatedAt = text(result.value?.updatedAt), actor = `local-account:${source.alice}`;
  expect(Date.parse(updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
  const after = business(f), deleted = after.events!.find(row => row.id === created.id)!, metadata = JSON.parse(text(deleted.metadata_json)) as Record<string, unknown>;
  expect(Object.keys(metadata)).toEqual(["action", "deletedAt", "deletedBy", "deletionOperationId", "hadAsset"]);
  expect(metadata).toEqual({ action: "sample_record", deletedAt: updatedAt, deletedBy: actor, deletionOperationId: metadata.deletionOperationId, hadAsset: false });
  expect(text(metadata.deletionOperationId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(deleted).toEqual({ ...created.event, metadata_json: JSON.stringify(metadata) });
  const added = after.events!.filter(row => !before.events!.some(old => old.id === row.id)); expect(added).toHaveLength(1);
  expect(added[0]).toEqual({ ...added[0], sample_id: id, kind: "comment", body: "Deleted sample record · Genuine deleted text",
    asset_key: null, asset_file_id: null, thumbnail_file_id: null,
    metadata_json: JSON.stringify({ action: "sample_record_deleted", originalEventId: created.id, hadAsset: false }), actor_email: actor, created_at: updatedAt });
  expect(after).toEqual({ ...before, events: before.events!.map(row => row.id === created.id ? deleted : row).concat(added),
    samples: before.samples!.map(row => row.id === id ? { ...row, updated_by: actor, updated_at: updatedAt } : row) });
  const normal = await f.request(`/api/samples/${id}`, "GET", undefined, alice); expect(normal.status).toBe(200); expect(normal.value).toEqual(await originalWire(f, id));
  const processing = await f.request(`/api/samples/${id}?view=processing`, "GET", undefined, alice);
  expect(processing.status).toBe(200); expect(processing.value).toEqual(await originalWire(f, id, true)); expect(processing.value).not.toHaveProperty("events");
  const captured = f.capturedRemove()!;
  await expect(f.remove.perform(captured.request, captured.token)).rejects.toThrow();
  await expect(f.remove.perform(new Request(captured.request.url, { method: "DELETE" }), captured.token)).rejects.toThrow();
  await expect(f.remove.perform(captured.request, { kind: captured.token.kind } as SampleRecordRemovePermissionRequest)).rejects.toThrow();
  expect((await f.request(`/api/samples/${id}/records/${created.id}`, "DELETE", undefined, alice)).status).toBe(503);
  expect((await f.request(`/api/samples/${id}/records/${crypto.randomUUID()}`, "DELETE", undefined, alice)).status).toBe(404);
  expect(business(f)).toEqual(after); expect(f.recordBodyReads()).toBe(1);
}), 20000);

it("requires independent current Sample edit for deletion even when read operate workspace visibility or administrator identity exists", () => original(async () => {
  const f = await fixture(), alice = await f.login("alice"), bob = await f.login("bob"), admin = await f.login("system.operator"), charlie = await f.login("charlie"), id = await fresh(f, alice), created = await record(f, id, alice);
  const route = `/api/samples/${id}/records/${created.id}`, before = business(f);
  expect((await f.request(route, "DELETE")).status).toBe(401);
  for (const actor of [bob, admin, charlie]) expect((await f.request(route, "DELETE", undefined, actor)).status).toBe(403);
  expect(business(f)).toEqual(before);
  const root = f.native.prepare("SELECT revision FROM collaboration_resources WHERE root_kind='sample' AND root_id=?").get(id)!;
  expect((await f.request(`/api/collaboration/resources/sample/${id}/visibility`, "PUT", { operation: "visibility", expectedResourceRevision: root.revision, visibility: "workspace" }, alice)).status).toBe(200);
  expect((await f.request(`/api/samples/${id}`, "GET", undefined, bob)).status).toBe(200);
  expect((await f.request(route, "DELETE", undefined, bob)).status).toBe(403);
  await grant(f, alice, id, "read"); expect((await f.request(route, "DELETE", undefined, bob)).status).toBe(403);
  await grant(f, alice, id, "operate"); expect((await f.request(route, "DELETE", undefined, bob)).status).toBe(403);
  await grant(f, alice, id, "edit"); const result = await f.request(route, "DELETE", undefined, bob); expect(result.status).toBe(200);
  const deleted = f.native.prepare("SELECT metadata_json FROM events WHERE id=?").get(created.id)!;
  expect(JSON.parse(text(deleted.metadata_json)).deletedBy).toBe(`local-account:${source.bob}`);
  expect((await f.request(`/api/samples/${id}`, "GET", undefined, bob)).status).toBe(200);
  expect(f.native.prepare("SELECT can_create_samples FROM collaboration_members WHERE member_id=?").get(source.bobMember)?.can_create_samples).toBe(0);
}), 20000);

it("holds a real writer during DATA capture and rejects late record and history changes before original private projections", () => original(async () => {
  const f = await fixture(), alice = await f.login("alice"), id = await fresh(f, alice), created = await record(f, id, alice, "Original captured private text"), before = business(f);
  const prepare = f.native.prepare, exec = f.native.exec; let armed = false, busy = false, committed = false, eventReads = 0;
  f.native.prepare = (...args) => {
    if (f.native.isTransaction && args[0] === SAMPLE_RECORD_REMOVE_SOURCE_CAPTURE_SQL) {
      armed = true; if (!busy) { busy = true; expect(f.independent("UPDATE events SET body=? WHERE id=?", "Busy rejected text", created.id)).toBe("busy"); }
    }
    if (args[0].includes("SELECT id, kind, body, asset_key,")) eventReads++;
    return Reflect.apply(prepare, f.native, args);
  };
  f.native.exec = sql => { const value = Reflect.apply(exec, f.native, [sql]); if (armed && !committed && sql === "COMMIT") {
    committed = true; expect(f.independent("UPDATE events SET body=? WHERE id=?", "Independent changed text", created.id)).toBe("1");
  } return value; };
  try { expect((await f.request(`/api/samples/${id}/records/${created.id}`, "DELETE", undefined, alice)).status).toBe(409); }
  finally { f.native.prepare = prepare; f.native.exec = exec; }
  expect(armed).toBe(true); expect(busy).toBe(true); expect(committed).toBe(true); expect(eventReads).toBe(0);
  expect(business(f)).toEqual({ ...before, events: before.events!.map(row => row.id === created.id ? { ...row, body: "Independent changed text" } : row) });
  // Only restore the preceding negative body fault, never issue positive authority.
  expect(f.independent("UPDATE events SET body=? WHERE id=?", text(created.event.body), created.id)).toBe("1");
  const current = business(f); armed = false; committed = false; let detailReads = 0;
  f.native.prepare = (...args) => {
    if (f.native.isTransaction && args[0] === SAMPLE_DETAIL_SOURCE_CAPTURE_SQL) armed = true;
    if (args[0].includes("SELECT * FROM visible_detail_events WHERE sample_id = ?")) detailReads++;
    return Reflect.apply(prepare, f.native, args);
  };
  f.native.exec = sql => { const value = Reflect.apply(exec, f.native, [sql]); if (armed && !committed && sql === "COMMIT") {
    committed = true; expect(f.independent("UPDATE events SET body=? WHERE id=?", "Changed after history DATA capture", created.id)).toBe("1");
  } return value; };
  let response: Awaited<ReturnType<SampleRecordLifecycleFixture["request"]>>;
  try { response = await f.request(`/api/samples/${id}`, "GET", undefined, alice); }
  finally { f.native.prepare = prepare; f.native.exec = exec; }
  expect(response.status).toBe(409); expect(response.text).not.toContain("Original captured private text"); expect(response.text).not.toContain("Changed after history DATA capture");
  expect(armed).toBe(true); expect(committed).toBe(true); expect(detailReads).toBe(0);
  expect(business(f)).toEqual({ ...current, events: current.events!.map(row => row.id === created.id ? { ...row, body: "Changed after history DATA capture" } : row) });
}), 20000);

it("retains the original accepted deletion and audit after COMMIT while refusing its late revoked acknowledgment and replay", () => original(async () => {
  const f = await fixture(), alice = await f.login("alice"), bob = await f.login("bob"), id = await fresh(f, alice), created = await record(f, id, alice);
  await grant(f, alice, id, "edit"); const before = business(f), prepare = f.native.prepare, exec = f.native.exec;
  let armed = false, committed = false;
  f.native.prepare = (...args) => {
    if (f.native.isTransaction && args[0].includes("UPDATE events\n       SET asset_key = ")) armed = true;
    return Reflect.apply(prepare, f.native, args);
  };
  f.native.exec = sql => { const value = Reflect.apply(exec, f.native, [sql]); if (armed && !committed && sql === "COMMIT") {
    committed = true; expect(f.independent("UPDATE collaboration_grants SET enabled=0,revision=revision+1 WHERE root_kind='sample' AND root_id=? AND member_id=?", id, source.bobMember)).toBe("1");
  } return value; };
  try { expect((await f.request(`/api/samples/${id}/records/${created.id}`, "DELETE", undefined, bob)).status).toBe(403); }
  finally { f.native.prepare = prepare; f.native.exec = exec; }
  expect(armed).toBe(true); expect(committed).toBe(true);
  const after = business(f), deleted = after.events!.find(row => row.id === created.id)!, metadata = JSON.parse(text(deleted.metadata_json)), actor = `local-account:${source.bob}`;
  expect(metadata).toEqual({ action: "sample_record", deletedAt: metadata.deletedAt, deletedBy: actor, deletionOperationId: metadata.deletionOperationId, hadAsset: false });
  const added = after.events!.filter(row => !before.events!.some(old => old.id === row.id)); expect(added).toHaveLength(1);
  expect(added[0]).toEqual({ ...added[0], sample_id: id, kind: "comment", body: `Deleted sample record · ${created.event.body}`,
    asset_key: null, asset_file_id: null, thumbnail_file_id: null,
    metadata_json: JSON.stringify({ action: "sample_record_deleted", originalEventId: created.id, hadAsset: false }), actor_email: actor, created_at: metadata.deletedAt });
  expect(deleted).toEqual({ ...created.event, metadata_json: JSON.stringify(metadata) });
  expect(after).toEqual({ ...before, events: before.events!.map(row => row.id === created.id ? deleted : row).concat(added),
    samples: before.samples!.map(row => row.id === id ? { ...row, updated_by: actor, updated_at: metadata.deletedAt } : row),
    collaboration_grants: before.collaboration_grants!.map(row => row.root_kind === "sample" && row.root_id === id && row.member_id === source.bobMember
      ? { ...row, enabled: 0, revision: typeof row.revision === "bigint" ? row.revision + 1n : Number(row.revision) + 1 } : row) });
  expect((await f.request(`/api/samples/${id}/records/${created.id}`, "DELETE", undefined, bob)).status).toBe(403);
  expect(business(f)).toEqual(after); expect((await f.request(`/api/samples/${id}`, "GET", undefined, alice)).status).toBe(200);
}), 20000);

it("refuses unknown submission media and unpaired or altered deletion history before private text while preserving exact genuine provenance", () => original(async () => {
  const f = await fixture(), alice = await f.login("alice"), id = await fresh(f, alice), created = await record(f, id, alice, "Private record provenance");
  const prepare = f.native.prepare; let originalReads = 0;
  f.native.prepare = (...args) => {
    if (args[0].includes("SELECT id, kind, body, asset_key,") || args[0].includes("SELECT * FROM visible_detail_events WHERE sample_id = ?")) originalReads++;
    return Reflect.apply(prepare, f.native, args);
  };
  try {
    const canonical = f.native.prepare("SELECT id FROM comment_submissions ORDER BY id LIMIT 1").get()!;
    for (const metadata of [{ action: "sample_record", unknown: true }, { action: "sample_record", submissionId: text(canonical.id) }, { action: "sample_record", assetKey: "negative-media-key" }]) {
      expect(f.independent("UPDATE events SET metadata_json=? WHERE id=?", JSON.stringify(metadata), created.id)).toBe("1");
      const fault = business(f), baseline = originalReads;
      expect((await f.request(`/api/samples/${id}/records/${created.id}`, "DELETE", undefined, alice)).status).toBe(503);
      const refused = await f.request(`/api/samples/${id}`, "GET", undefined, alice); expect(refused.status).toBe(503); expect(refused.text).not.toContain("Private record provenance");
      expect(originalReads).toBe(baseline); expect(business(f)).toEqual(fault);
    }
    // Exact original row restoration only reverses the preceding negative faults.
    expect(f.independent("UPDATE events SET metadata_json=? WHERE id=?", text(created.event.metadata_json), created.id)).toBe("1");
    expect((await f.request(`/api/samples/${id}/records/${created.id}`, "DELETE", undefined, alice)).status).toBe(200);
    const accepted = business(f), deleted = accepted.events!.find(row => row.id === created.id)!, audit = accepted.events!.find(row => row.id !== created.id && row.sample_id === id && JSON.parse(text(row.metadata_json)).action === "sample_record_deleted")!;
    const metadata = JSON.parse(text(deleted.metadata_json)) as Record<string, unknown>;
    expect(f.independent("UPDATE events SET metadata_json=? WHERE id=?", JSON.stringify({ ...metadata, deletionOperationId: "not-an-original-uuid" }), created.id)).toBe("1");
    let baseline = originalReads, refused = await f.request(`/api/samples/${id}`, "GET", undefined, alice);
    expect(refused.status).toBe(503); expect(refused.text).not.toContain("Private record provenance"); expect(originalReads).toBe(baseline);
    expect(f.independent("UPDATE events SET metadata_json=? WHERE id=?", text(deleted.metadata_json), created.id)).toBe("1");
    for (const sql of ["UPDATE events SET actor_email='wrong-original-actor' WHERE id=?", "UPDATE events SET body='Wrong deletion summary' WHERE id=?",
      "UPDATE events SET created_at='1970-01-01T00:00:00.000Z' WHERE id=?"]) {
      expect(f.independent(sql, text(audit.id))).toBe("1"); const fault = business(f); baseline = originalReads;
      refused = await f.request(`/api/samples/${id}`, "GET", undefined, alice);
      expect(refused.status).toBe(503); expect(refused.text).not.toContain("Private record provenance"); expect(originalReads).toBe(baseline); expect(business(f)).toEqual(fault);
      expect(f.independent("UPDATE events SET actor_email=?,body=?,created_at=? WHERE id=?", text(audit.actor_email), text(audit.body), text(audit.created_at), text(audit.id))).toBe("1");
    }
    expect(business(f)).toEqual(accepted); expect((await f.request(`/api/samples/${id}`, "GET", undefined, alice)).status).toBe(200);
  } finally { f.native.prepare = prepare; }
}), 20000);

it("samples session time after a genuine held writer and refuses disabled V28 without undoing accepted or unrelated history", () => original(async () => {
  const f = await fixture(), alice = await f.login("alice"), id = await fresh(f, alice), created = await record(f, id, alice), before = business(f);
  let held: ReturnType<SampleRecordLifecycleFixture["holdExpires"]> | undefined;
  f.afterRemoveCapture(async () => { f.afterRemoveCapture(); held = f.holdExpires(source.alice); await held.ready; });
  expect((await f.request(`/api/samples/${id}/records/${created.id}`, "DELETE", undefined, alice)).status).toBe(401);
  await held!.close(); expect(business(f)).toEqual(before); await f.close();
  const path = await privateCopy(source.databasePath); expect(await hashClosedLogicalDatabase(path)).toBe(source.databaseSha256);
  expect((await operator(path, { kind: "set-enforcement", enforcement: "disabled", expectedControlRevision: 2 })).controlRevision).toBe(3);
  const disabled = await sampleRecordLifecycleFixture(path), session = await disabled.login("alice"), unchanged = business(disabled);
  expect((await disabled.request(`/api/samples/reference-sample-a/records/${crypto.randomUUID()}`, "DELETE", undefined, session)).status).toBe(503);
  expect(business(disabled)).toEqual(unchanged);
}), 20000);

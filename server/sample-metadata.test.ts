import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSampleMetadataService, type SampleMetadataService } from "../worker/samples/metadata-service";
import { createSampleMetadataSurface } from "../worker/samples/metadata-surface";
import type { ConfigurationSqlDatabase } from "../worker/runtime/configuration-sql";
import { createNodeHttpServer } from "./http";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { asStorageConfigurationSqlDatabase } from "./storage-configuration-sql";

const actor = "local-account:local_sample_fixture", initial = "2026-08-01T10:00:00.000Z";
let directory = "", pristine = "", sequence = 0;
const cores: SqliteCapability[] = [], servers: Server[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "rt1-sample-metadata-")); pristine = join(directory, "pristine.sqlite");
  const database = new DatabaseSync(pristine, { allowExtension: false });
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) database.exec(readFileSync(new URL(name, migrations), "utf8"));
  } finally { database.close(); }
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const core of cores.splice(0)) core.close();
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const filename = join(directory, `${++sequence}.sqlite`); copyFileSync(pristine, filename);
  const database = new DatabaseSync(filename, { allowExtension: false }), core = createSqliteCapability(database);
  cores.push(core);
  const sql = asStorageConfigurationSqlDatabase(core);
  let now = Date.parse(initial), currentActor = actor;
  // A deterministic trusted policy witness, not a persisted local identity,
  // login or production installation fence. No headers select this policy.
  const admit = vi.fn(async (selected: string) => {
    if (selected !== currentActor) throw new HTTPException(403, { message: "Fixture account admission denied" });
  });
  const selectDatabase = vi.fn(() => sql);
  const service = createSampleMetadataService({ database: selectDatabase, admit, now: () => now, randomId: () => crypto.randomUUID() });
  const connect = () => {
    const peerDatabase = new DatabaseSync(filename, { allowExtension: false }), peer = createSqliteCapability(peerDatabase);
    cores.push(peer); return { database: peerDatabase, core: peer, sql: asStorageConfigurationSqlDatabase(peer) };
  };
  return { database, core, sql, service, admit, selectDatabase, connect,
    setTime(value: number) { now = value; }, revoke() { currentActor = ""; } };
}
async function seed(service: SampleMetadataService, code = "S-001") { return (await service.create({ code, title: "Sample one", description: "Initial description", location: "Box 1" }, actor)).id; }
async function listening(service: SampleMetadataService) {
  type Bindings = { service: SampleMetadataService };
  const app = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>().basePath("/api");
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status)
    : c.json({ error: "Unexpected server error" }, 500));
  app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
  app.route("/", createSampleMetadataSurface<Bindings>((_request, bindings) => bindings.service));
  const server = createNodeHttpServer(request => app.fetch(request, { service }), { publicOrigin: "https://sample-fixture.test" });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected private loopback listener");
  return { invoke: (path: string, method: string, value: unknown) => fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method, headers: { "content-type": "application/json", "cf-access-authenticated-user-email": "forged-admin@example.test" }, body: JSON.stringify(value),
  }) };
}

describe("bounded Samples metadata service on actual Node SQLite", () => {
  it("runs all four shared routes over real Node HTTP with trimming, no-op, audit and soft-delete restoration", async () => {
    const f = fixture(), live = await listening(f.service);
    const created = await live.invoke("/samples", "POST", { code: " S-001 ", title: " Sample one ", description: " initial ", location: " Box 1 " });
    expect(created.status).toBe(201); const { id } = await created.json() as { id: string };
    expect(await f.sql.prepare("SELECT code,title,description,created_by FROM samples WHERE id=?").bind(id).first())
      .toEqual({ code: "S-001", title: "Sample one", description: "initial", created_by: actor });
    f.setTime(Date.parse(initial) + 10);
    const updated = await live.invoke(`/samples/${id}`, "PATCH", { title: " Renamed ", description: "  ", expectedUpdatedAt: initial, pinned: true });
    expect(updated.status).toBe(200); const revision = (await updated.json() as { updatedAt: string }).updatedAt;
    expect(await f.sql.prepare("SELECT title,description,pinned,updated_by FROM samples WHERE id=?").bind(id).first())
      .toEqual({ title: "Renamed", description: null, pinned: 1n, updated_by: actor });
    const audit = await f.sql.prepare("SELECT metadata_json,actor_email FROM events WHERE sample_id=? AND kind='comment'").bind(id).first();
    expect(JSON.parse(String(audit?.metadata_json))).toEqual({ action: "sample_details_updated", changes: { title: { from: "Sample one", to: "Renamed" } } });
    expect(audit?.actor_email).toBe(actor);
    expect(await f.sql.prepare("SELECT body,actor_email FROM events WHERE sample_id=? AND kind='status'").bind(id).first())
      .toEqual({ body: "Sample pinned", actor_email: actor });
    expect(await (await live.invoke(`/samples/${id}`, "PATCH", { expectedUpdatedAt: revision })).json()).toEqual({ ok: true, updatedAt: revision });
    expect((await live.invoke(`/samples/${id}`, "PATCH", { expectedUpdatedAt: initial, title: "Stale" })).status).toBe(409);
    expect((await live.invoke(`/samples/${id}`, "PATCH", { expectedUpdatedAt: revision, code: "REPLACED" })).status).toBe(400);
    expect((await live.invoke("/samples", "POST", { code: "S-001", title: "Duplicate" })).status).toBe(409);
    const child = await seed(f.service, "CHILD");
    await f.sql.batch([f.sql.prepare("UPDATE samples SET parent_id=? WHERE id=?").bind(id, child)]);
    f.setTime(0); // Delete/restore retain the existing monotonic clock rule.
    const removed = await live.invoke(`/samples/${id}`, "DELETE", { confirmationCode: "S-001", expectedUpdatedAt: revision });
    expect(removed.status).toBe(200); const removal = await removed.json() as { updatedAt: string };
    expect(removal).toEqual({ ok: true, updatedAt: new Date(Date.parse(revision) + 1).toISOString(),
      deleted: { runs: 0, steps: 0, events: 3, verifications: 0, childrenDetached: 0 } });
    expect(await f.sql.prepare("SELECT parent_id FROM samples WHERE id=?").bind(child).first()).toEqual({ parent_id: id });
    const restored = await live.invoke(`/samples/${id}/restore`, "POST", { confirmationCode: "S-001", expectedUpdatedAt: removal.updatedAt });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ ok: true, updatedAt: new Date(Date.parse(removal.updatedAt) + 1).toISOString() });
    expect(await f.sql.prepare("SELECT deleted_at,deleted_by,code FROM samples WHERE id=?").bind(id).first()).toEqual({ deleted_at: null, deleted_by: null, code: "S-001" });
  });

  it("rejects malformed and forbidden metadata before trusted admission or database selection", async () => {
    const f = fixture();
    for (const value of [null, [], 42, { code: 1, title: "name" }]) await expect(f.service.create(value, actor)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.update("missing", { code: "replacement", expectedUpdatedAt: initial }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.remove("missing", null, actor)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.restore("missing", [], actor)).rejects.toMatchObject({ status: 400 });
    expect(f.admit).not.toHaveBeenCalled(); expect(f.selectDatabase).not.toHaveBeenCalled();
  });

  it("requires current trusted admission before work, before a final mutation, and before a no-op acknowledgement", async () => {
    const f = fixture(), id = await seed(f.service); f.admit.mockClear(); f.selectDatabase.mockClear();
    f.revoke();
    await expect(f.service.update(id, { expectedUpdatedAt: initial, title: "Denied" }, actor)).rejects.toMatchObject({ status: 403 });
    expect(f.selectDatabase).not.toHaveBeenCalled();
    let admissions = 0;
    const guarded = createSampleMetadataService({ database: () => f.sql, now: () => Date.parse(initial) + 100,
      randomId: () => crypto.randomUUID(), admit: async selected => {
        expect(selected).toBe(actor); if (++admissions === 2) throw new HTTPException(503, { message: "Fixture source fenced" });
      } });
    await expect(guarded.update(id, { expectedUpdatedAt: initial, title: "Fenced" }, actor)).rejects.toMatchObject({ status: 503 });
    expect(await f.sql.prepare("SELECT title,updated_at FROM samples WHERE id=?").bind(id).first()).toEqual({ title: "Sample one", updated_at: initial });
    admissions = 0;
    await expect(guarded.update(id, { expectedUpdatedAt: initial }, actor)).rejects.toMatchObject({ status: 503 });
  });

  it("keeps CAS and title-audit ownership with two real independent connections", async () => {
    const f = fixture(), id = await seed(f.service), peer = f.connect();
    const winner = createSampleMetadataService({ database: () => peer.sql, admit: async () => {},
      now: () => Date.parse(initial) + 200, randomId: () => crypto.randomUUID() });
    let admissions = 0;
    const loser = createSampleMetadataService({ database: () => f.sql, now: () => Date.parse(initial) + 100,
      randomId: () => crypto.randomUUID(), admit: async () => { if (++admissions === 2) await winner.update(id, { expectedUpdatedAt: initial, title: "Winner" }, actor); } });
    await expect(loser.update(id, { expectedUpdatedAt: initial, title: "Loser" }, actor)).rejects.toMatchObject({ status: 409 });
    expect(await f.sql.prepare("SELECT title FROM samples WHERE id=?").bind(id).first()).toEqual({ title: "Winner" });
    const events = (await f.sql.prepare("SELECT body FROM events WHERE sample_id=? AND kind='comment'").bind(id).all()).results;
    expect(events).toEqual([{ body: "Sample name changed from Sample one to Winner" }]);
  });

  it("rolls back the actual sample and audit batch when a database audit trigger rejects it", async () => {
    const f = fixture(), id = await seed(f.service); f.setTime(Date.parse(initial) + 100);
    f.database.exec("CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'fixture audit rejected'); END");
    await expect(f.service.update(id, { expectedUpdatedAt: initial, title: "Must roll back" }, actor)).rejects.toThrow("fixture audit rejected");
    await expect(f.service.create({ code: "ROLLBACK", title: "Must roll back" }, actor)).rejects.toThrow("fixture audit rejected");
    expect(await f.sql.prepare("SELECT code,title,updated_at FROM samples").all()).toEqual({ results: [{ code: "S-001", title: "Sample one", updated_at: initial }] });
    expect(await f.sql.prepare("SELECT count(*) n FROM events").first()).toEqual({ n: 1n });
  });

  it("preserves exact rowids and retained pinned truthiness without whole-row Number conversion", async () => {
    const f = fixture();
    await f.sql.batch([f.sql.prepare(`INSERT INTO samples(rowid,id,code,title,pinned,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).bind(9007199254740993n, "exact", "EXACT", "Exact witness", 9223372036854775807n, initial, initial)]);
    expect(await f.service.update("exact", { expectedUpdatedAt: initial, pinned: true }, actor)).toEqual({ ok: true, updatedAt: initial });
    expect(await f.sql.prepare("SELECT rowid,pinned FROM samples WHERE id='exact'").first())
      .toEqual({ rowid: 9007199254740993n, pinned: 9223372036854775807n });
    f.setTime(Date.parse(initial) + 100);
    await f.service.update("exact", { expectedUpdatedAt: initial, description: "Changed" }, actor);
    expect(await f.sql.prepare("SELECT rowid,pinned FROM samples WHERE id='exact'").first()).toEqual({ rowid: 9007199254740993n, pinned: 1n });
    await f.sql.batch([f.sql.prepare(`INSERT INTO samples(id,code,title,pinned,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind("retained", "RETAINED", "Retained affinity", "legacy-true", initial, initial)]);
    expect(await f.service.update("retained", { expectedUpdatedAt: initial, pinned: true }, actor)).toEqual({ ok: true, updatedAt: initial });
    expect(await f.sql.prepare("SELECT pinned FROM samples WHERE id='retained'").first()).toEqual({ pinned: "legacy-true" });
    // Positions are not consumed by this domain. A genuine fractional SQL
    // cell crosses the same capability untouched, never a global integer map.
    expect(await f.sql.prepare("SELECT 1000.5 AS position,9223372036854775807 AS revision").first())
      .toEqual({ position: 1000.5, revision: 9223372036854775807n });
  });

  it("retains the original uncertain-ACK error and stale retry behavior after a real committed write", async () => {
    const f = fixture(), id = await seed(f.service); f.setTime(Date.parse(initial) + 100);
    const lossy: ConfigurationSqlDatabase = { ...f.sql, async batch(items) { await f.sql.batch(items); throw new Error("Private batch ACK lost"); } };
    const service = createSampleMetadataService({ database: () => lossy, admit: async () => {},
      now: () => Date.parse(initial) + 100, randomId: () => crypto.randomUUID() });
    const live = await listening(service);
    expect((await live.invoke(`/samples/${id}`, "PATCH", { expectedUpdatedAt: initial, title: "Committed" })).status).toBe(500);
    const fresh = f.connect();
    expect(await fresh.sql.prepare("SELECT title,updated_at FROM samples WHERE id=?").bind(id).first())
      .toEqual({ title: "Committed", updated_at: new Date(Date.parse(initial) + 100).toISOString() });
    expect(await fresh.sql.prepare("SELECT count(*) n FROM events WHERE sample_id=? AND kind='comment'").bind(id).first()).toEqual({ n: 1n });
    expect((await live.invoke(`/samples/${id}`, "PATCH", { expectedUpdatedAt: initial, title: "Committed" })).status).toBe(409);
    expect((await live.invoke("/samples", "POST", { code: "S-001", title: "Retry create" })).status).toBe(409);
  });

  it("preserves missing, confirmation and revision errors for delete and restore", async () => {
    const f = fixture(), id = await seed(f.service), value = { confirmationCode: "S-001", expectedUpdatedAt: initial };
    await expect(f.service.remove("missing", value, actor)).rejects.toMatchObject({ status: 404, message: "Sample not found" });
    await expect(f.service.restore(id, value, actor)).rejects.toMatchObject({ status: 404, message: "Deleted sample not found" });
    await expect(f.service.remove(id, { ...value, confirmationCode: "wrong" }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.remove(id, { ...value, expectedUpdatedAt: "stale" }, actor)).rejects.toMatchObject({ status: 409 });
    const deleted = await f.service.remove(id, value, actor);
    await expect(f.service.restore(id, { ...value, expectedUpdatedAt: "stale" }, actor)).rejects.toMatchObject({ status: 409 });
    await expect(f.service.restore(id, { ...value, confirmationCode: "wrong", expectedUpdatedAt: deleted.updatedAt }, actor)).rejects.toMatchObject({ status: 400 });
    expect(await f.service.restore(id, { ...value, expectedUpdatedAt: deleted.updatedAt }, actor)).toMatchObject({ ok: true });
  });
});

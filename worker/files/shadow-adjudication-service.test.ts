import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { readShadowBaseline } from "./shadow-baseline";
import { acceptShadowAdjudication, prepareShadowAdjudication, readShadowAdjudication, revokeShadowAdjudication,
  withdrawShadowAdjudication, readShadowAdjudicationRevocation, type ShadowAdjudicationContext, type ShadowAdjudicationResult } from "./shadow-adjudication-service";
import { convertShadowConsumer, cancelShadowOperation, type ShadowServiceContext } from "./shadow-service";
import type { ShadowAdjudicationRequest } from "../../shared/contracts/file-shadow-adjudication";
import type { LiveConsumerDatabase } from "./live-consumer-baseline";
import type { ByteReadResult } from "./byte-reader";
import type { ByteWriteInput } from "./byte-writer";

const databases: DatabaseSync[] = [];
let fixtureDirectory: string | undefined;
let nextFixture = 0;
const pristinePaths = new Map<string, string>();
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

function fixtureImage(database: DatabaseSync) {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all() as { name: string }[];
  const withoutRowid = new Set((database.prepare("PRAGMA table_list").all() as { name: string; wr: number }[])
    .filter((table) => table.wr === 1).map((table) => table.name));
  return { schema, tables: Object.fromEntries(tables.map(({ name }) => {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as { name: string; pk: number }[];
    const primaryKey = columns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((column) => quoteIdentifier(column.name));
    const storageTypes = columns.map((column, index) =>
      `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`_fixture_type_${index}`)}`).join(",");
    const rows = database.prepare(withoutRowid.has(name)
      ? `SELECT *,${storageTypes} FROM ${quoteIdentifier(name)} ORDER BY ${primaryKey.join(",")}`
      : `SELECT rowid AS _fixture_rowid,*,${storageTypes} FROM ${quoteIdentifier(name)} ORDER BY rowid`);
    rows.setReadBigInts(true);
    return [name, rows.all()];
  })) };
}

beforeAll(() => {
  // Keep all current and historical fixture generations, running each actual
  // migration chain once. Every scenario opens its own physical copy and
  // retains the original seeds, fresh request UUIDs and runtime changes.
  fixtureDirectory = mkdtempSync(join(tmpdir(), "fp5-shadow-adjudication-"));
  for (const throughMigration of [undefined, "0008_fp1_shadow_runtime.sql", "0009_fp1_shadow_withdrawals.sql"]) {
    const database = referenceTestDatabase({ throughMigration });
    const path = join(fixtureDirectory, `pristine-${throughMigration ?? "current"}.sqlite`);
    try {
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      const expected = fixtureImage(database);
      database.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
      const cloned = new DatabaseSync(path, { readOnly: true });
      try {
        expect(fixtureImage(cloned)).toEqual(expected);
        expect(cloned.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        cloned.close();
      }
      pristinePaths.set(throughMigration ?? "current", path);
    } finally {
      database.close();
    }
  }
});

function pristineDatabase(options: { throughMigration?: string }) {
  const pristinePath = pristinePaths.get(options.throughMigration ?? "current");
  if (!fixtureDirectory || !pristinePath) throw new Error("The canonical shadow adjudication fixture has not been initialized");
  const path = join(fixtureDirectory, `scenario-${nextFixture++}.sqlite`);
  copyFileSync(pristinePath, path);
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  databases.push(database);
  return database;
}

const now = "2026-09-28T08:00:00.000Z";
const bytes = new TextEncoder().encode("historical research bytes");
const sha = createHash("sha256").update(bytes).digest("hex");
const key = (consumerId = "content-a") => ({ consumerKind: "project_content_attachment" as const, consumerId, consumerSubId: "", fileSlot: "primary" as const });
function fixture(options: { throughMigration?: string } = {}) {
  const sql = pristineDatabase(options);
  sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
    VALUES('asset','historical/source','registry.png','image/png',?,'ready',?,?)`).run(bytes.byteLength, sha, now);
  for (const suffix of ["a", "b"]) {
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

function loseRunAck(f: ReturnType<typeof fixture>, fragment: string, committed: boolean) {
  const prepare = f.local.prepare.bind(f.local); let intercepted = false;
  vi.spyOn(f.local, "prepare").mockImplementation(query => {
    const statement = prepare(query);
    if (query.includes(fragment) && !intercepted) {
      intercepted = true;
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...values) => {
        const bound = bind(...values), run = bound.run.bind(bound);
        vi.spyOn(bound, "run").mockImplementation(async () => { if (committed) await run(); throw new Error("Lost acknowledgement"); });
        return bound;
      });
    }
    return statement;
  });
}
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => { if (db.isOpen) db.close(); }); });
afterAll(() => {
  databases.splice(0).forEach(db => { if (db.isOpen) db.close(); });
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
});

describe("historical Project R2 operator adjudication", () => {
  it("accepts one exact occurrence without approving its shared-locator peer or manufacturing a generation", async () => {
    const f = fixture(), before = await readShadowBaseline(f.db, key()), request = await f.request();
    expect(f.assertProfile).not.toHaveBeenCalled();
    const accepted = await acceptShadowAdjudication(f.context, request);
    expect(accepted).toMatchObject({ requestId: request.requestId, status: "accepted", request, createdBy: "operator", createdAt: now, revocation: null });
    const baseline = await readShadowBaseline(f.db, key());
    expect(baseline).toMatchObject({ status: "ready_to_verify", purpose: "research_source", sourceProfile: request.sourceProfile,
      adjudication: { requestId: request.requestId, requestSha256: accepted.requestSha256 }, reasons: [] });
    expect(baseline.head).toEqual(before.head); expect(baseline.epoch).toBe(before.epoch + 1);
    expect(baseline.record).toEqual(before.record);
    expect(baseline.baselineSha256).not.toBe(before.baselineSha256);
    expect(await readShadowBaseline(f.db, key("content-b"))).toMatchObject({ status: "ambiguous", purpose: null, sourceProfile: null, adjudication: null,
      reasons: ["consumer_purpose_unresolved", "namespace_evidence_missing"] });
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_namespace_evidence").get()!.n).toBe(0);
    expect(await acceptShadowAdjudication(f.context, request)).toEqual(accepted);
    expect(await readShadowAdjudication(f.context, request)).toEqual(accepted);
    expect(f.assertProfile).toHaveBeenCalledOnce();
  });

  it("captures the overlay and epoch together before a concurrent revocation", async () => {
    const f = fixture(), accepted = await acceptShadowAdjudication(f.context, await f.request());
    const before = await readShadowBaseline(f.db, key());
    let capturedQueries = 0;
    const concurrent: LiveConsumerDatabase = { prepare(query) {
      const statement = f.local.prepare(query);
      return { bind(...values) {
        const bound = statement.bind(...values);
        return { bind() { throw new Error("Unexpected rebind"); }, async all<T>() {
          capturedQueries += 1;
          const result = await bound.all<T>();
          await f.revoke(accepted);
          return result;
        } };
      }, all() { throw new Error("Expected bound metadata statement"); } };
    } };
    const snapshot = await readShadowBaseline(concurrent, key());
    expect(capturedQueries).toBe(1); expect(snapshot).toEqual(before);
    const after = await readShadowBaseline(f.db, key());
    expect(after.adjudication).toBeNull(); expect(after.epoch).toBe(before.epoch + 1);
  });

  it("returns exact readback after acceptance acknowledgement loss and preserves unknown uncommitted requests", async () => {
    const f = fixture(), request = await f.request(); loseRunAck(f, "INSERT INTO file_shadow_adjudications", true);
    expect(await acceptShadowAdjudication(f.context, request)).toMatchObject({ status: "accepted", request });
    const g = fixture(), unknown = await g.request(); loseRunAck(g, "INSERT INTO file_shadow_adjudications", false);
    await expect(acceptShadowAdjudication(g.context, unknown)).rejects.toThrow(/outcome is unavailable/);
    expect(await readShadowAdjudication(g.context, unknown)).toBeNull();
    expect(await withdrawShadowAdjudication(g.context, unknown)).toMatchObject({ status: "withdrawn", request: unknown });
    expect(await acceptShadowAdjudication(g.context, unknown)).toMatchObject({ status: "withdrawn" });
  });

  it("durably withdraws absent exact requests including opaque identity and forbids changed input or actor", async () => {
    const f = fixture(), request = await f.request(); request.key.consumerId = "historical\0opaque";
    const withdrawn = await withdrawShadowAdjudication(f.context, request);
    expect(withdrawn).toMatchObject({ status: "withdrawn", request });
    expect(await withdrawShadowAdjudication(f.context, request)).toEqual(withdrawn);
    expect(await acceptShadowAdjudication(f.context, request)).toEqual(withdrawn);
    await expect(withdrawShadowAdjudication(f.context, { ...request, purposeStatement: "Changed" })).rejects.toThrow(/different input/);
    await expect(readShadowAdjudication({ ...f.context, actor: "another" }, request)).rejects.toThrow(/another actor/);
    expect(f.assertProfile).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_adjudications").get()!.n).toBe(0);
  });

  it("allows withdrawal to win against an acceptance paused before the durable insert", async () => {
    const f = fixture(), request = await f.request();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.assertProfile.mockImplementation(async () => { enter(); await gate; });
    const accepting = acceptShadowAdjudication(f.context, request); await entered;
    const withdrawn = await withdrawShadowAdjudication(f.context, request); release();
    expect(await accepting).toEqual(withdrawn);
  });

  it.each(["parent", "registry", "runtime", "profile"])("fences %s changes between review and durable acceptance", async change => {
    const f = fixture(), request = await f.request();
    f.assertProfile.mockImplementation(async () => {
      if (change === "parent") f.sql.prepare("UPDATE projects SET title='Renamed',revision=revision+1,last_mutation_id='rename',updated_at=? WHERE id='project-a'").run(now);
      if (change === "registry") f.sql.prepare("UPDATE assets SET sha256=? WHERE id='asset'").run("b".repeat(64));
      if (change === "runtime") f.sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='operator',updated_at=?").run(crypto.randomUUID(), now);
      if (change === "profile") f.sql.prepare("INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES('profile',1,'operator',?)").run(now);
    });
    await expect(acceptShadowAdjudication(f.context, request)).rejects.toThrow(/outcome is unavailable/);
    expect(await readShadowAdjudication(f.context, request)).toBeNull();
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_adjudications").get()!.n).toBe(0);
  });

  it("revokes and corrects append-only on the same generation, requiring fresh explicit review", async () => {
    const f = fixture(), original = await f.request(), first = await acceptShadowAdjudication(f.context, original), head = (await readShadowBaseline(f.db, key())).head;
    const revoked = await f.revoke(first);
    expect(revoked).toMatchObject({ status: "revoked", request: original, revocation: { createdBy: "operator" } });
    expect(await readShadowBaseline(f.db, key())).toMatchObject({ adjudication: null, purpose: null, sourceProfile: null, status: "ambiguous" });
    expect(await revokeShadowAdjudication(f.context, revoked.revocation!.request)).toEqual(revoked);
    const correction = await f.request(); correction.purposeStatement = "Corrected present-day classification";
    expect(correction.supersedesId).toBe(original.requestId);
    const second = await acceptShadowAdjudication(f.context, correction);
    expect(second.status).toBe("accepted"); expect((await readShadowBaseline(f.db, key())).head).toEqual(head);
    expect(await readShadowAdjudication(f.context, original)).toEqual(revoked);
    expect(f.sql.prepare("SELECT count(*) n FROM file_shadow_adjudications").get()!.n).toBe(2);
  });

  it("keeps history after source replacement and never applies an old occurrence approval to a new one", async () => {
    const f = fixture(), request = await f.request(); await acceptShadowAdjudication(f.context, request);
    f.sql.prepare("UPDATE projects SET title='Replacement title',revision=revision+1,last_mutation_id='rename',updated_at=? WHERE id='project-a'").run(now);
    const next = await readShadowBaseline(f.db, key());
    expect(next.head!.occurrence_id).not.toBe(request.occurrenceId);
    expect(next).toMatchObject({ status: "ambiguous", adjudication: null, purpose: null });
    expect(await readShadowAdjudication(f.context, request)).toMatchObject({ status: "accepted", request });
  });

  it("publishes an explicitly converted approved source with immutable binding and leaves the peer blocked", async () => {
    const f = fixture(), c = conversionFixture(f); c.pause();
    const request = await f.request(), accepted = await acceptShadowAdjudication(f.context, request);
    c.resume(); const operation = await c.request();
    expect(await readShadowBaseline(f.db, key())).toMatchObject({ status: "ready_to_verify", adjudication: { requestId: request.requestId } });
    const converted = await convertShadowConsumer(c.context, operation);
    expect(converted).toMatchObject({ status: "resolved", attemptState: "published" }); expect(c.write).toHaveBeenCalledOnce();
    expect(f.sql.prepare("SELECT * FROM file_shadow_operation_adjudications").all()).toEqual([
      { operation_id: operation.operationId, adjudication_id: request.requestId, adjudication_request_sha256: accepted.requestSha256 },
    ]);
    expect(await readShadowBaseline(f.db, key("content-b"))).toMatchObject({ status: "ambiguous", adjudication: null, purpose: null });
    c.pause();
    expect(await prepareShadowAdjudication(f.context, key())).toMatchObject({ revocable: false, revocationBlockers: ["accepted_operations_require_recovery"] });
    await expect(f.revoke(accepted)).rejects.toThrow(/resolve every accepted operation/);
  });

  it("keeps a cancelled operation bound to the superseded adjudication when a correction follows", async () => {
    const f = fixture(), c = conversionFixture(f); c.pause();
    const first = await acceptShadowAdjudication(f.context, await f.request());
    c.resume(); const operation = await c.request();
    c.objects.delete("historical/source");
    expect(await convertShadowConsumer(c.context, operation)).toMatchObject({ status: "pending", attemptState: "failed" });
    expect(await cancelShadowOperation(c.context, operation)).toMatchObject({ status: "cancelled" });
    c.pause();
    expect(await prepareShadowAdjudication(f.context, key())).toMatchObject({ revocable: true, revocationBlockers: [] });
    await f.revoke(first);
    const second = await acceptShadowAdjudication(f.context, await f.request());
    expect(f.sql.prepare("SELECT adjudication_id FROM file_shadow_operation_adjudications WHERE operation_id=?").get(operation.operationId)!.adjudication_id).toBe(first.requestId);
    expect((await readShadowBaseline(f.db, key())).adjudication!.requestId).toBe(second.requestId);
    expect(c.write).not.toHaveBeenCalled();
  });

  it("supports exact cross-operator revocation readback while preserving the original acceptance actor", async () => {
    const f = fixture(), input = await f.request(), accepted = await acceptShadowAdjudication(f.context, input);
    const revocation = { requestId: crypto.randomUUID(), adjudicationId: accepted.requestId, adjudicationRequestSha256: accepted.requestSha256, reason: "Independent review correction" };
    const secondOperator = { ...f.context, actor: "reviewer" };
    expect(await readShadowAdjudicationRevocation(secondOperator, revocation)).toBeNull();
    loseRunAck(f, "INSERT INTO file_shadow_adjudication_revocations", true);
    const revoked = await revokeShadowAdjudication(secondOperator, revocation);
    expect(revoked).toMatchObject({ status: "revoked", createdBy: "operator", revocation: { createdBy: "reviewer" } });
    expect(await readShadowAdjudicationRevocation(secondOperator, revocation)).toEqual(revoked);
    await expect(readShadowAdjudicationRevocation(f.context, revocation)).rejects.toThrow(/different request or actor/);
    await expect(readShadowAdjudication(secondOperator, input)).rejects.toThrow(/another actor/);
  });

  it.each(["0008_fp1_shadow_runtime.sql", "0009_fp1_shadow_withdrawals.sql"])("preserves complete older %s baselines without an overlay", async throughMigration => {
    const f = fixture({ throughMigration });
    const baseline = await readShadowBaseline(f.db, key());
    expect(baseline).toMatchObject({ status: "ambiguous", purpose: null }); expect("adjudication" in baseline).toBe(false);
  });
});

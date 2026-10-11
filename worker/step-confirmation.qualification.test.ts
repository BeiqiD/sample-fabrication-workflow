import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { reviewedPortableMigrationSources } from "../test/reviewed-portable-migration-sources";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { d1StepConfirmationDatabase } from "./execution/confirmation-d1";
import { configurationSqlRow } from "./runtime/configuration-sql";

// SOURCE-ONLY, UNEXECUTED. Every case uses a fresh actual bundled Worker,
// genuine Miniflare DB/ASSETS, all 24 migrations and the mature reference graph.
// No fake D1/Env, mocked acknowledgement, provider bytes or JWT-success claim.
let script = "";
let native: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const path = "https://app.test/api/run-steps/confirm";
const originalTime = "2026-08-01T02:00:00.000Z";
const targets = () => [
  { sampleId: "reference-sample-a", runId: "reference-run-a", stepId: "reference-step-a", expectedUpdatedAt: originalTime },
  { sampleId: "reference-sample-b", runId: "reference-run-b", stepId: "reference-step-b", expectedUpdatedAt: originalTime },
];
function actualWorker(authMode: "disabled" | "invalid" = "disabled") {
  return new Miniflare({ modules: true, script, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], r2Buckets: ["ASSETS"], bindings: { AUTH_MODE: authMode }, log: new Log(LogLevel.ERROR) });
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", write: false });
  script = bundle.outputFiles[0].text;
}, 30_000);
beforeEach(async () => {
  native = actualWorker(); database = await native.getD1Database("DB");
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = reviewedPortableMigrationSources(26, directory).map(source => source.name);
  expect(migrations).toHaveLength(24); expect(migrations.at(-1)).toBe("0024_rt3_local_volume_profiles.sql");
  for (const name of migrations) await database.batch(splitSql(readFileSync(new URL(name, directory), "utf8"))
    .map(sql => database.prepare(sql)));
  await database.batch(splitSql(readFileSync(new URL("./fixtures/reference-graph.sql", import.meta.url), "utf8"))
    .map(sql => database.prepare(sql)));
  expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}, 30_000);
afterEach(async () => { await native?.dispose(); });

const post = (input: unknown, headers: Record<string, string> = {}) => native.dispatchFetch(path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input),
});
// Snapshot every application table in one real D1 read batch. Miniflare's own
// internal tables and SQLite internals are outside application assertions.
async function metadata(omit: readonly string[] = []) {
  const names = (await database.prepare(`SELECT name FROM sqlite_schema WHERE type='table'
    AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name`).all()).results
    .map(row => { if (typeof row.name !== "string") throw new TypeError("Invalid fixture table name"); return row.name; })
    .filter(name => !omit.includes(name));
  const results = await database.batch(names.map(name => database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY 1`)));
  return names.map((name, index) => [name, results[index].results]);
}
async function closedLeases() {
  const results = await database.batch([
    database.prepare("SELECT owner,kind,generation,released_at FROM system_recovery_write_leases ORDER BY id"),
    database.prepare("SELECT COUNT(*) n FROM system_recovery_write_leases WHERE released_at IS NULL"),
  ]);
  const rows = results[0].results.map(shadowSqlRow);
  for (const row of rows) {
    expect(row).toMatchObject({ owner: "local-development", kind: "http", generation: 0 });
    expect(typeof row.released_at).toBe("string");
  }
  expect(results[1].results.map(shadowSqlRow)[0]?.n).toBe(0);
  return rows.length;
}
async function emptyProvider() {
  expect((await (await native.getR2Bucket("ASSETS")).list()).objects).toEqual([]);
  expect((await database.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").first())?.mode).toBe("legacy");
  expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}
async function shadowEvidence() {
  const results = (await database.batch([
    database.prepare("SELECT * FROM file_shadow_dependency_versions ORDER BY dependency_kind,dependency_key,revision"),
    database.prepare("SELECT * FROM file_shadow_heads ORDER BY consumer_kind,consumer_id,consumer_sub_id,file_slot"),
    database.prepare("SELECT * FROM file_shadow_occurrences ORDER BY id"),
    database.prepare("SELECT * FROM file_shadow_closures ORDER BY occurrence_id"),
  ])).map(result => ({ ...result, results: result.results.map(shadowSqlRow) }));
  return { versions: results[0].results, heads: results[1].results,
    occurrences: results[2].results, closures: results[3].results };
}
function shadowInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError("Invalid shadow fixture integer");
  return value;
}
function isShadowObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function shadowSqlRow(value: unknown) {
  if (!isShadowObject(value)) throw new TypeError("Invalid shadow fixture SQL row");
  return configurationSqlRow(value);
}
function shadowJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new TypeError("Invalid shadow fixture JSON");
  const parsed: unknown = JSON.parse(value);
  if (!isShadowObject(parsed)) throw new TypeError("Invalid shadow fixture object");
  return parsed;
}
const shadowConsumerKey = (row: Record<string, unknown>) => JSON.stringify([
  row.consumer_kind, row.consumer_id, row.consumer_sub_id, row.file_slot,
]);
const dependencyKey = (row: Record<string, unknown>) => JSON.stringify([row.dependency_kind, row.dependency_key]);
const shadowTextOrder = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

async function exactConfirmationShadow(before: Awaited<ReturnType<typeof shadowEvidence>>) {
  const after = await shadowEvidence();
  const current = (await database.batch([
    database.prepare("SELECT id,status,deleted_at,updated_at FROM samples ORDER BY id"),
    database.prepare("SELECT id,sample_id,status,deleted_at,completed_at,last_mutation_id FROM runs ORDER BY id"),
    database.prepare("SELECT id,run_id,status,plan_status,deleted_at,updated_at,last_mutation_id FROM run_steps ORDER BY id"),
    database.prepare("SELECT * FROM file_shadow_sources ORDER BY consumer_kind,consumer_id,consumer_sub_id,file_slot"),
  ])).map(result => ({ ...result, results: result.results.map(shadowSqlRow) }));
  // One new exact dependency revision per changed Sample, Run and Step. All
  // prior versions remain immutable, including every unrelated dependency.
  const expectedVersions = ["samples", "runs", "run_steps"].flatMap((kind, index) => current[index].results.map(snapshot => {
    const key = JSON.stringify([snapshot.id]);
    const previous = before.versions.filter(row => row.dependency_kind === kind && row.dependency_key === key).at(-1);
    if (!previous) throw new Error("Missing prior shadow dependency");
    return { dependency_kind: kind, dependency_key: key, revision: shadowInteger(previous.revision) + 1,
      present: 1, snapshot_json: JSON.stringify(snapshot) };
  }));
  expect(expectedVersions).toHaveLength(6);
  const oldVersionKeys = new Set(before.versions.map(row => JSON.stringify([dependencyKey(row), row.revision])));
  expect(after.versions.filter(row => oldVersionKeys.has(JSON.stringify([dependencyKey(row), row.revision])))).toEqual(before.versions);
  const newVersions = after.versions.filter(row => !oldVersionKeys.has(JSON.stringify([dependencyKey(row), row.revision])));
  expect(newVersions.map(row => ({ ...row, snapshot_json: shadowJson(row.snapshot_json) })))
    .toEqual(expectedVersions.sort((a, b) => shadowTextOrder(dependencyKey(a), dependencyKey(b)))
      .map(row => ({ ...row, snapshot_json: shadowJson(row.snapshot_json) })));

  const oldOccurrenceIds = new Set(before.occurrences.map(row => row.id));
  const oldClosureIds = new Set(before.closures.map(row => row.occurrence_id));
  expect(after.occurrences.filter(row => oldOccurrenceIds.has(row.id))).toEqual(before.occurrences);
  expect(after.closures.filter(row => oldClosureIds.has(row.occurrence_id))).toEqual(before.closures);
  const newOccurrences = after.occurrences.filter(row => !oldOccurrenceIds.has(row.id));
  const expectedGenerations = new Map([
    [JSON.stringify(["run_step_asset", "reference-execution-image", "", "primary"]), 3],
    [JSON.stringify(["comment_submission_item", "reference-comment-attachment", "", "primary"]), 6],
  ]);
  // The execution image depends on one changed Sample/Run/Step; the shared
  // Comment attachment depends on both targets. Every advance has one exact
  // predecessor closure; no unrelated head or historical row may change.
  expect(newOccurrences).toHaveLength(9);
  expect(after.heads.map(shadowConsumerKey)).toEqual(before.heads.map(shadowConsumerKey));
  const expectedClosures: Record<string, unknown>[] = [];
  for (const oldHead of before.heads) {
    const key = shadowConsumerKey(oldHead);
    const head = after.heads.find(row => shadowConsumerKey(row) === key);
    if (!head) throw new Error("Missing current shadow head");
    const count = expectedGenerations.get(key);
    if (!count) { expect(head).toEqual(oldHead); continue; }
    const chain = newOccurrences.filter(row => shadowConsumerKey(row) === key)
      .sort((a, b) => shadowInteger(a.generation) - shadowInteger(b.generation));
    expect(chain).toHaveLength(count);
    let predecessor = oldHead.occurrence_id;
    let predecessorEpoch = shadowInteger(oldHead.observed_epoch);
    for (const [index, occurrence] of chain.entries()) {
      expect(occurrence.generation).toBe(shadowInteger(oldHead.generation) + index + 1);
      expect(occurrence).toMatchObject({ present: 1, source_rowid: oldHead.source_rowid });
      expect(typeof occurrence.id).toBe("string");
      expect(occurrence.id).toMatch(/^shadow:[0-9a-f]{32}$/);
      expect(shadowInteger(occurrence.observed_epoch)).toBeGreaterThan(predecessorEpoch);
      expect(typeof occurrence.observed_at).toBe("string");
      expect(Number.isFinite(Date.parse(String(occurrence.observed_at)))).toBe(true);
      const { _dependencies: oldDependencies, ...oldSource } = shadowJson(oldHead.source_json);
      const { _dependencies: nextDependencies, ...nextSource } = shadowJson(occurrence.source_json);
      expect(nextSource).toEqual(oldSource);
      expect(nextDependencies).not.toEqual(oldDependencies);
      expectedClosures.push({ occurrence_id: predecessor, successor_occurrence_id: occurrence.id,
        closed_epoch: occurrence.observed_epoch, closed_at: occurrence.observed_at });
      predecessor = occurrence.id;
      predecessorEpoch = shadowInteger(occurrence.observed_epoch);
    }
    const terminal = chain.at(-1);
    if (!terminal) throw new Error("Missing terminal shadow occurrence");
    expect(head).toEqual(Object.fromEntries(Object.keys(oldHead).map(field => [field,
      field === "occurrence_id" ? terminal.id : terminal[field]])));
    const source = current[3].results.find(row => shadowConsumerKey(row) === key);
    if (!source) throw new Error("Missing genuine current shadow source");
    expect(head).toMatchObject({ present: 1, source_rowid: source.source_rowid, source_json: source.source_json });
    expect(terminal).toMatchObject({ legacy_store_kind: source.legacy_store_kind, legacy_provider: source.legacy_provider,
      legacy_object_key: source.legacy_object_key, expected_purpose: source.expected_purpose });
  }
  expect(after.closures.filter(row => !oldClosureIds.has(row.occurrence_id)))
    .toEqual(expectedClosures.sort((a, b) => shadowTextOrder(String(a.occurrence_id), String(b.occurrence_id))));
}

describe("Grouped Step confirmation through the actual current Worker: five finite scopes", () => {
  it("accepts two cross-Sample targets with one operation group, exact audits, monotonic time and genuine rollup effects", async () => {
    const selected = targets(); selected[0].expectedUpdatedAt = "2098-01-01T00:00:00.000Z";
    selected[1].expectedUpdatedAt = "2099-01-01T00:00:00.000Z";
    const preservedActualization = "2090-01-01T00:00:00.000Z";
    await database.batch([
      database.prepare("UPDATE run_steps SET status='in_progress',actualized_at=?,updated_at=? WHERE id=?")
        .bind(preservedActualization, selected[0].expectedUpdatedAt, selected[0].stepId),
      database.prepare("UPDATE run_steps SET updated_at=? WHERE id=?").bind(selected[1].expectedUpdatedAt, selected[1].stepId),
    ]);
    // Mature triggers legitimately change Runs/Samples/status events and shadow
    // evidence; HTTP admission legitimately retains its released write lease.
    const changedTables = ["samples", "runs", "run_steps", "events", "file_shadow_control",
      "file_shadow_dependency_versions", "file_shadow_closures", "file_shadow_heads", "file_shadow_occurrences",
      "system_recovery_write_leases"];
    const unrelated = await metadata(changedTables);
    const beforeShadow = await shadowEvidence();
    const beforeSteps = (await database.prepare("SELECT * FROM run_steps ORDER BY id").all()).results;
    const beforeEvents = (await database.prepare("SELECT id FROM events ORDER BY id").all()).results;
    const response = await post({ targets: selected });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, confirmed: 2 });
    const steps = (await database.prepare("SELECT * FROM run_steps ORDER BY id").all()).results;
    const operationGroupId = steps[0].last_mutation_id;
    expect(operationGroupId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const now = "2099-01-01T00:00:00.001Z";
    expect(steps).toEqual(beforeSteps.map(row => ({ ...row, status: "done", updated_by: "local-development",
      updated_at: now, last_mutation_id: operationGroupId,
      actualized_at: row.id === "reference-step-a" ? preservedActualization : now })));
    expect((await database.prepare("SELECT id,status,completed_at FROM runs ORDER BY id").all()).results).toEqual([
      { id: "reference-run-a", status: "complete", completed_at: now }, { id: "reference-run-b", status: "complete", completed_at: now }]);
    expect((await database.prepare("SELECT id,status,updated_by,updated_at FROM samples ORDER BY id").all()).results).toEqual([
      { id: "reference-sample-a", status: "stored", updated_by: "local-development", updated_at: now },
      { id: "reference-sample-b", status: "stored", updated_by: "local-development", updated_at: now }]);
    const events = (await database.prepare("SELECT * FROM events ORDER BY sample_id,kind,id").all()).results
      .filter(row => !beforeEvents.some(previous => previous.id === row.id));
    expect(events).toHaveLength(4);
    const audits = events.filter(row => row.kind === "step"); expect(audits).toHaveLength(2);
    for (const [index, row] of audits.entries()) {
      expect(row).toMatchObject({ sample_id: selected[index].sampleId, kind: "step", body: "Confirmed 1 step as done",
        actor_email: "local-development", created_at: now });
      expect(JSON.parse(row.metadata_json as string)).toEqual({ action: "confirmed_done", operationGroupId, stepIds: [selected[index].stepId] });
    }
    for (const row of events.filter(row => row.kind === "status")) {
      expect(row).toMatchObject({ body: "Status changed from active to stored", actor_email: "local-development", created_at: now });
      expect(JSON.parse(row.metadata_json as string)).toEqual({ field: "status", previous: "active", current: "stored" });
    }
    expect(await metadata(changedTables)).toEqual(unrelated);
    await exactConfirmationShadow(beforeShadow);
    expect(await closedLeases()).toBe(1); await emptyProvider();
  });

  it("rejects stale timestamps and incorrect associations without confirming either target", async () => {
    const selected = targets();
    const wrongTargets = [
      [selected[0], { ...selected[1], expectedUpdatedAt: "2026-08-01T01:59:59.999Z" }],
      [selected[0], { ...selected[1], sampleId: selected[0].sampleId }],
      [selected[0], { ...selected[1], runId: selected[0].runId }],
      [selected[0], { ...selected[1], stepId: "missing-step" }],
      [selected[0], { ...selected[1], sampleId: "reference-sample-b' OR 1=1 --" }],
    ];
    let requests = 0;
    async function rejected(input: unknown, before: Awaited<ReturnType<typeof metadata>>) {
      const response = await post({ targets: input }); requests += 1;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "One or more steps changed elsewhere. Reload before confirming." });
      expect(await metadata(["system_recovery_write_leases"])).toEqual(before);
      expect(await closedLeases()).toBe(requests);
    }
    // Each full after-request equality proves the next malformed-target request
    // starts at this same baseline. Re-reading it five times adds no assertion.
    const wrongBaseline = await metadata(["system_recovery_write_leases"]);
    for (const input of wrongTargets) await rejected(input, wrongBaseline);
    expect((await database.prepare("SELECT id,status,last_mutation_id FROM run_steps ORDER BY id").all()).results).toEqual([
      { id: "reference-step-a", status: "pending", last_mutation_id: null }, { id: "reference-step-b", status: "pending", last_mutation_id: null }]);
    await emptyProvider();
  });

  it("rejects every deleted ancestor without confirming either target", async () => {
    const selected = targets();
    let requests = 0;
    async function rejected(input: unknown, before: Awaited<ReturnType<typeof metadata>>) {
      const response = await post({ targets: input }); requests += 1;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "One or more steps changed elsewhere. Reload before confirming." });
      expect(await metadata(["system_recovery_write_leases"])).toEqual(before);
      expect(await closedLeases()).toBe(requests);
    }
    for (const [table, id] of [["samples", "reference-sample-b"], ["runs", "reference-run-b"], ["run_steps", "reference-step-b"]]) {
      // Ordinary logical deletion in this isolated genuine fixture; no mature
      // schema/physical-delete/publication guard is disabled or removed.
      await database.prepare(`UPDATE ${table} SET deleted_at=? WHERE id=?`).bind("2026-08-02T00:00:00.000Z", id).run();
      // These deliberate fixture deletions change research metadata, so each
      // ancestor case still captures its own full baseline before the request.
      await rejected(selected, await metadata(["system_recovery_write_leases"]));
      await database.prepare(`UPDATE ${table} SET deleted_at=NULL WHERE id=?`).bind(id).run();
    }
    expect((await database.prepare("SELECT id,status,last_mutation_id FROM run_steps ORDER BY id").all()).results).toEqual([
      { id: "reference-step-a", status: "pending", last_mutation_id: null }, { id: "reference-step-b", status: "pending", last_mutation_id: null }]);
    await emptyProvider();
  });

  it("rolls back the real D1 batch when its second audit fails and rejects foreign statements before issuing either mutation", async () => {
    await database.prepare(`CREATE TRIGGER qualification_confirmation_audit_failure BEFORE INSERT ON events
      WHEN NEW.kind='step' AND NEW.sample_id='reference-sample-b'
      BEGIN SELECT RAISE(ABORT,'Qualification second audit failure'); END`).run();
    const before = await metadata(["system_recovery_write_leases"]);
    const response = await post({ targets: targets() });
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "Unexpected server error" });
    // Includes Runs, Samples, both kinds of audit events and all shadow evidence:
    // the separate outer HTTP lease is the only retained effect of this failure.
    expect(await metadata(["system_recovery_write_leases"])).toEqual(before);
    expect(await closedLeases()).toBe(1);
    const owned = d1StepConfirmationDatabase(database), otherOwner = d1StepConfirmationDatabase(database);
    const first = owned.prepare("UPDATE samples SET title=? WHERE id=? RETURNING id").bind("Must never write", "reference-sample-a");
    const other = otherOwner.prepare("UPDATE samples SET title=? WHERE id=? RETURNING id").bind("Foreign mutation", "reference-sample-b");
    const retained = await metadata();
    await expect(owned.atomicBatch([first, other])).rejects.toThrow("Foreign Step confirmation statement");
    await expect(owned.atomicBatch([first, database.prepare("UPDATE samples SET title='Native foreign mutation' WHERE id='reference-sample-b' RETURNING id")]))
      .rejects.toThrow("Foreign Step confirmation statement");
    expect(await metadata()).toEqual(retained); await emptyProvider();
  });

  it("keeps current authentication, maintenance and invalid-target guards ahead of business execution and preserves method ownership", async () => {
    const before = await metadata();
    const invalid = [null, {}, { targets: [] }, { targets: [null] }, { targets: [targets()[0], targets()[0]] },
      { targets: [{ ...targets()[0], expectedUpdatedAt: "" }] },
      { targets: [{ ...targets()[0], sampleId: 42 }] }, { targets: Array.from({ length: 13 }, (_, index) => ({ ...targets()[0], stepId: `step-${index}` })) }];
    for (const input of invalid) {
      const response = await post(input); expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Between 1 and 12 step targets are required" });
    }
    const crossOrigin = await post({ targets: targets() }, { origin: "https://other.test" });
    expect(crossOrigin.status).toBe(403); expect(await crossOrigin.json()).toEqual({ error: "Cross-origin writes are not allowed" });
    for (const method of ["GET", "PUT"]) expect((await native.dispatchFetch(path, { method })).status).toBe(404);
    const unauthenticated = actualWorker("invalid");
    try {
      const response = await unauthenticated.dispatchFetch(path, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: targets() }) });
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
    } finally { await unauthenticated.dispose(); }
    expect(await metadata()).toEqual(before); expect(await closedLeases()).toBe(0);
    for (const state of ["draining", "fenced"]) {
      // Seed genuine maintenance state in this private database; this does not
      // claim to exercise an administrator recovery-control workflow.
      await database.prepare("UPDATE system_recovery_maintenance SET state=?,generation=1,token='qualification-maintenance' WHERE singleton=1")
        .bind(state).run();
      const paused = await metadata();
      const malformedTarget = await post({ targets: [] }); expect(malformedTarget.status).toBe(400);
      const response = await post({ targets: targets() }); expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Source mutations are paused for system recovery" });
      expect(await metadata()).toEqual(paused); expect(await closedLeases()).toBe(0);
    }
    await emptyProvider();
  });
});

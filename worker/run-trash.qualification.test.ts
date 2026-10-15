import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { reviewedPortableMigrationSources } from "../test/reviewed-portable-migration-sources";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// UNEXECUTED source candidate. Actual bundled Worker, genuine Miniflare D1/R2
// bindings, current24 migration chain and mature reference graph per scope.
// No fabricated Env/D1, auth success, provider objects or native byte serving.
let script = "";
let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const sampleId = "reference-sample-a", runId = "reference-run-a";
const path = `https://app.test/api/samples/${sampleId}/runs/${runId}`;
function actualWorker(authMode: "disabled" | "invalid" = "disabled") {
  return new Miniflare({ modules: true, script, compatibilityDate: "2026-07-20", d1Databases: ["DB"], r2Buckets: ["ASSETS"],
    bindings: { AUTH_MODE: authMode }, log: new Log(LogLevel.ERROR) });
}
beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))], bundle: true, format: "esm", platform: "browser", write: false });
  script = result.outputFiles[0].text;
}, 30_000);
beforeEach(async () => {
  runtime = actualWorker(); database = await runtime.getD1Database("DB");
  const directory = new URL("../migrations/", import.meta.url);
  const names = reviewedPortableMigrationSources(26, directory).map(source => source.name);
  expect(names).toHaveLength(24); expect(names.at(-1)).toBe("0024_rt3_local_volume_profiles.sql");
  for (const name of names) await database.batch(splitSql(readFileSync(new URL(name, directory), "utf8")).map(sql => database.prepare(sql)));
  await database.batch(splitSql(readFileSync(new URL("./fixtures/reference-graph.sql", import.meta.url), "utf8")).map(sql => database.prepare(sql)));
}, 30_000);
afterEach(async () => { await runtime?.dispose(); });
async function revision() {
  const value = (await database.prepare("SELECT updated_at FROM samples WHERE id=?").bind(sampleId).first())?.updated_at;
  if (typeof value !== "string") throw new TypeError("Invalid real Sample revision");
  return { expectedSampleUpdatedAt: value };
}
function invoke(method: string, input: unknown, url = path, headers: Record<string, string> = {}) {
  return runtime.dispatchFetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
}
async function metadata(omit: readonly string[] = []) {
  const names = (await database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all()).results
    .map(row => { if (typeof row.name !== "string") throw new TypeError("Invalid real table name"); return row.name; }).filter(name => !omit.includes(name));
  const results = await database.batch(names.map(name => database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY 1`)));
  return names.map((name, i) => [name, results[i].results]);
}
async function physicalScope() {
  expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect((await (await runtime.getR2Bucket("ASSETS")).list()).objects).toEqual([]);
  expect((await database.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").first())?.mode).toBe("legacy");
  const leases = (await database.prepare("SELECT owner,kind,released_at FROM system_recovery_write_leases ORDER BY id").all()).results;
  for (const row of leases) { expect(row.owner).toBe("local-development"); expect(row.kind).toBe("http"); expect(typeof row.released_at).toBe("string"); }
  expect((await database.prepare("SELECT COUNT(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").first())?.n).toBe(0);
  return leases.length;
}
async function auditCount() {
  return (await database.prepare("SELECT COUNT(*) n FROM events WHERE json_extract(metadata_json,'$.action') IN ('run_deleted','run_restored')").first())?.n;
}

describe("Run trash through the actual current Worker: four finite scopes", () => {
  it("soft deletes/restores one Run with native triggers, exact audits and surviving common Comment/source metadata", async () => {
    const tables = ["run_steps", "run_step_assets", "run_step_comments", "comment_submissions", "comment_submission_targets", "comment_submission_items", "assets", "metrology_template_references"];
    const before = await database.batch(tables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY 1`)));
    const input = await revision();
    const remove = await invoke("DELETE", input); expect(remove.status).toBe(200);
    const deleted = await remove.json() as { ok: true; updatedAt: string };
    expect(deleted.ok).toBe(true); expect(Date.parse(deleted.updatedAt)).toBeGreaterThan(Date.parse(input.expectedSampleUpdatedAt));
    expect(await database.prepare("SELECT deleted_at,deleted_by FROM runs WHERE id=?").bind(runId).first()).toEqual({ deleted_at: deleted.updatedAt, deleted_by: "local-development" });
    expect((await database.prepare("SELECT status FROM samples WHERE id=?").bind(sampleId).first())?.status).toBe("stored");
    const hidden = await runtime.dispatchFetch(`https://app.test/api/samples/${sampleId}`);
    expect(hidden.status).toBe(200); expect((await hidden.json() as { runs: unknown[] }).runs).toEqual([]);
    const restore = await invoke("POST", { expectedSampleUpdatedAt: deleted.updatedAt }, path + "/restore"); expect(restore.status).toBe(200);
    const restored = await restore.json() as { ok: true; updatedAt: string }; expect(restored.updatedAt > deleted.updatedAt).toBe(true);
    expect(await database.prepare("SELECT deleted_at,deleted_by FROM runs WHERE id=?").bind(runId).first()).toEqual({ deleted_at: null, deleted_by: null });
    expect((await database.prepare("SELECT status FROM samples WHERE id=?").bind(sampleId).first())?.status).toBe("active");
    const visible = await runtime.dispatchFetch(`https://app.test/api/samples/${sampleId}`); expect(visible.status).toBe(200);
    expect((await visible.json() as { runs: { id: string }[] }).runs.map(row => row.id)).toEqual([runId]);
    const after = await database.batch(tables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY 1`)));
    expect(after.map(result => result.results)).toEqual(before.map(result => result.results));
    const events = (await database.prepare("SELECT body,metadata_json,actor_email FROM events WHERE json_extract(metadata_json,'$.action') IN ('run_deleted','run_restored') ORDER BY created_at,id").all()).results;
    expect(events).toHaveLength(2); expect(events.map(row => row.actor_email)).toEqual(["local-development", "local-development"]);
    expect(JSON.parse(String(events[0].metadata_json))).toEqual({ action: "run_deleted", deletedRunId: runId, runKind: "process", sequenceNo: 1, templateName: "Reference process", templateVersion: 3, recoverable: true });
    expect(JSON.parse(String(events[1].metadata_json))).toEqual({ action: "run_restored", restoredRunId: runId, runKind: "process", sequenceNo: 1, templateName: "Reference process", templateVersion: 3 });
    expect(await physicalScope()).toBe(2);
  });

  it("rejects stale/missing/foreign/hidden ancestors and malformed bodies before any business effect", async () => {
    const before = await metadata(["system_recovery_write_leases"]), input = await revision();
    for (const value of [null, {}, [], { expectedSampleUpdatedAt: 12 }]) {
      const response = await invoke("DELETE", value); expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "The current sample revision is required" });
    }
    const stale = await invoke("DELETE", { expectedSampleUpdatedAt: "stale" }); expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "This sample changed elsewhere. Reload it before deleting the run." });
    for (const url of [path.replace(runId, "missing"), path.replace(sampleId, "reference-sample-b"), path + "/restore"]) {
      const response = await invoke(url.endsWith("/restore") ? "POST" : "DELETE", input, url); expect(response.status).toBe(404);
    }
    expect(await metadata(["system_recovery_write_leases"])).toEqual(before); expect(await physicalScope()).toBe(4);
    await database.prepare("UPDATE samples SET deleted_at='2026-08-05T00:00:00.000Z' WHERE id=?").bind(sampleId).run();
    const deleted = await metadata(["system_recovery_write_leases"]); expect((await invoke("DELETE", input)).status).toBe(404); expect(await metadata(["system_recovery_write_leases"])).toEqual(deleted);
    expect(await physicalScope()).toBe(5);
    expect(await auditCount()).toBe(0);
  });

  it("keeps legal active/newer restoration conflicts and rolls the genuine D1 audit-failure batch back", async () => {
    const removed = await invoke("DELETE", await revision()); expect(removed.status).toBe(200);
    await database.prepare(`INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,
      template_name_snapshot,template_type_snapshot,template_version_snapshot,status,created_at,run_kind)
      VALUES('replacement',?,'reference-process-family','reference-process-template',2,'replacement-group','Replacement','process',3,'active','2026-08-02T00:00:00.000Z','process')`).bind(sampleId).run();
    const before = await metadata(["system_recovery_write_leases"]); const blocked = await invoke("POST", await revision(), path + "/restore");
    expect(blocked.status).toBe(409); expect(await blocked.json()).toEqual({ error: "Finish or move the current active process run to trash before restoring this run." });
    expect(await metadata(["system_recovery_write_leases"])).toEqual(before);
    await database.prepare("UPDATE runs SET status='complete' WHERE id='replacement'").run();
    const newer = await metadata(["system_recovery_write_leases"]); const older = await invoke("POST", await revision(), path + "/restore");
    expect(older.status).toBe(409); expect(await older.json()).toEqual({ error: "An active process run can only be restored when it is the latest visible process run." });
    expect(await metadata(["system_recovery_write_leases"])).toEqual(newer);
    await database.prepare(`CREATE TRIGGER qualification_run_trash_audit_failure BEFORE INSERT ON events
      WHEN json_extract(NEW.metadata_json,'$.action')='run_deleted'
      BEGIN SELECT RAISE(ABORT,'Qualification Run audit failure'); END`).run();
    const rollback = await metadata(["system_recovery_write_leases"]);
    const failed = await invoke("DELETE", await revision(), path.replace(runId, "replacement"));
    expect(failed.status).toBe(500); expect(await failed.json()).toEqual({ error: "Unexpected server error" });
    expect(await metadata(["system_recovery_write_leases"])).toEqual(rollback); expect(await auditCount()).toBe(1);
    expect(await physicalScope()).toBe(4);
  });

  it("retains actual auth/Origin/maintenance/method ownership ahead of the moved handlers", async () => {
    const before = await metadata(), input = await revision();
    const deniedOrigin = await invoke("DELETE", input, path, { origin: "https://hostile.test" });
    expect(deniedOrigin.status).toBe(403); expect(await deniedOrigin.json()).toEqual({ error: "Cross-origin writes are not allowed" });
    for (const method of ["GET", "PATCH", "PUT"]) expect((await runtime.dispatchFetch(path, { method })).status).toBe(404);
    expect((await runtime.dispatchFetch(path + "/restore", { method: "DELETE" })).status).toBe(404);
    const unauthenticated = actualWorker("invalid");
    try {
      const response = await unauthenticated.dispatchFetch(path, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
    } finally { await unauthenticated.dispose(); }
    expect(await metadata()).toEqual(before);
    for (const state of ["draining", "fenced"]) {
      await database.prepare("UPDATE system_recovery_maintenance SET state=? WHERE singleton=1").bind(state).run(); const held = await metadata();
      expect((await invoke("DELETE", input)).status).toBe(503); expect((await invoke("POST", input, path + "/restore")).status).toBe(503);
      expect(await metadata()).toEqual(held);
    }
    expect(await physicalScope()).toBe(0);
  });
});

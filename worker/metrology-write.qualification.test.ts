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
const path = `https://app.test/api/samples/${sampleId}/runs/${runId}/metrology`;
const standalone = `https://app.test/api/samples/${sampleId}/metrology-runs`;
const templateId = "reference-metrology-template", input = () => ({ templateVersionId: templateId });
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
  return (await database.prepare("SELECT COUNT(*) n FROM events WHERE json_extract(metadata_json,'$.action') IN ('metrology_added','metrology_run_started')").first())?.n;
}


describe("Metrology metadata through the actual current Worker: four finite scopes", () => {
  it("inserts fractional inline and standalone metrology using genuine snapshot identity, atomic links and actor audits", async () => {
    await database.prepare(`INSERT INTO run_steps(id,run_id,previous_step_id,position,origin,definition_hash,title,status,entry_kind,created_at,updated_at)
      VALUES('following',?,'reference-step-a',1,'ad_hoc','reference-step-definition','Following','pending','fabrication','2026-08-01T02:00:00.000Z','2026-08-01T02:00:00.000Z')`).bind(runId).run();
    const retainedTables = ["run_step_assets", "assets", "metrology_template_references", "run_step_comments", "comment_submissions", "comment_submission_items"];
    const retained = await database.batch(retainedTables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY 1`)));
    const added = await invoke("POST", { ...input(), afterStepId: "reference-step-a" }); expect(added.status).toBe(201);
    const { id: addedId } = await added.json() as { id: string };
    const step = await database.prepare("SELECT position,previous_step_id,entry_kind,origin,template_step_id,logical_step_key,definition_hash,status,actualized_at,updated_by FROM run_steps WHERE id=?").bind(addedId).first();
    expect(step).toMatchObject({ position: 0.5, previous_step_id: "reference-step-a", entry_kind: "metrology", origin: "ad_hoc", template_step_id: "reference-metrology-template-step", logical_step_key: "reference:sem", definition_hash: "reference-metrology-definition", status: "pending", updated_by: "local-development" });
    expect(typeof step?.actualized_at).toBe("string");
    expect(await database.prepare("SELECT previous_step_id FROM run_steps WHERE id='following'").first()).toEqual({ previous_step_id: addedId });
    const started = await invoke("POST", input(), standalone); expect(started.status).toBe(201);
    const { id: metroId } = await started.json() as { id: string };
    expect(await database.prepare("SELECT sample_id,run_kind,sequence_no,status,template_version_id,template_name_snapshot,template_type_snapshot,template_version_snapshot,created_by FROM runs WHERE id=?").bind(metroId).first())
      .toEqual({ sample_id: sampleId, run_kind: "metrology", sequence_no: 2, status: "active", template_version_id: templateId, template_name_snapshot: "Reference SEM", template_type_snapshot: "module", template_version_snapshot: 2, created_by: "local-development" });
    expect(await database.prepare("SELECT entry_kind,origin,position,actualized_at,definition_hash FROM run_steps WHERE run_id=?").bind(metroId).first())
      .toEqual({ entry_kind: "metrology", origin: "template", position: 1000, actualized_at: null, definition_hash: "reference-metrology-definition" });
    expect(await auditCount()).toBe(2);
    const audits = (await database.prepare("SELECT metadata_json,actor_email FROM events WHERE json_extract(metadata_json,'$.action') IN ('metrology_added','metrology_run_started') ORDER BY created_at,id").all()).results;
    expect(audits.every(row => row.actor_email === "local-development")).toBe(true);
    expect(JSON.parse(String(audits[0].metadata_json))).toEqual({ runId, stepId: addedId, action: "metrology_added", templateVersionId: templateId, afterStepId: "reference-step-a" });
    const saved = await database.batch(retainedTables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY 1`)));
    expect(saved.map(row => row.results)).toEqual(retained.map(row => row.results)); expect(await physicalScope()).toBe(2);
  });

  it("keeps malformed inputs zero-SQL and validates template kind/single-step, association and insertion before publication", async () => {
    const before = await metadata(["system_recovery_write_leases"]);
    for (const value of [null, {}, [], { templateVersionId: 12 }]) {
      expect((await invoke("POST", value)).status).toBe(400); expect((await invoke("POST", value, standalone)).status).toBe(400);
    }
    expect(await physicalScope()).toBe(0);
    for (const value of [{ templateVersionId: "reference-process-template" }, { templateVersionId: "missing" }]) {
      for (const url of [path, standalone]) {
        const response = await invoke("POST", value, url); expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Metrology template not found" });
      }
    }
    const absent = await invoke("POST", { ...input(), afterStepId: "missing" }); expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: "Insertion point not found" });
    expect((await invoke("POST", input(), path.replace(sampleId, "reference-sample-b"))).status).toBe(404);
    expect(await metadata(["system_recovery_write_leases"])).toEqual(before); expect(await physicalScope()).toBe(6);
    await database.prepare(`INSERT INTO template_steps(id,template_version_id,logical_step_key,position,definition_hash)
      VALUES('extra-metrology','reference-metrology-template','extra',1,'reference-metrology-definition')`).run();
    const ambiguous = await metadata(["system_recovery_write_leases"]);
    expect((await invoke("POST", input())).status).toBe(404); expect((await invoke("POST", input(), standalone)).status).toBe(404);
    expect(await metadata(["system_recovery_write_leases"])).toEqual(ambiguous); expect(await physicalScope()).toBe(8);
    expect(await auditCount()).toBe(0);
  });

  it("rolls both genuine D1 transaction forms back when their own audit trigger fails", async () => {
    await database.prepare(`CREATE TRIGGER qualification_metrology_audit_failure BEFORE INSERT ON events
      WHEN json_extract(NEW.metadata_json,'$.action') IN ('metrology_added','metrology_run_started')
      BEGIN SELECT RAISE(ABORT,'Qualification Metrology audit failure'); END`).run();
    const before = await metadata(["system_recovery_write_leases"]);
    for (const url of [path, standalone]) {
      const response = await invoke("POST", input(), url); expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Unexpected server error" });
      expect(await metadata(["system_recovery_write_leases"])).toEqual(before);
    }
    expect(await auditCount()).toBe(0); expect(await physicalScope()).toBe(2);
  });

  it("retains real auth/Origin/maintenance and exact method owners with no provider opening", async () => {
    const before = await metadata();
    for (const url of [path, standalone]) {
      const response = await invoke("POST", input(), url, { origin: "https://hostile.test" }); expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Cross-origin writes are not allowed" });
      for (const method of ["GET", "PATCH", "DELETE"]) expect((await runtime.dispatchFetch(url, { method })).status).toBe(404);
    }
    const unauthenticated = actualWorker("invalid");
    try {
      const response = await unauthenticated.dispatchFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input()) });
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
    } finally { await unauthenticated.dispose(); }
    expect(await metadata()).toEqual(before);
    for (const state of ["draining", "fenced"]) {
      await database.prepare("UPDATE system_recovery_maintenance SET state=? WHERE singleton=1").bind(state).run(); const held = await metadata();
      expect((await invoke("POST", input())).status).toBe(503); expect((await invoke("POST", input(), standalone)).status).toBe(503);
      expect(await metadata()).toEqual(held);
    }
    expect(await physicalScope()).toBe(0);
  });
});

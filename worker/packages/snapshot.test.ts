import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { d1FileJobDatabase } from "../files/jobs/d1-repository";
import { buildPackageSnapshotStatements, previewPackageSnapshot, readPackageSnapshot } from "./snapshot";
import { sha256Hex, stableJson, hashRecipeManifest, hashStepDefinition } from "../../shared/domain/content-addressing";
import { validateResearchPackage, researchRecordsDocument } from "../../shared/contracts/research-package";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { acceptAndUploadR2Asset } from "../uploads/r2-upload-acceptance";

const generation = "0020_fp4_research_packages.sql", time = "2026-10-06T12:00:00.000Z";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const sql of databases.splice(0)) sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function adapter(sql: DatabaseSync) { return d1FileJobDatabase(new SqliteD1Database(sql) as unknown as D1Database); }
function source(sql: DatabaseSync) { return String(sql.prepare("SELECT installation_id FROM research_package_source_identity").get()!.installation_id); }
function job(sql: DatabaseSync, id: string, roots: Array<{ kind: "sample" | "project"; id: string }>, kind = "data_package") {
  sql.prepare(`INSERT INTO research_package_jobs(id,request_id,actor,kind,input_json,package_id,source_installation_id,accepted_at,
    target_policy_json,state,phase,updated_at) VALUES(?,?,?,?,?,?,?,?,'{}','queued','snapshot',?)`)
    .run(id, id, "actor@example.test", kind, JSON.stringify({ roots, kind }), `package-${id}`, source(sql), time, time);
  return { jobId: id, roots, actor: "actor@example.test", packageId: `package-${id}`, sourceInstallationId: source(sql), createdAt: time, kind: kind as "data_package" | "report" };
}
function addSample(sql: DatabaseSync, id: string) { sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, id.toUpperCase(), id, time, time); }
async function definitions(sql: DatabaseSync) {
  const definition = await hashStepDefinition({ name: "Measured step" });
  sql.prepare("INSERT INTO step_definitions VALUES(?,?,?,?,?,?,?,?)").run(definition.hash, "step-definition/v1", "Measured step", null, null, null, stableJson(definition.canonical), time);
  sql.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('family','Fixture family','module',?)").run(time);
  const manifest = await hashRecipeManifest([{ logicalStepKey: "step:0", definitionHash: definition.hash, expectedStateHash: null }]);
  sql.prepare("INSERT INTO template_versions(id,recipe_family_id,name,template_type,template_kind,version,manifest_hash,content_json,created_at) VALUES('template','family','Fixture template','module','metrology',1,?,'{}',?)").run(manifest, time);
  sql.prepare("INSERT INTO template_steps(id,template_version_id,logical_step_key,position,definition_hash) VALUES('template-step','template','step:0',0,?)").run(definition.hash);
  return definition;
}
function addRun(sql: DatabaseSync, sample: string, run: string, step: string, definition: string) {
  sql.prepare(`INSERT INTO runs(id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,template_name_snapshot,template_type_snapshot,
    template_version_snapshot,created_at) VALUES(?,?,'family','template',1,?,'Fixture template','module',1,?)`).run(run, sample, `group-${run}`, time);
  sql.prepare("INSERT INTO run_steps(id,run_id,position,definition_hash,created_at,updated_at) VALUES(?,?,0,?,?,?)").run(step, run, definition, time, time);
}
function project(sql: DatabaseSync, refs: Array<[string, string]>, projectId = "project") {
  sql.prepare(`INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES(?,'Selected project','create','actor@example.test','actor@example.test',?,?)`).run(projectId, time, time);
  refs.forEach(([kind, id], index) => {
    const registry = `${projectId}-reference-${index}`;
    sql.prepare("INSERT INTO reference_targets(id,target_type,target_id,first_registered_at,last_validated_at) VALUES(?,?,?,?,?)").run(registry, kind, id, time, time);
    sql.prepare(`INSERT INTO project_items(id,project_id,item_type,reference_target_id,created_sequence,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,'reference',?,?,'create','actor@example.test','actor@example.test',?,?)`).run(`${projectId}-item-${index}`, projectId, registry, index + 1, time, time);
    sql.prepare(`INSERT INTO project_map_placements(id,project_item_id,x,y,width,height,z_index,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,0,200,120,?,'create','actor@example.test','actor@example.test',?,?)`)
      .run(`${projectId}-placement-${index}`, `${projectId}-item-${index}`, index * 220, index, time, time);
  });
}

describe("authorized selective research snapshot", () => {
  it("captures only selected Sample history and never unrelated consumers of shared definitions", async () => {
    const sql = referenceTestDatabase({ throughMigration: generation }); databases.push(sql);
    addSample(sql, "one"); addSample(sql, "two"); const definition = await definitions(sql);
    addRun(sql, "one", "run-one", "step-one", definition.hash); addRun(sql, "two", "run-two", "step-two", definition.hash);
    const db = adapter(sql), input = job(sql, "selection", [{ kind: "sample", id: "one" }]);
    await db.batch(buildPackageSnapshotStatements(db, input));
    const snapshot = await readPackageSnapshot(db, input.jobId);
    expect(snapshot.records.filter(record => record.kind === "sample").map(record => record.sourceId)).toEqual(["one"]);
    expect(snapshot.records.filter(record => record.kind === "run").map(record => record.sourceId)).toEqual(["run-one"]);
    expect(snapshot.records.some(record => record.kind === "stepDefinition" && record.sourceId === definition.hash)).toBe(true);
    const { records, ...manifest } = snapshot;
    await expect(validateResearchPackage(manifest, researchRecordsDocument(records))).resolves.toMatchObject({ roots: input.roots });
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }, 30_000);

  it("preserves one Common Comment but only selected incidental targets", async () => {
    const sql = referenceTestDatabase({ throughMigration: generation }); databases.push(sql);
    addSample(sql, "one"); addSample(sql, "two"); const definition = await definitions(sql);
    addRun(sql, "one", "run-one", "step-one", definition.hash); addRun(sql, "two", "run-two", "step-two", definition.hash);
    sql.prepare("INSERT INTO comment_submissions(id,context_kind,scope,body,status,created_at,updated_at) VALUES('common','run_steps','common','Canonical body','ready',?,?)").run(time, time);
    for (const id of ["one", "two"]) sql.prepare("INSERT INTO comment_submission_targets VALUES('common',?,?,?,?)").run(id, `run-${id}`, `step-${id}`, time);
    const db = adapter(sql), input = job(sql, "common", [{ kind: "sample", id: "one" }]);
    await db.batch(buildPackageSnapshotStatements(db, input)); const snapshot = await readPackageSnapshot(db, input.jobId);
    expect(snapshot.records.filter(record => record.kind === "comment")).toHaveLength(1);
    expect(snapshot.records.filter(record => record.kind === "commentTarget").map(record => record.data.run_step_id)).toEqual(["step-one"]);
    expect(snapshot.records.find(record => record.kind === "comment")!.data.excluded_targets).toEqual([
      { sample: { kind: "sample", sourceId: "two" }, run: { kind: "run", sourceId: "run-two" }, step: { kind: "runStep", sourceId: "step-two" }, resolution: "excluded" },
    ]);
    expect(snapshot.records.some(record => record.kind === "sample" && record.sourceId === "two")).toBe(false);
    expect(snapshot.completeness).toBe("complete");
    const { records, ...manifest } = snapshot;
    await expect(validateResearchPackage(manifest, researchRecordsDocument(records))).resolves.toMatchObject({ completeness: "complete" });
  }, 30_000);

  it.each([
    ["sample", "sample-native"], ["run", "run-one"], ["run_step", "step-one"], ["comment", "comment"], ["comment_occurrence", "occurrence"],
    ["comment_attachment", "link"], ["execution_image", "image"], ["metrology_reference", "reference"], ["recipe_revision", "template"],
  ])("captures a standalone Project %s reference with its owning source context", async (kind, targetId) => {
    const f = await nativeAcceptanceFixture(true, { throughMigration: generation }); databases.push(f.sql);
    const receipt = await acceptAndUploadR2Asset(f.env, { requestId: crypto.randomUUID(), actorEmail: f.actor, ingress: "ordinary_image", originalName: "source.png", mimeType: "image/png",
      bytes: new TextEncoder().encode("source research bytes").buffer });
    if (receipt.state.status !== "ready" || receipt.state.result.key !== null) throw new Error("Expected native File alias");
    const uploaded = receipt.state.result;
    const sourceReceipt = await acceptAndUploadR2Asset(f.env, { requestId: crypto.randomUUID(), actorEmail: f.actor, ingress: "project_attachment", originalName: "reference.png", mimeType: "image/png",
      bytes: new TextEncoder().encode("source reference bytes").buffer });
    if (sourceReceipt.state.status !== "ready" || sourceReceipt.state.result.key !== null) throw new Error("Expected original File alias");
    const original = sourceReceipt.state.result;
    const definition = await definitions(f.sql);
    addRun(f.sql, "sample-native", "run-one", "step-one", definition.hash);
    addSample(f.sql, "two"); addRun(f.sql, "two", "run-two", "step-two", definition.hash);
    addSample(f.sql, "unrelated"); addRun(f.sql, "unrelated", "run-unrelated", "step-unrelated", definition.hash);
    f.sql.prepare("INSERT INTO comment_submissions(id,context_kind,scope,body,status,created_at,updated_at) VALUES('comment','run_steps','common','One canonical body','ready',?,?)").run(time, time);
    for (const [sample, run, step] of [["sample-native", "run-one", "step-one"], ["two", "run-two", "step-two"]])
      f.sql.prepare("INSERT INTO comment_submission_targets VALUES('comment',?,?,?,?)").run(sample, run, step, time);
    f.sql.prepare("INSERT INTO comment_submission_items(id,submission_id,kind,status,position,title,external_url,created_at,updated_at) VALUES('link','comment','link','ready',0,'Paper','https://example.test/paper',?,?)").run(time, time);
    f.sql.prepare("INSERT INTO run_step_comments(id,run_step_id,scope,submission_id,created_at) VALUES('occurrence','step-one','common','comment',?)").run(time);
    f.sql.prepare("INSERT INTO run_step_assets(id,run_step_id,asset_id,role,created_at,file_id) VALUES('image','step-one',?,'execution',?,?)").run(uploaded.id, time, uploaded.fileId);
    f.sql.prepare("INSERT INTO metrology_template_references(id,template_version_id,asset_id,display_name,created_at,file_id) VALUES('reference','template',?,'Reference image',?,?)").run(original.id, time, original.fileId);
    project(f.sql, [[kind, targetId]]);
    const db = adapter(f.sql), input = job(f.sql, "references", [{ kind: "project", id: "project" }]);
    await db.batch(buildPackageSnapshotStatements(db, input)); const snapshot = await readPackageSnapshot(db, input.jobId);
    expect(snapshot.records.filter(record => record.kind === "reference")).toHaveLength(1);
    expect(snapshot.records.filter(record => record.kind === "reference").every(record => record.data.resolution === "included")).toBe(true);
    const explicitComment = kind === "comment" || kind === "comment_attachment", recipeOnly = kind === "recipe_revision" || kind === "metrology_reference";
    expect(snapshot.records.filter(record => record.kind === "commentTarget")).toHaveLength(recipeOnly ? 0 : explicitComment ? 2 : 1);
    expect(snapshot.records.some(record => record.kind === "sample" && record.sourceId === "two")).toBe(explicitComment);
    expect(snapshot.records.some(record => record.sourceId === "unrelated" || record.sourceId === "run-unrelated")).toBe(false);
    if (explicitComment) {
      const preview = await previewPackageSnapshot(db, { roots: input.roots, kind: "data_package", actor: input.actor });
      expect(preview.dependencies.filter(context => context.targetType === "sample").map(context => context.id).sort()).toEqual(["sample-native", "two"]);
      expect(preview.dependencies.filter(context => context.targetType === "run").map(context => context.id).sort()).toEqual(["run-one", "run-two"]);
      expect(preview.dependencies.filter(context => context.targetType === "runStep").map(context => context.id).sort()).toEqual(["step-one", "step-two"]);
      expect(preview.dependencies.some(context => context.id.includes("unrelated"))).toBe(false);
      expect(preview.dependencies.every(context => context.outcome === "included" && context.label !== null)).toBe(true);
    }
    expect(snapshot.files).toHaveLength(recipeOnly ? 1 : 2);
    const privateFile = f.sql.prepare("SELECT * FROM research_package_files WHERE job_id='references'").get()!;
    expect(f.sql.prepare("SELECT location_id,hold_kind,released_at FROM file_location_holds WHERE operation_id=?").get(privateFile.hold_operation_id)).toEqual({ location_id: privateFile.source_location_id, hold_kind: "export", released_at: null });
    expect(stableJson(snapshot)).not.toContain(String(privateFile.source_object_key));
    expect(stableJson(snapshot)).not.toContain(String(privateFile.source_namespace));
    const { records, ...manifest } = snapshot;
    await expect(validateResearchPackage(manifest, researchRecordsDocument(records))).resolves.toMatchObject({ schema: "research-package/1" });
  }, 30_000);

  it("rejects unresolved native attachments atomically and keeps report fallback explicit", async () => {
    const sql = referenceTestDatabase({ throughMigration: generation }); databases.push(sql); addSample(sql, "one");
    sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('old','legacy/source.png','source.png','image/png',5,'ready',?,?)").run(await sha256Hex("bytes"), time);
    sql.prepare("INSERT INTO events(id,sample_id,kind,asset_key,created_at) VALUES('event','one','image','legacy/source.png',?)").run(time);
    const db = adapter(sql), roots = [{ kind: "sample" as const, id: "one" }];
    const preview = await previewPackageSnapshot(db, { roots, kind: "data_package", actor: "actor@example.test" });
    expect(preview.capabilities.dataPackage).toEqual({ available: false, reasons: ["unresolved_file_authority", "file_authority_inactive"] }); expect(preview.capabilities.report.available).toBe(true);
    const input = job(sql, "unresolved", roots);
    await expect(db.batch(buildPackageSnapshotStatements(db, input))).rejects.toThrow();
    expect(sql.prepare("SELECT count(*) n FROM research_package_records WHERE job_id='unresolved'").get()!.n).toBe(0);
    expect(sql.prepare("SELECT count(*) n FROM research_package_files WHERE job_id='unresolved'").get()!.n).toBe(0);
    const report = job(sql, "report", roots, "report"); await db.batch(buildPackageSnapshotStatements(db, report));
    expect(await readPackageSnapshot(db, report.jobId)).toMatchObject({ schema: "research-report/1", kind: "report", completeness: "partial", files: [] });
  }, 30_000);
});

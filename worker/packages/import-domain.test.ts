import { afterAll, describe, expect, it } from "vitest";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import { researchRecordsDocument, RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES, type ResearchDomainRecord, type ResearchPackageFile, type ResearchPackageV1 } from "../../shared/contracts/research-package";
import { hashStateRepresentation, hashStepDefinition, sha256Hex, stableJson } from "../../shared/domain/content-addressing";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { JobSqlDatabase } from "../files/jobs/sql-repository";
import { ImportDomainError, ImportIdentityMap, REFERENCE_IMPORT_KINDS, rewriteImportEventRelationships } from "./import-domain-identity";
import { estimateResearchImportPlanBudget, importDomainIdentityStatements, prepareImportDomainPlan, prepareImportDomainPublication,
  readImportDestinationColumns, readImportDestinationSnapshot, type ImportDomainFileTarget } from "./import-domain";
import { buildImportDomainFixture } from "./import-domain-test-support";

const at = "2026-10-06T09:00:00.000Z", actor = "foreign-author@example.test";
const sql = referenceTestDatabase({ throughMigration: "0019_fp3_file_jobs.sql" });
sql.exec("PRAGMA foreign_keys=ON");
const host = new SqliteD1Database(sql);
const db: JobSqlDatabase = { prepare: query => host.prepare(query), batch: statements => host.batch(statements as never), primary() { return this; } };
afterAll(() => sql.close());

function record(kind: ResearchRecordKind, sourceId: string, override: Record<string, unknown> = {}): ResearchDomainRecord {
  const definition = RESEARCH_PACKAGE_CATALOG[kind];
  const data = Object.fromEntries(Object.entries(definition.fields).map(([field, rule]) => [field,
    rule.nullable ? null : rule.type === "integer" ? 1 : rule.type === "number" ? 0 : rule.type === "json" ? {}
      : field.endsWith("_at") ? at : field.endsWith("_by") || field === "actor_email" ? actor : "literal"]));
  Object.assign(data, override);
  const value = definition.revision.scheme === "integer" ? data[definition.revision.field!] as number
    : definition.revision.scheme === "contentHash" ? sourceId : definition.revision.scheme === "timestamp" ? String(data[definition.revision.field!]) : at;
  return { kind, sourceId, sourceRevision: { scheme: definition.revision.scheme, value }, data };
}
const sample = (id: string, override: Record<string, unknown> = {}) => record("sample", id, { code: id, title: `Text ${id}`, status: "stored", pinned: 0, ...override });
const project = (id: string, override: Record<string, unknown> = {}) => record("project", id, { title: id, next_created_sequence: 3, last_mutation_id: "foreign-operation", ...override });
async function pkg(records: ResearchDomainRecord[], files: ResearchPackageFile[] = []): Promise<ResearchPackageV1> {
  const root = records.find(row => row.kind === "project" || row.kind === "sample")!;
  return { schema: "research-package/1", kind: "data_package", packageId: "foreign-package", sourceInstallationId: "foreign-installation", createdAt: at,
    roots: [{ kind: root.kind as "sample" | "project", id: root.sourceId }], files, dependencies: [], completeness: "complete",
    counts: { records: records.length, files: files.length, bytes: files.reduce((sum, file) => sum + file.byteSize, 0) },
    recordsSha256: await sha256Hex(stableJson(researchRecordsDocument(records))), report: { htmlPath: "report/index.html", markdownPath: "report/report.md" }, records };
}
function randomIds(prefix = "fresh") { let index = 0; return () => `${prefix}-${++index}`; }
async function plan(value: ResearchPackageV1, files: ImportDomainFileTarget[] = [], prefix = "fresh") {
  return prepareImportDomainPlan(value, { files, destination: await readImportDestinationSnapshot(db, value), randomId: randomIds(prefix), acceptedAt: at });
}

describe("fresh typed research import identities", () => {
  it("maps cyclic Sample parent pointers before publication and leaves ordinary prose literal", async () => {
    const value = await pkg([sample("foreign-a", { parent_id: "foreign-b", title: "foreign-b remains user text" }), sample("foreign-b", { parent_id: "foreign-a" })]);
    const result = await plan(value, [], "sample-cycle");
    expect(result.rows.find(row => row.sourceId === "foreign-a")!.data).toMatchObject({ id: "sample-cycle-1", parent_id: "sample-cycle-2", title: "foreign-b remains user text" });
    await db.batch(prepareImportDomainPublication(db, result));
    expect(sql.prepare("SELECT id,parent_id FROM samples WHERE id LIKE 'sample-cycle-%' ORDER BY id").all()).toEqual([
      { id: "sample-cycle-1", parent_id: "sample-cycle-2" }, { id: "sample-cycle-2", parent_id: "sample-cycle-1" },
    ]);
  });

  it("uses isolated unresolved targets for all nine registry kinds even when their foreign IDs exist locally", async () => {
    const references = Object.entries(REFERENCE_IMPORT_KINDS).map(([type, kind]) => record("reference", `reference-${type}`, {
      registry_version: 1, target: { kind, sourceId: "existing-foreign-id" }, resolution: "unresolved", contexts: [{ segments: [{
        target: { kind: "sample", sourceId: "existing-foreign-id" }, label: "existing-foreign-id literal label", deletedAt: null, archivedAt: null, resolution: "excluded",
      }] }], first_registered_at: at, last_validated_at: at,
    }));
    const value = await pkg([project("foreign-project"), ...references]);
    const result = await plan(value, [], "nine-refs");
    const rows = result.rows.filter(row => row.kind === "reference");
    expect(rows).toHaveLength(9); expect(new Set(rows.map(row => row.data.target_type))).toEqual(new Set(Object.keys(REFERENCE_IMPORT_KINDS)));
    expect(new Set(rows.map(row => row.data.target_id)).size).toBe(9);
    expect(rows.every(row => row.data.target_id !== "existing-foreign-id")).toBe(true);
    expect(JSON.parse(String(rows[0].data.last_known_contexts_json))[0].segments[0]).toMatchObject({ label: "existing-foreign-id literal label", type: "sample" });
    expect(() => new ImportIdentityMap(() => "existing-foreign-id", new Set(["existing-foreign-id"])).register("sample", "source")).toThrow("destination_identity_collision");
  });

  it("rewrites only declared scalar and contiguous indexed event relationships", () => {
    const identities = new ImportIdentityMap(randomIds("event-id"), new Set());
    identities.register("runStep", "old-step-one"); identities.register("runStep", "old-step-two");
    const metadata = { message: "old-step-one", rawCells: { stepId: "old-step-one" }, other: 42 };
    const value = rewriteImportEventRelationships(metadata, [
      { field: "stepIds[0]", target: { kind: "runStep", sourceId: "old-step-one" }, resolution: "included" },
      { field: "stepIds[1]", target: { kind: "runStep", sourceId: "old-step-two" }, resolution: "included" },
      { field: "operationId", target: { kind: "operation", sourceId: "foreign-op" }, resolution: "unresolved" },
    ], identities);
    expect(value).toEqual({ ...metadata, stepIds: ["event-id-1", "event-id-2"], operationId: "event-id-3" });
    expect(() => rewriteImportEventRelationships(metadata, [{ field: "stepIds[1]", target: { kind: "runStep", sourceId: "old-step-one" }, resolution: "included" }], identities)).toThrow("invalid_event_relationship");
    expect(() => rewriteImportEventRelationships(metadata, [{ field: "rawCells.stepId", target: { kind: "runStep", sourceId: "old-step-one" }, resolution: "included" }], identities)).toThrow("invalid_event_relationship");
  });

  it("preserves cyclic Project edges, typed ownership and historical tombstones without changing revisions", async () => {
    const records = [project("project-history"), ...["one", "two"].flatMap((id, index) => [
      record("projectContent", `content-${id}`, { project_id: "project-history", content_type: "markdown", markdown_source: `User text item-${id}`,
        format_version: 1, revision: 4, last_mutation_id: `operation-${id}`, deleted_at: index ? at : null, deleted_by: index ? actor : null, deletion_operation_id: index ? "delete-history" : null }),
      record("projectItem", `item-${id}`, { project_id: "project-history", item_type: "content", project_content_id: `content-${id}`,
        created_sequence: index + 1, revision: 7, last_mutation_id: `operation-${id}`, deleted_at: index ? at : null, deleted_by: index ? actor : null, deletion_operation_id: index ? "delete-history" : null }),
    ]), record("projectPlacement", "placement-one", { project_item_id: "item-one", x: 10, y: 20, width: 180, height: 100, z_index: 1,
      revision: 3, last_mutation_id: "placement-operation" }), ...[["one", "two"], ["two", "one"]].map(([from, to]) => record("projectEdge", `edge-${from}`, {
      project_id: "project-history", source_item_id: `item-${from}`, target_item_id: `item-${to}`, source_handle: "right", target_handle: "left", marker_start: "none", marker_end: "arrow", revision: 3, last_mutation_id: "edge-op",
    }))];
    const result = await plan(await pkg(records), [], "project-copy");
    const edges = result.rows.filter(row => row.kind === "projectEdge");
    expect(edges[0].data.source_item_id).toBe(edges[1].data.target_item_id);
    expect(edges[0].data.target_item_id).toBe(edges[1].data.source_item_id);
    expect(result.rows.find(row => row.sourceId === "content-two")!.data).toMatchObject({ revision: 4, deleted_at: at, deleted_by: actor, markdown_source: "User text item-two" });
    expect(result.rows.find(row => row.sourceId === "item-two")!.data.deletion_operation_id).toBe(result.rows.find(row => row.sourceId === "content-two")!.data.deletion_operation_id);
    const self = structuredClone(records); self[self.length - 1].data.target_item_id = self[self.length - 1].data.source_item_id;
    await expect(plan(await pkg(self))).rejects.toThrow();
  });

  it("refuses a missing active Project placement and an invalid sequence watermark before allocating copy identities", async () => {
    const records = [project("project-final-state"),
      record("projectContent", "content-final-state", { project_id: "project-final-state", content_type: "markdown", markdown_source: "Source content", format_version: 1 }),
      record("projectItem", "item-final-state", { project_id: "project-final-state", item_type: "content", project_content_id: "content-final-state", created_sequence: 1 }),
    ];
    const invalid = [
      { records, reason: "project_active_placement_missing" },
      { records: [project("project-final-state", { next_created_sequence: 1 }), ...records.slice(1),
        record("projectPlacement", "placement-final-state", { project_item_id: "item-final-state", x: 10, y: 20, width: 180, height: 100, z_index: 1 })],
      reason: "project_sequence_watermark" },
    ];
    for (const example of invalid) {
      const value = await pkg(example.records), original = stableJson(value), destination = await readImportDestinationSnapshot(db, value);
      let allocated = 0;
      await expect(prepareImportDomainPlan(value, { destination, files: [], acceptedAt: at, randomId: () => `forbidden-project-${++allocated}` }))
        .rejects.toThrow(example.reason);
      expect(allocated).toBe(0);
      expect(await estimateResearchImportPlanBudget(value, { columns: destination.columns, targets: [] }))
        .toMatchObject({ supported: false, reason: example.reason });
      expect(stableJson(value)).toBe(original);
    }
    expect(sql.prepare("SELECT count(*) AS n FROM projects WHERE id LIKE 'forbidden-project-%'").get()?.n).toBe(0);
    expect(sql.prepare("SELECT count(*) AS n FROM project_items WHERE id LIKE 'forbidden-project-%'").get()?.n).toBe(0);
  });

  it("freezes deterministic conflict previews and creates a distinct second copy", async () => {
    sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('existing-name','NAME','Existing',?,?)").run(at, at);
    const value = await pkg([sample("named-source", { code: "NAME" })]);
    const first = await plan(value, [], "name-first");
    expect(first.namingPreview).toEqual({ suffix: "", conflicts: [{ kind: "sample", sourceId: "named-source", sourceName: "NAME", destinationName: "NAME (import 1)" }] });
    await db.batch(prepareImportDomainPublication(db, first));
    const second = await plan(value, [], "name-second");
    expect(second.naming[0].destination).toBe("NAME (import 2)"); expect(second.roots[0].id).not.toBe(first.roots[0].id);
    const suffix = "（副本）";
    const explicit = await prepareImportDomainPlan(value, { files: [], acceptedAt: at, randomId: randomIds("explicit"), namingSuffix: suffix,
      destination: await readImportDestinationSnapshot(db, value, { namingSuffix: suffix }) });
    expect(explicit.rows[0].data.code).toBe(`NAME${suffix}`);
  });

  it("refuses Project conflict and explicit suffix names beyond the existing 200 Unicode code point contract", async () => {
    const title = "🤖".repeat(200);
    sql.prepare(`INSERT INTO projects(id,title,revision,next_created_sequence,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES('existing-long-project',?,1,1,'existing-long-project-operation',?,?,?,?)`).run(title, actor, actor, at, at);
    const value = await pkg([project("long-project-source", { title })]), destination = await readImportDestinationSnapshot(db, value);
    let allocated = 0;
    await expect(prepareImportDomainPlan(value, { destination, files: [], acceptedAt: at, randomId: () => `forbidden-title-${++allocated}` }))
      .rejects.toThrow("destination_name_limit");
    expect(allocated).toBe(0);
    const suffixed = await pkg([project("suffixed-project-source", { title: "🤖".repeat(199) })]), namingSuffix = "副本";
    await expect(readImportDestinationSnapshot(db, suffixed, { namingSuffix })).rejects.toThrow("destination_name_limit");
    await expect(prepareImportDomainPlan(suffixed, { destination, files: [], acceptedAt: at, namingSuffix, randomId: () => `forbidden-title-${++allocated}` }))
      .rejects.toThrow("destination_name_limit");
    expect(allocated).toBe(0);
    expect(sql.prepare("SELECT title FROM projects WHERE id='existing-long-project'").get()?.title).toBe(title);
    expect(sql.prepare("SELECT count(*) AS n FROM projects WHERE id LIKE 'forbidden-title-%'").get()?.n).toBe(0);
  });
});

describe("immutable definition and bounded atomic publication", () => {
  it("preflights the shared nonempty whole-flow fixture with history, all nine references and every File slot", async () => {
    const fixture = await buildImportDomainFixture();
    const targets: ImportDomainFileTarget[] = fixture.package.files.map((file, index) => ({ packageFileId: file.packageFileId, destinationFileId: `full-file-${index}`, assetId: `full-alias-${index}`,
      profileId: "full-target", profileRevision: 1, namespaceIdentity: "full-namespace", purpose: file.purpose, sha256: file.sha256, byteSize: file.byteSize, scope: "system" }));
    const result = await plan(fixture.package, targets, "whole-graph");
    expect(result.rows.filter(row => row.kind === "reference")).toHaveLength(9);
    expect(result.rows.filter(row => row.kind === "commentTarget")).toHaveLength(2);
    expect(result.rows.filter(row => row.kind === "projectPlacement")).toHaveLength(11);
    expect(result.rows.filter(row => row.kind === "projectEdge")).toHaveLength(2);
    expect(result.rows.find(row => row.sourceId === "foreign-content-attachment")!.data).toMatchObject({ deleted_at: at, revision: 4 });
    expect(result.rows.find(row => row.kind === "sourceImport")!.data).toMatchObject({ status: "ready", client_request_id: null, operation_id: null, file_targets_protocol: null });
    expect(result.rows.some(row => row.kind === "fileDerivation" || row.kind === "attachmentDerivative")).toBe(false);
    expect(result.files.find(file => file.packageFileId === "logical-comment-original")!.originalName).toBe("original.tif");
    expect(result.files.find(file => file.packageFileId === "logical-state-two")).toMatchObject({ originalName: "original-second-state.png", mimeType: "image/x-png", aliasCreatedAt: at });
    expect(result.publicationStatements).toBeLessThanOrEqual(112);
    expect(fixture.package.files.every(file => fixture.payloads.get(file.packageFileId)?.byteLength === file.byteSize)).toBe(true);
    const estimate = await estimateResearchImportPlanBudget(fixture.package, {
      columns: await readImportDestinationColumns(db, fixture.package), targets,
    });
    expect(estimate).toMatchObject({ supported: true, reason: null, maximumBytes: RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES });
    expect(estimate.estimatedBytes).toBeGreaterThan(new TextEncoder().encode(stableJson(result)).byteLength);
  });

  it("preserves authenticated content IDs and reuses a definition without touching its original timestamp", async () => {
    const definition = await hashStepDefinition({ name: "Step", toolName: "Tool", parametersText: "A", commentsText: "B" });
    sql.prepare("INSERT INTO step_definitions VALUES(?,?,?,?,?,?,?,?)").run(definition.hash, "step-definition/v1", "Step", "Tool", "A", "B", stableJson(definition.canonical), "2020-01-01T00:00:00Z");
    const value = await pkg([sample("hash-owner"), record("stepDefinition", definition.hash, { hash_scheme: "step-definition/v1", name: "  Step  ", tool_name: "Tool", parameters_text: "A", comments_text: "B", canonical_json: definition.canonical })]);
    const result = await plan(value, [], "hash-copy");
    expect(result.identities.find(row => row.kind === "stepDefinition")!.destinationId).toBe(definition.hash);
    expect(result.rows.some(row => row.kind === "stepDefinition")).toBe(false);
    await db.batch(prepareImportDomainPublication(db, result));
    expect(sql.prepare("SELECT created_at FROM step_definitions WHERE hash=?").get(definition.hash)?.created_at).toBe("2020-01-01T00:00:00Z");
  });

  it("preserves two distinct ordered aliases with identical SHA and refuses incompatible canonical State media reuse", async () => {
    const sha256 = "a".repeat(64), definition = await hashStateRepresentation([sha256, sha256]);
    const files: ResearchPackageFile[] = ["logical-one", "logical-two"].map(packageFileId => ({ packageFileId, path: `files/${packageFileId}`, sha256, byteSize: 4, purpose: "embedded_content", mediaType: "image/png" }));
    const targets: ImportDomainFileTarget[] = files.map((file, index) => ({ ...file, destinationFileId: `candidate-file-${index}`, assetId: `candidate-alias-${index}`,
      profileId: "frozen-profile", profileRevision: 1, namespaceIdentity: "exact-namespace", scope: "system" }));
    const records = [sample("state-owner"), record("state", definition.hash, { hash_scheme: "state-diagram/v1", representation_type: "diagram", content_json: definition.canonical }),
      ...files.flatMap((file, index) => [record("fileAlias", `asset:foreign-${index}`, { alias_kind: "asset", packageFileId: file.packageFileId, sha256, byte_size: 4, original_name: "image.png", mime_type: "image/png" }),
        record("stateAsset", JSON.stringify([definition.hash, `asset:foreign-${index}`]), { state_hash: definition.hash, asset_id: `asset:foreign-${index}`, position: index, packageFileId: file.packageFileId })])];
    const value = await pkg(records, files), destination = await readImportDestinationSnapshot(db, value);
    const result = await prepareImportDomainPlan(value, { destination, files: targets, acceptedAt: at, randomId: randomIds("state-copy") });
    expect(result.rows.filter(row => row.kind === "stateAsset").map(row => [row.data.asset_id, row.data.position])).toEqual([["candidate-alias-0", 0], ["candidate-alias-1", 1]]);
    destination.definitions.push({ kind: "state", hash: definition.hash, data: { hash: definition.hash, ...records[1].data, content_json: stableJson(definition.canonical) } });
    destination.stateMedia = targets.map((target, index) => ({ stateHash: definition.hash, position: index, assetId: `existing-alias-${index}`, fileId: `existing-file-${index}`,
      locationId: `existing-location-${index}`, purpose: target.purpose, scope: "system", profileId: "other-profile", profileRevision: 1,
      namespaceIdentity: target.namespaceIdentity, sha256: target.sha256, byteSize: target.byteSize }));
    await expect(prepareImportDomainPlan(value, { destination, files: targets, acceptedAt: at, randomId: randomIds() })).rejects.toThrow("definition_media_destination_conflict");
    destination.stateMedia.forEach(row => row.profileId = "frozen-profile");
    const reused = await prepareImportDomainPlan(value, { destination, files: targets, acceptedAt: at, randomId: randomIds("state-reuse") });
    expect(reused.rows.some(row => row.kind === "state" || row.kind === "stateAsset")).toBe(false);
    expect(reused.fileReuses).toEqual([
      { packageFileId: "logical-one", fileId: "existing-file-0", locationId: "existing-location-0", assetId: "existing-alias-0" },
      { packageFileId: "logical-two", fileId: "existing-file-1", locationId: "existing-location-1", assetId: "existing-alias-1" },
    ]);
  });

  it("rolls back the complete business graph when a late deferred FK is missing", async () => {
    const result = await plan(await pkg([sample("rollback-a", { parent_id: "rollback-b" }), sample("rollback-b", { parent_id: "rollback-a" })]), [], "rollback-copy");
    result.rows[1].data.parent_id = "missing-destination-parent";
    await expect(db.batch(prepareImportDomainPublication(db, result))).rejects.toThrow();
    expect(sql.prepare("SELECT count(*) AS n FROM samples WHERE id LIKE 'rollback-copy-%'").get()?.n).toBe(0);
    expect(sql.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys).toBe(0);
  });

  it("rejects oversized final rows before a job can start copying bytes", async () => {
    const value = await pkg([sample("oversized-source", { description: "x".repeat(100 * 1024) })]);
    await expect(plan(value)).rejects.toThrow("record_limit");
  });

  it("admits a bounded mapped plan and rejects aggregate plan growth despite valid individual records", async () => {
    const value = await pkg(Array.from({ length: 20 }, (_, index) => sample(`budget-source-${index}`, { description: "x".repeat(40 * 1024) })));
    const destination = await readImportDestinationSnapshot(db, value);
    const result = await prepareImportDomainPlan(value, { destination, files: [], acceptedAt: at, randomId: randomIds("budget-copy") });
    expect(new TextEncoder().encode(stableJson(result)).byteLength).toBeLessThanOrEqual(RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES);
    expect(await estimateResearchImportPlanBudget(value, { columns: destination.columns, targets: [] })).toMatchObject({ supported: true, reason: null });
    const oversized = await pkg(Array.from({ length: 28 }, (_, index) => sample(`large-budget-source-${index}`, { description: "x".repeat(40 * 1024) })));
    const estimate = await estimateResearchImportPlanBudget(oversized, { columns: destination.columns, targets: [] });
    expect(estimate).toMatchObject({ supported: false, reason: "import_plan_budget" });
    expect(estimate.estimatedBytes).toBeGreaterThan(RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES);
    await expect(prepareImportDomainPlan(oversized, { destination, files: [], acceptedAt: at, randomId: randomIds("large-budget-copy") })).rejects.toThrow("import_plan_budget");
    result.rows[0].data.description = "x".repeat(RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES);
    expect(() => importDomainIdentityStatements(db, "unaccepted-job", result)).toThrow("import_plan_budget");
    expect(() => prepareImportDomainPublication(db, result)).toThrow("import_plan_budget");
    expect(sql.prepare("SELECT count(*) AS n FROM samples WHERE id LIKE 'budget-copy-%' OR id LIKE 'large-budget-copy-%'").get()?.n).toBe(0);
  });

  it("refuses failed and pending SourceImport provenance without converting it into a ready local workflow", async () => {
    for (const status of ["failed", "pending"]) {
      const value = await pkg([sample(`historical-${status}-sample`), record("sourceImport", `historical-${status}-import`, {
        status, source_filename: "historical-source.xlsx", source_sha256: await sha256Hex("historical-source"), sheet_name: "Sheet1", template_type: "process",
        recipe_family_id: null, template_version_id: null, workbookPackageFileId: null, manifestPackageFileId: null,
        warning_count: 0, error_message: status === "failed" ? "Foreign historical failure" : null,
      })]);
      const original = stableJson(value), destination = await readImportDestinationSnapshot(db, value);
      let allocated = 0;
      await expect(prepareImportDomainPlan(value, { destination, files: [], acceptedAt: at, randomId: () => `forbidden-allocation-${++allocated}` }))
        .rejects.toThrow("unsupported_source_import_state");
      expect(allocated).toBe(0);
      expect(await estimateResearchImportPlanBudget(value, { columns: destination.columns, targets: [] }))
        .toMatchObject({ supported: false, estimatedBytes: null, reason: "unsupported_source_import_state" });
      expect(stableJson(value)).toBe(original);
      expect(sql.prepare("SELECT count(*) AS n FROM imports WHERE id=?").get(`historical-${status}-import`)?.n).toBe(0);
      expect(sql.prepare("SELECT count(*) AS n FROM samples WHERE id LIKE 'forbidden-allocation-%'").get()?.n).toBe(0);
    }
  });
});

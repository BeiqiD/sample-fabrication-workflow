import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkedResearchJobStatus, checkedResearchPackagePreview, checkedResearchRequestReceipt,
  type ResearchImportInput, type ResearchRoot } from "../../shared/contracts/research-package-api";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import { researchRecordsDocument, type ResearchPackageV1 } from "../../shared/contracts/research-package";
import { createStoreArchiveStream, measureStoreArchive, sourceFromBlob, validateStoreArchive, type ArchiveEntry } from "../../shared/domain/research-archive";
import { stableJson } from "../../shared/domain/content-addressing";
import { validateFullExportV23 } from "../../shared/contracts/export-protocol";
import { buildFullExportArchiveV23 } from "../../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "../../scripts/lib/export-restore";
import { blobRoutes } from "../export-routes";
import { snapshotFullExportV23 } from "../export-v23-snapshot";
import { snapshotFullExportV24 } from "../export-v24-snapshot";
import { SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS } from "../../shared/contracts/export-system-recovery-evidence";
import { SqliteD1Database } from "../reference-test-support";
import { readPublishedFile } from "../files/authority-reader";
import { setFileJobExecution } from "../files/jobs/worker-runtime";
import { startStorageCandidateCheck } from "../storage/candidate-check-service";
import { saveStorageCandidate } from "../storage/configuration-registry";
import { activateNativeStorageProfile } from "../storage/native-profile-activation";
import { registerStorageProfile } from "../storage/storage-profile-admission-service";
import { setStorageRoleDefaults } from "../storage/storage-role-policy";
import type { Env } from "../types";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { buildImportDomainFixture } from "./import-domain-test-support";
import type { FrozenImportDomainPlan } from "./import-domain-types";
import { REFERENCE_IMPORT_KINDS } from "./import-domain-identity";
import { dispatchPackageJobs, packageRepository, readValidatedPackage } from "./jobs/worker-runtime";
import { packageRoutes } from "./routes";
import { PACKAGE_SNAPSHOT_CLOSURE_SQL, packageCaptureBindings } from "./snapshot-closure";

type Fixture = Awaited<ReturnType<typeof nativeAcceptanceFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.sql.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function collect(body: ReadableStream<Uint8Array>) { return new Uint8Array(await new Response(body).arrayBuffer()); }
async function fixtureArchive(value: Awaited<ReturnType<typeof buildImportDomainFixture>>) {
  const { records, ...manifest } = value.package, encode = new TextEncoder();
  const contents = new Map<string, Uint8Array>([
    ["manifest.json", encode.encode(stableJson(manifest))], ["records.json", encode.encode(stableJson(researchRecordsDocument(records)))],
    ["report/index.html", encode.encode("<!doctype html><p>Inert qualification report</p>")], ["report/report.md", encode.encode("# Qualification report")],
    ...value.package.files.map(file => [file.path, value.payloads.get(file.packageFileId)!] as const),
  ]);
  const entries: ArchiveEntry[] = [...contents].map(([path, bytes]) => ({ path, kind: path.startsWith("files/") ? "payload" : path.startsWith("report/") ? "report" : "metadata", byteSize: bytes.length, sha256: sha(bytes) }));
  const open = async (entry: ArchiveEntry) => new Response(contents.get(entry.path)!.slice().buffer as ArrayBuffer).body!;
  const measured = await measureStoreArchive(entries, open), bytes = await collect(createStoreArchiveStream(entries, open));
  expect(bytes.length).toBe(measured.byteSize); expect(sha(bytes)).toBe(measured.sha256);
  return { bytes, measured };
}
function api(f: Fixture) {
  f.env.ACCESS_TEAM_DOMAIN = "qualification.cloudflareaccess.com"; f.env.ACCESS_AUD = "research-package-qualification"; f.env.ALLOWED_EMAILS = f.actor;
  const diagnostics: string[] = [], nativeBatch = f.db.batch.bind(f.db);
  const compile = f.db.compiledStatement.bind(f.db);
  vi.spyOn(f.db, "compiledStatement").mockImplementation(sql => {
    try { return compile(sql); } catch (error) {
      if (process.env.FP4_ROUNDTRIP_SQL_FAILURE_FILE) writeFileSync(process.env.FP4_ROUNDTRIP_SQL_FAILURE_FILE, sql + "\n");
      diagnostics.push(`Statement preparation: ${String(error)} (${sql.slice(0, 100)})`); throw error;
    }
  });
  vi.spyOn(f.db, "batch").mockImplementation(async statements => {
    try { return await nativeBatch(statements); } catch (error) { diagnostics.push(String(error)); throw error; }
  });
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.use("*", async (c, next) => { c.set("userEmail", f.actor); await next(); }); app.route("/api", packageRoutes); app.route("/api", blobRoutes);
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://qualification.test/api${path}`, init), f.env);
  const json = async (path: string, value: unknown, expected = 202) => {
    const response = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const body = await response.json(); expect(response.status, `${path}: ${JSON.stringify(body)} ${diagnostics.slice(-3).join("; ")}`).toBe(expected); return body;
  };
  const status = async (id: string) => { const response = await request(`/packages/jobs/${id}`); expect(response.status).toBe(200); return checkedResearchJobStatus(await response.json()); };
  return { request, json, status, diagnostics };
}
type Api = ReturnType<typeof api>;
function revision(f: Fixture) { return Number(f.sql.prepare("SELECT max(policy_revision) revision FROM storage_role_policy_revisions").get()!.revision); }
async function defaults(f: Fixture, profileId: string) {
  await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: revision(f), internalProfileId: profileId, originalsProfileId: profileId }, f.actor);
}
async function pair(direction: "R2→S3" | "S3→R2" | "S3→S3") {
  const source = await nativeAcceptanceFixture(direction !== "R2→S3", { throughMigration: "0020_fp4_research_packages.sql" }); fixtures.push(source);
  const destination = await nativeAcceptanceFixture(direction !== "S3→R2", { throughMigration: "0020_fp4_research_packages.sql" }); fixtures.push(destination);
  // Both declared R2 bootstrap namespaces name the same actual bucket. Share
  // that exact isolated provider object across installations, rather than
  // pretending identical namespace strings refer to different provider bytes.
  destination.env.ASSETS = source.env.ASSETS;
  const objects = new Map<string, ArrayBuffer>(), provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && !init ? input : new Request(input, init);
    expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(request.headers.get("x-amz-expected-bucket-owner")).toBe("111122223333");
    if (request.method === "PUT") { objects.set(request.url, await request.arrayBuffer()); return new Response(null); }
    if (request.method === "DELETE") { objects.delete(request.url); return new Response(null, { status: 204 }); }
    const bytes = objects.get(request.url); return bytes ? new Response(request.method === "HEAD" ? null : bytes.slice(0), {
      headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream", etag: '"package-qualification"' },
    }) : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", provider);
  let target = direction === "S3→R2" ? "r2-profile" : destination.admission.nativeProfileId;
  if (direction === "S3→S3") {
    const saved = await saveStorageCandidate(destination.env, { expectedRevision: null, label: "Independent package destination",
      namespace: { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "package-roundtrip-destination", root: "copies", forcePathStyle: true, expectedBucketOwner: "111122223333" },
      credentials: { mode: "replace", value: { accessKeyId: "fixture-package-target", secretAccessKey: "fixture-package-secret" } } }, destination.actor);
    const check = await startStorageCandidateCheck(destination.env, { checkId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1 }, destination.actor, { fetch: provider });
    expect(check.status).toBe("succeeded");
    const admitted = await registerStorageProfile(destination.env, { operationId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1, expectedEnvelopeRevision: 1, checkId: check.id }, destination.actor);
    await activateNativeStorageProfile(destination.env, { operationId: crypto.randomUUID(), nativeProfileId: admitted.nativeProfileId, candidateProfileId: saved.profileId,
      expectedCandidateRevision: 1, expectedEnvelopeRevision: 1, checkId: check.id, expectedBindingRevision: null }, destination.actor);
    target = admitted.nativeProfileId;
  }
  const sourceTarget = direction === "R2→S3" ? "r2-profile" : source.admission.nativeProfileId;
  await defaults(source, sourceTarget); await defaults(destination, target);
  await setFileJobExecution(source.env, true); await setFileJobExecution(destination.env, true);
  const sourceApi = api(source), destinationApi = api(destination);
  const puts = () => source.r2Put.mock.calls.length + provider.mock.calls.filter(([input]) => (input as Request).method === "PUT").length;
  return { source, destination, sourceApi, destinationApi, sourceTarget, target, provider, objects, puts };
}
async function drain(f: Fixture, client: Api, id: string, terminal: "completed" | "preview" = "completed") {
  for (let step = 0; step < 110; step++) {
    const state = await client.status(id); if (state.state === terminal) return state;
    expect(state.state, `job ${id}: ${JSON.stringify(state)} ${client.diagnostics.slice(-3).join("; ")}`).not.toBe("paused");
    const result = await dispatchPackageJobs({ ...f.env }); expect(result.jobId).toBe(id); expect(result.outcome, client.diagnostics.slice(-3).join("; ")).not.toBe("paused");
  }
  throw new Error("Package job did not reach its bounded terminal state");
}
async function upload(f: Fixture, client: Api, bytes: Uint8Array) {
  const input = { requestId: crypto.randomUUID(), byteSize: bytes.length, sha256: sha(bytes) };
  const receipt = checkedResearchRequestReceipt(await client.json("/packages/uploads", input)); expect(receipt.job.state).toBe("awaiting_upload");
  const response = await client.request(`/packages/jobs/${receipt.job.id}/upload`, { method: "PUT", headers: { "content-length": String(bytes.length) }, body: bytes.slice().buffer as ArrayBuffer });
  const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200);
  expect(checkedResearchJobStatus(body).phase).toBe("validate");
  return { id: receipt.job.id, input };
}
async function importRequest(f: Fixture, client: Api, uploadJobId: string, anotherCopy = false) {
  const previewResponse = await client.request(`/packages/jobs/${uploadJobId}/preview`), body = await previewResponse.json();
  expect(previewResponse.status, JSON.stringify(body)).toBe(200); const preview = checkedResearchPackagePreview(body);
  expect(preview.complete).toBe(true); expect(preview.capabilities.dataPackage.available).toBe(true);
  const input: ResearchImportInput = { requestId: crypto.randomUUID(), uploadJobId, anotherCopy, expectedRolePolicyRevision: preview.rolePolicyRevision };
  const receipt = checkedResearchRequestReceipt(await client.json("/packages/imports", input));
  return { input, receipt, preview };
}
function plan(f: Fixture, id: string): FrozenImportDomainPlan { return JSON.parse(String(f.sql.prepare("SELECT domain_plan_json FROM research_package_jobs WHERE id=?").get(id)!.domain_plan_json)); }
function businessSnapshot(f: Fixture) {
  const tables = new Set(Object.values(RESEARCH_PACKAGE_CATALOG).map(row => row.table));
  return [...tables].sort().map(table => [table, f.sql.prepare(`SELECT * FROM ${table}`).all().sort((left, right) => {
    const a = stableJson(left), b = stableJson(right); return a < b ? -1 : a > b ? 1 : 0;
  })]);
}
function graph(f: Fixture, frozen: FrozenImportDomainPlan, original: ResearchPackageV1) {
  const mapped = (kind: ResearchRecordKind, id: string) => frozen.identities.find(row => row.kind === kind && row.sourceId === id)!.destinationId;
  for (const row of frozen.rows) {
    const fields = RESEARCH_PACKAGE_CATALOG[row.kind].id, actual = f.sql.prepare(`SELECT * FROM ${row.table} WHERE ${fields.map(field => `${field}=?`).join(" AND ")}`).get(...fields.map(field => row.data[field] as string | number | null));
    expect(actual, `${row.kind}:${row.sourceId}`).toMatchObject(row.data);
    if (fields.length === 1 && fields[0] === "id") expect(row.id).not.toBe(row.sourceId);
  }
  const comments = frozen.rows.filter(row => row.kind === "comment"); expect(comments).toHaveLength(1);
  expect(frozen.rows.filter(row => row.kind === "commentTarget")).toHaveLength(2);
  const originals = original.records.filter(row => row.kind === "commentItem");
  for (const source of originals) {
    const copied = f.sql.prepare("SELECT * FROM comment_submission_items WHERE id=?").get(mapped("commentItem", source.sourceId))!;
    expect(copied.related_item_id).toBe(mapped("commentItem", String(source.data.related_item_id))); expect(copied.submission_id).toBe(comments[0].id);
  }
  expect(frozen.rows.filter(row => row.kind === "reference")).toHaveLength(9);
  for (const reference of original.records.filter(row => row.kind === "reference")) {
    const target = reference.data.target as { kind: ResearchRecordKind; sourceId: string }, copied = f.sql.prepare("SELECT * FROM reference_targets WHERE id=?").get(mapped("reference", reference.sourceId))!;
    expect(copied.target_id).toBe(mapped(target.kind, target.sourceId)); expect(copied.target_type).toBe(Object.entries(REFERENCE_IMPORT_KINDS).find(([, kind]) => kind === target.kind)![0]);
  }
  for (const kind of ["state", "stepDefinition"] as const) for (const record of original.records.filter(row => row.kind === kind)) expect(mapped(kind, record.sourceId)).toBe(record.sourceId);
  const states = f.sql.prepare("SELECT asset_id,file_id,position FROM state_representation_assets ORDER BY position").all();
  expect(states).toHaveLength(2); expect(states[0].asset_id).not.toBe(states[1].asset_id); expect(states[0].file_id).not.toBe(states[1].file_id);
  expect(frozen.rows.some(row => row.kind === "projectContent" && row.data.deleted_at !== null)).toBe(true);
  expect(frozen.rows.some(row => row.kind === "projectEdge" && row.data.deleted_at !== null)).toBe(true);
  expect(frozen.rows.filter(row => row.kind === "projectPlacement")).toHaveLength(11);
  expect(frozen.rows.find(row => row.kind === "sample")!.data.title).toBe("foreign-run-one remains literal title");
  expect(frozen.rows.find(row => row.kind === "event")!.data.body).toBe("foreign-run-one remains ordinary event text");
  expect(frozen.rows.find(row => row.kind === "projectContent" && row.data.content_type === "markdown")!.data.markdown_source).toContain("foreign-run-one remains user text");
  const event = frozen.rows.find(row => row.kind === "event")!, metadata = JSON.parse(String(event.data.metadata_json));
  expect(metadata.rawCells).toEqual({ stepId: "foreign-step-one" });
  const sourceEvent = original.records.find(row => row.kind === "event")!;
  const relationships = sourceEvent.data.relationships as Array<{ field: string; target: { kind: ResearchRecordKind; sourceId: string } }>;
  for (const relation of relationships.filter(row => row.field === "runId" || row.field.startsWith("stepIds["))) {
    const index = /^stepIds\[(\d+)\]$/.exec(relation.field);
    expect(index ? metadata.stepIds[Number(index[1])] : metadata.runId).toBe(mapped(relation.target.kind, relation.target.sourceId));
  }
  expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
async function bytesAndPurposes(f: Fixture, id: string, expected: ResearchPackageV1, payloads: Map<string, Uint8Array>, target: string) {
  const files = await packageRepository(f.env).files(id); expect(files).toHaveLength(expected.files.length);
  for (const file of files) {
    const definition = expected.files.find(row => row.packageFileId === file.logical_file_id)!;
    expect(file.target_profile_id).toBe(target); expect(file.purpose).toBe(definition.purpose); expect(file.sha256).toBe(definition.sha256);
    const current = f.sql.prepare(`SELECT p.purpose,p.verified_sha256,p.verified_byte_size,l.storage_profile_id FROM file_usable_publications p
      JOIN file_location_publications l ON l.location_id=p.active_location_id WHERE p.file_id=?`).get(file.result_file_id)!;
    expect(current).toMatchObject({ purpose: definition.purpose, verified_sha256: definition.sha256, verified_byte_size: definition.byteSize, storage_profile_id: target });
    const read = await readPublishedFile(f.env, { fileId: String(file.result_file_id), purpose: definition.purpose }); expect(read.outcome).toBe("available");
    if (read.outcome !== "available") throw new Error("Missing imported File bytes");
    expect(Buffer.from(await collect(read.body)).equals(Buffer.from(payloads.get(file.logical_file_id)!))).toBe(true);
    if (file.candidate_asset_id) expect(f.sql.prepare("SELECT r2_key,file_id,sha256,byte_size FROM assets WHERE id=?").get(file.candidate_asset_id)).toMatchObject({
      r2_key: null, file_id: file.result_file_id, sha256: definition.sha256, byte_size: definition.byteSize });
    const alias = expected.records.find(row => row.kind === "fileAlias" && row.data.packageFileId === file.logical_file_id);
    if (alias) expect(f.sql.prepare("SELECT original_name,mime_type,created_at FROM assets WHERE id=?").get(file.candidate_asset_id)).toEqual({
      original_name: alias.data.original_name, mime_type: alias.data.mime_type, created_at: alias.data.created_at });
  }
}
function allFileSlots(pkg: ResearchPackageV1) {
  const slots: Array<[ResearchRecordKind, string]> = [["stateAsset", "packageFileId"], ["executionImage", "packageFileId"], ["metrologyReference", "packageFileId"],
    ["commentOccurrence", "packageFileId"], ["stateVerification", "evidencePackageFileId"], ["commentItem", "packageFileId"], ["projectAttachment", "packageFileId"],
    ["recipeRevision", "sourcePackageFileId"], ["sourceImport", "workbookPackageFileId"], ["sourceImport", "manifestPackageFileId"],
    ["event", "packageFileId"], ["event", "thumbnailPackageFileId"], ["attachmentDerivative", "derivedPackageFileId"]];
  for (const [kind, field] of slots) {
    const values = pkg.records.filter(row => row.kind === kind && typeof row.data[field] === "string").map(row => row.data[field]);
    expect(values.length, `${kind}.${field}`).toBeGreaterThan(0);
    for (const value of values) expect(pkg.files.some(file => file.packageFileId === value), `${kind}.${field}:${value}`).toBe(true);
  }
  expect(pkg.records.find(row => row.kind === "attachmentDerivative")!.data.trust_state).toBe("imported_unverified");
  expect(pkg.records.find(row => row.kind === "fileDerivation")!.data.trust_state).toBe("imported_unverified");
}
function projectionParity(f: Fixture, roots: ResearchRoot[]) {
  const bindings = packageCaptureBindings(roots, "qualification-read-only-projection", new Date().toISOString());
  const columns = "kind,id,sub,slot,file_id,expected_purpose,resolution_state";
  const captured = f.sql.prepare(`${PACKAGE_SNAPSHOT_CLOSURE_SQL} SELECT ${columns} FROM base_bindings ORDER BY kind,id,sub,slot`).all(...bindings);
  const projected = f.sql.prepare(`${PACKAGE_SNAPSHOT_CLOSURE_SQL} SELECT p.consumer_kind kind,p.consumer_id id,p.consumer_sub_id sub,p.file_slot slot,
    p.file_id,p.expected_purpose,p.resolution_state FROM file_consumer_projection p JOIN base_bindings b
    ON b.kind=p.consumer_kind AND b.id=p.consumer_id AND b.sub=p.consumer_sub_id AND b.slot=p.file_slot
    ORDER BY kind,id,sub,slot`).all(...bindings);
  expect(captured.length).toBeGreaterThan(12); expect(captured).toEqual(projected);
  expect(f.sql.prepare("SELECT count(*) n FROM file_derivations").get()!.n).toBe(0);
  expect(f.sql.prepare("SELECT count(*) n FROM attachment_derivatives").get()!.n).toBe(0);
}
async function completedHistory(f: Fixture) {
  const manifest = await snapshotFullExportV23(f.env.DB); expect(await validateFullExportV23(manifest)).toEqual(manifest);
  expect(manifest.tables.research_package_jobs.some(row => row.kind === "import" && row.state === "completed")).toBe(true);
  expect(manifest.tables.research_package_identity_maps.length).toBeGreaterThan(0);
  return manifest;
}
async function rejectBrokenPreviewEvidence(manifest: Awaited<ReturnType<typeof completedHistory>>, jobId: string) {
  const preview = manifest.tables.research_package_records.find(row => row.job_id === jobId && row.record_kind === "commentItem"
    && JSON.parse(String(row.record_json)).data.kind === "comment_image")!;
  expect(preview).toBeDefined();
  const withoutRecord = structuredClone(manifest);
  withoutRecord.tables.research_package_records = withoutRecord.tables.research_package_records.filter(row =>
    !(row.job_id === jobId && row.record_kind === "commentItem" && row.source_id === preview.source_id));
  await expect(validateFullExportV23(withoutRecord)).rejects.toThrow("Comment preview provenance");
  const unfinished = structuredClone(manifest);
  unfinished.tables.research_package_jobs.find(row => row.id === jobId)!.state = "paused";
  // Keep the unfinished source held, so this negative reaches the completed
  // provenance fence rather than failing the independent source-hold invariant.
  unfinished.tables.file_location_holds.find(row => row.operation_id === `fp4-source:${jobId}`)!.released_at = null;
  await expect(validateFullExportV23(unfinished)).rejects.toThrow("Comment preview provenance");
  expect(await validateFullExportV23(manifest)).toEqual(manifest);
}
async function rejectBrokenR2Alias(manifest: Awaited<ReturnType<typeof completedHistory>>) {
  const profileIds = new Set(manifest.tables.storage_profiles.filter(row => row.adapter_type === "r2").map(row => row.id));
  const neutral = manifest.tables.assets.find(row => row.r2_key === null && row.file_id !== null && profileIds.has(row.storage_profile_id));
  expect(neutral).toBeDefined(); const damaged = structuredClone(manifest);
  damaged.tables.assets.find(row => row.id === neutral!.id)!.object_key = "different-valid-neutral-alias-key";
  await expect(validateFullExportV23(damaged)).rejects.toThrow("native asset");
  expect(await validateFullExportV23(manifest)).toEqual(manifest);
}
async function restoreCompletedHistory(f: Fixture, client: Api, manifest: Awaited<ReturnType<typeof completedHistory>>) {
  const packaged = await buildFullExportArchiveV23(manifest, undefined, async input => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://qualification.test");
    return client.request(url.pathname.replace(/^\/api(?=\/)/, "") + url.search);
  });
  expect(packaged.warnings).toEqual([]);
  const directory = await mkdtemp(join(tmpdir(), "fp4-completed-package-backup-")); let restoredDb: DatabaseSync | undefined;
  try {
    const archivePath = join(directory, "full.zip"); await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
    const restored = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "restored"),
      migrationsDirectory: fileURLToPath(new URL("../../migrations/", import.meta.url)), targetCompatibilitySchema: "S2" });
    restoredDb = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
    const recovered = await snapshotFullExportV24(new SqliteD1Database(restoredDb) as unknown as D1Database);
    expect(recovered.schemaVersion).toBe(24);
    expect(Object.fromEntries(Object.keys(manifest.tables).map(name => [name, recovered.tables[name]]))).toEqual(manifest.tables);
    for (const name of Object.keys(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS)) expect(recovered.tables[name]).toEqual([]);
    expect(restoredDb.prepare("SELECT installation_id FROM research_package_source_identity").get()!.installation_id)
      .toBe(f.sql.prepare("SELECT installation_id FROM research_package_source_identity").get()!.installation_id);
    expect(restoredDb.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(restoredDb.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").get()).toEqual({ enabled: 0, incarnation: null });
    expect(restoredDb.prepare("SELECT * FROM system_research_package_cleanup_grants").all()).toEqual([]);
    expect(restoredDb.prepare("SELECT * FROM research_package_live_verified_attempts").all()).toEqual([]);
    expect(restoredDb.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { restoredDb?.close(); await rm(directory, { recursive: true, force: true }); }
}

describe("native package API and independent kernel whole-flow qualification", () => {
  it.each(["R2→S3", "S3→R2", "S3→S3"] as const)("round trips the complete nonempty graph %s with frozen per-purpose destinations and explicit copy identity", async direction => {
    const f = await pair(direction), foreign = await buildImportDomainFixture(), seedZip = await fixtureArchive(foreign);
    allFileSlots(foreign.package);
    const seedUpload = await upload(f.source, f.sourceApi, seedZip.bytes); await drain(f.source, f.sourceApi, seedUpload.id, "preview");
    const seed = await importRequest(f.source, f.sourceApi, seedUpload.id); await drain(f.source, f.sourceApi, seed.receipt.job.id);
    graph(f.source, plan(f.source, seed.receipt.job.id), foreign.package);
    await bytesAndPurposes(f.source, seed.receipt.job.id, foreign.package, foreign.payloads, f.sourceTarget);
    const roots = (await f.sourceApi.status(seed.receipt.job.id)).result!.roots;
    projectionParity(f.source, roots);
    const exportInput = { requestId: crypto.randomUUID(), kind: "data_package", roots }, beforeAcceptance = f.puts();
    const accepted = checkedResearchRequestReceipt(await f.sourceApi.json("/packages/jobs", exportInput)); expect(f.puts()).toBe(beforeAcceptance);
    const exportJob = await drain(f.source, f.sourceApi, accepted.job.id); expect(exportJob.output?.available).toBe(true);
    const download = await f.sourceApi.request(`/packages/jobs/${accepted.job.id}/download`); expect(download.status).toBe(200); const exported = new Uint8Array(await download.arrayBuffer());
    expect(sha(exported)).toBe(exportJob.output!.sha256);
    const zip = await validateStoreArchive(sourceFromBlob(new Blob([exported])), { expectedSha256: sha(exported) });
    const sourceRecords = JSON.parse(new TextDecoder().decode(zip.metadata.get("records.json")!));
    expect(sourceRecords.records.filter((row: { kind: string }) => row.kind === "reference")).toHaveLength(9);
    expect(sourceRecords.records.filter((row: { kind: string }) => row.kind === "sample")).toHaveLength(1);
    expect(sourceRecords.records.some((row: { sourceId: string }) => row.sourceId === "sample-native")).toBe(false);
    const sourcePackage = await readValidatedPackage(packageRepository(f.source.env), seedUpload.id);
    const destUpload = await upload(f.destination, f.destinationApi, exported); await drain(f.destination, f.destinationApi, destUpload.id, "preview");
    const destinationPackage = await readValidatedPackage(packageRepository(f.destination.env), destUpload.id), bytes = new Map<string, Uint8Array>();
    allFileSlots(destinationPackage);
    for (const file of destinationPackage.files) {
      const initial = foreign.package.files.find(row => row.sha256 === file.sha256 && row.purpose === file.purpose)!; bytes.set(file.packageFileId, foreign.payloads.get(initial.packageFileId)!);
    }
    expect(destinationPackage.files).toHaveLength(15);
    expect(destinationPackage.sourceInstallationId).toBe(f.source.sql.prepare("SELECT installation_id FROM research_package_source_identity").get()!.installation_id);
    expect(destinationPackage.sourceInstallationId).not.toBe(f.destination.sql.prepare("SELECT installation_id FROM research_package_source_identity").get()!.installation_id);
    expect(sourcePackage.sourceInstallationId).toBe("foreign-installation");
    const copy = await importRequest(f.destination, f.destinationApi, destUpload.id), frozen = plan(f.destination, copy.receipt.job.id), priorPuts = f.puts();
    await defaults(f.destination, f.target === "r2-profile" ? f.destination.admission.nativeProfileId : "r2-profile");
    await drain(f.destination, f.destinationApi, copy.receipt.job.id); graph(f.destination, frozen, destinationPackage);
    await bytesAndPurposes(f.destination, copy.receipt.job.id, destinationPackage, bytes, f.target);
    projectionParity(f.destination, frozen.roots);
    expect(f.puts()).toBeGreaterThan(priorPuts);
    expect((await f.destinationApi.status(copy.receipt.job.id)).result?.roots).toEqual(frozen.roots);
    const stable = businessSnapshot(f.destination), writes = f.puts();
    const replay = checkedResearchRequestReceipt(await f.destinationApi.json("/packages/imports", copy.input)); expect(replay.job.id).toBe(copy.receipt.job.id);
    const normal = checkedResearchRequestReceipt(await f.destinationApi.json("/packages/imports", { ...copy.input, requestId: crypto.randomUUID() }));
    expect(normal).toMatchObject({ reused: true, job: { id: copy.receipt.job.id } }); expect(f.puts()).toBe(writes); expect(businessSnapshot(f.destination)).toEqual(stable);
    await defaults(f.destination, f.target);
    const another = await importRequest(f.destination, f.destinationApi, destUpload.id, true); expect(another.receipt.job.id).not.toBe(copy.receipt.job.id);
    const fresh = plan(f.destination, another.receipt.job.id); expect(fresh.roots).not.toEqual(frozen.roots);
    await drain(f.destination, f.destinationApi, another.receipt.job.id);
    graph(f.destination, fresh, destinationPackage); await bytesAndPurposes(f.destination, another.receipt.job.id, destinationPackage, bytes, f.target);
    projectionParity(f.destination, fresh.roots);
    expect(f.destination.sql.prepare("SELECT count(*) n FROM comment_submissions").get()!.n).toBe(2);
    expect(f.destination.sql.prepare("SELECT count(*) n FROM projects").get()!.n).toBe(2);
    expect(f.destination.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const sourceHistory = await completedHistory(f.source), history = await completedHistory(f.destination);
    expect(history.tables.research_package_requests.some(row => row.reused === 1)).toBe(true);
    if (direction === "R2→S3") {
      await rejectBrokenR2Alias(sourceHistory);
      await rejectBrokenPreviewEvidence(history, copy.receipt.job.id);
      await restoreCompletedHistory(f.destination, f.destinationApi, history);
    }
  }, 60_000);

  it("rolls back corruption and late publication faults, retries verified Files, and preserves held sources plus accepted metadata through cleanup", async () => {
    const f = await pair("R2→S3"), foreign = await buildImportDomainFixture(), zip = await fixtureArchive(foreign), original = businessSnapshot(f.destination);
    const corrupt = zip.bytes.slice(), last = zip.measured.entries.at(-1)!; corrupt[last.descriptorOffset - 1] ^= 1;
    const damaged = await upload(f.destination, f.destinationApi, corrupt);
    expect(await dispatchPackageJobs(f.destination.env)).toEqual({ jobId: damaged.id, outcome: "paused" });
    expect(businessSnapshot(f.destination)).toEqual(original);
    await f.destinationApi.json("/packages/imports", { requestId: crypto.randomUUID(), uploadJobId: damaged.id, anotherCopy: false, expectedRolePolicyRevision: revision(f.destination) }, 409);
    const valid = await upload(f.destination, f.destinationApi, zip.bytes); await drain(f.destination, f.destinationApi, valid.id, "preview");
    const accepted = await importRequest(f.destination, f.destinationApi, valid.id), frozen = plan(f.destination, accepted.receipt.job.id);
    const frozenPreviewResponse = await f.destinationApi.request(`/packages/jobs/${accepted.receipt.job.id}/preview`);
    expect(frozenPreviewResponse.status).toBe(200); const frozenPreview = checkedResearchPackagePreview(await frozenPreviewResponse.json());
    const archive = (await packageRepository(f.destination.env).files(valid.id)).find(file => file.entry_kind === "artifact")!;
    await f.destinationApi.json(`/packages/jobs/${valid.id}/control`, { action: "cleanup" }, 200);
    expect(await dispatchPackageJobs(f.destination.env)).toEqual({ jobId: null, outcome: "cleaned" });
    expect(f.destination.sql.prepare("SELECT released_at FROM file_holds WHERE file_id=? AND operation_id=?")
      .get(archive.result_file_id, `fp4-output:${valid.id}`)!.released_at).toBeNull();
    expect(f.destination.sql.prepare("SELECT released_at FROM file_location_holds WHERE location_id=? AND operation_id=?")
      .get(archive.result_location_id, `fp4-source:${accepted.receipt.job.id}`)!.released_at).toBeNull();
    const held = await readPublishedFile(f.destination.env, { fileId: archive.result_file_id!, purpose: "job_output" });
    expect(held.outcome).toBe("available"); if (held.outcome !== "available") throw new Error("Accepted import lost its held raw source");
    expect(await collect(held.body)).toEqual(zip.bytes);
    const late = frozen.rows.filter(row => row.kind === "projectEdge").at(-1)!;
    f.destination.sql.prepare("CREATE TRIGGER roundtrip_late_publication_fault BEFORE INSERT ON project_edges WHEN NEW.id=? BEGIN SELECT RAISE(ABORT,'isolated late publication fault'); END".replace("?", `'${late.id}'`)).run();
    for (let action = 0; action < 30; action++) {
      await dispatchPackageJobs(f.destination.env); if ((await f.destinationApi.status(accepted.receipt.job.id)).state === "paused") break;
    }
    expect((await f.destinationApi.status(accepted.receipt.job.id)).state).toBe("paused"); expect(businessSnapshot(f.destination)).toEqual(original);
    expect(f.destination.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const puts = f.puts(); expect(await dispatchPackageJobs(f.destination.env)).toEqual({ jobId: null, outcome: "idle" }); expect(f.puts()).toBe(puts);
    f.destination.sql.exec("DROP TRIGGER roundtrip_late_publication_fault"); await f.destinationApi.json(`/packages/jobs/${accepted.receipt.job.id}/control`, { action: "retry" }, 200);
    await drain(f.destination, f.destinationApi, accepted.receipt.job.id); expect(f.puts()).toBe(puts);
    graph(f.destination, frozen, foreign.package); await bytesAndPurposes(f.destination, accepted.receipt.job.id, foreign.package, foreign.payloads, f.target);
    await f.destinationApi.json(`/packages/jobs/${valid.id}/control`, { action: "cleanup" }, 200);
    expect(await dispatchPackageJobs(f.destination.env)).toEqual({ jobId: null, outcome: "cleaned" });
    expect(f.destination.sql.prepare("SELECT state,active_location_id FROM file_publications WHERE file_id=?").get(archive.result_file_id))
      .toMatchObject({ state: "retired", active_location_id: null });
    expect(f.destination.sql.prepare("SELECT released_at FROM file_holds WHERE file_id=? AND operation_id=?")
      .get(archive.result_file_id, `fp4-output:${valid.id}`)!.released_at).not.toBeNull();
    expect((await f.destinationApi.request(`/packages/jobs/${valid.id}/preview`)).status).toBe(409);
    await f.destinationApi.json("/packages/imports", { ...accepted.input, requestId: crypto.randomUUID(), anotherCopy: true }, 409);
    const retainedPreviewResponse = await f.destinationApi.request(`/packages/jobs/${accepted.receipt.job.id}/preview`);
    expect(retainedPreviewResponse.status).toBe(200); expect(checkedResearchPackagePreview(await retainedPreviewResponse.json())).toEqual(frozenPreview);
  }, 60_000);
});

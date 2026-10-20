import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { checkedResearchPackagePreview, checkedResearchRequestReceipt } from "../../shared/contracts/research-package-api";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import { researchRecordsDocument, type ResearchPackageV1 } from "../../shared/contracts/research-package";
import { createStoreArchiveStream, measureStoreArchive, sourceFromBlob, validateStoreArchive, type ArchiveEntry } from "../../shared/domain/research-archive";
import { stableJson } from "../../shared/domain/content-addressing";
import { validateFullExportV23 } from "../../shared/contracts/export-protocol";
import { snapshotFullExportV23 } from "../export-v23-snapshot";
import { buildImportDomainFixture } from "./import-domain-test-support";
import type { FrozenImportDomainPlan } from "./import-domain-types";
import { REFERENCE_IMPORT_KINDS } from "./import-domain-identity";
import { nativePackageRoundtripFixture } from "./roundtrip-native-test-support";
import { PACKAGE_SNAPSHOT_CLOSURE_SQL, packageCaptureBindings } from "./snapshot-closure";

type Fixture = Awaited<ReturnType<typeof nativePackageRoundtripFixture>>;
type Client = Fixture["source"];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function collect(body: ReadableStream<Uint8Array>) { return new Uint8Array(await new Response(body).arrayBuffer()); }
async function inputArchive(value: Awaited<ReturnType<typeof buildImportDomainFixture>>) {
  const { records, ...manifest } = value.package, encode = new TextEncoder();
  const bodies = new Map<string, Uint8Array>([
    ["manifest.json", encode.encode(stableJson(manifest))], ["records.json", encode.encode(stableJson(researchRecordsDocument(records)))],
    ["report/index.html", encode.encode("<!doctype html><p>Inert native qualification report</p>")], ["report/report.md", encode.encode("# Native qualification report")],
    ...value.package.files.map(file => [file.path, value.payloads.get(file.packageFileId)!] as const),
  ]);
  const entries: ArchiveEntry[] = [...bodies].map(([path, bytes]) => ({ path, kind: path.startsWith("files/") ? "payload" : path.startsWith("report/") ? "report" : "metadata", byteSize: bytes.length, sha256: sha(bytes) }));
  const open = async (entry: ArchiveEntry) => new Response(bodies.get(entry.path)!.slice().buffer as ArrayBuffer).body!;
  const measured = await measureStoreArchive(entries, open), bytes = await collect(createStoreArchiveStream(entries, open));
  expect({ byteSize: bytes.length, sha256: sha(bytes) }).toEqual({ byteSize: measured.byteSize, sha256: measured.sha256 });
  return bytes;
}
async function drain(client: Client, id: string, terminal: "completed" | "preview" = "completed") {
  for (let action = 0; action < 110; action++) {
    const status = await client.status(id); if (status.state === terminal) return status;
    expect(status.state, JSON.stringify(status)).not.toBe("paused");
    const step = await client.step(); expect(step.jobId).toBe(id); expect(step.outcome, JSON.stringify(step)).not.toBe("paused");
  }
  throw new Error("Native package job exceeded its bounded action count");
}
async function upload(client: Client, bytes: Uint8Array) {
  const input = { requestId: crypto.randomUUID(), byteSize: bytes.length, sha256: sha(bytes) };
  const receipt = checkedResearchRequestReceipt(await client.json("/packages/uploads", input));
  expect(receipt.job.state).toBe("awaiting_upload");
  const response = await client.request(`/packages/jobs/${receipt.job.id}/upload`, { method: "PUT", headers: { "content-length": String(bytes.length) }, body: bytes.slice().buffer as ArrayBuffer });
  expect(response.status, await response.clone().text()).toBe(200);
  await drain(client, receipt.job.id, "preview"); return receipt.job.id;
}
async function acceptImport(client: Client, uploadJobId: string, anotherCopy = false) {
  const response = await client.request(`/packages/jobs/${uploadJobId}/preview`); expect(response.status, await response.clone().text()).toBe(200);
  const preview = checkedResearchPackagePreview(await response.json());
  expect(preview.complete).toBe(true); expect(preview.capabilities.dataPackage.available).toBe(true);
  const input = { requestId: crypto.randomUUID(), uploadJobId, anotherCopy, expectedRolePolicyRevision: preview.rolePolicyRevision };
  const receipt = checkedResearchRequestReceipt(await client.json("/packages/imports", input));
  const row = await client.db.prepare("SELECT domain_plan_json FROM research_package_jobs WHERE id=?").bind(receipt.job.id).first<{ domain_plan_json: string }>();
  return { input, receipt, plan: JSON.parse(row!.domain_plan_json) as FrozenImportDomainPlan };
}
async function assertGraph(client: Client, frozen: FrozenImportDomainPlan, pkg: ResearchPackageV1) {
  const mapped = (kind: ResearchRecordKind, id: string) => frozen.identities.find(row => row.kind === kind && row.sourceId === id)!.destinationId;
  for (const row of frozen.rows) {
    const fields = RESEARCH_PACKAGE_CATALOG[row.kind].id;
    const actual = await client.db.prepare(`SELECT * FROM ${row.table} WHERE ${fields.map(field => `${field}=?`).join(" AND ")}`)
      .bind(...fields.map(field => row.data[field] as string | number | null)).first();
    expect(actual, `${row.kind}:${row.sourceId}`).toMatchObject(row.data);
    if (fields.length === 1 && fields[0] === "id") expect(row.id).not.toBe(row.sourceId);
  }
  expect(frozen.rows.filter(row => row.kind === "comment")).toHaveLength(1);
  expect(frozen.rows.filter(row => row.kind === "commentTarget")).toHaveLength(2);
  for (const source of pkg.records.filter(row => row.kind === "commentItem")) {
    const copied = await client.db.prepare("SELECT related_item_id,submission_id FROM comment_submission_items WHERE id=?").bind(mapped("commentItem", source.sourceId)).first();
    expect(copied).toEqual({ related_item_id: mapped("commentItem", String(source.data.related_item_id)), submission_id: frozen.rows.find(row => row.kind === "comment")!.id });
  }
  const refs = pkg.records.filter(row => row.kind === "reference"); expect(refs).toHaveLength(9);
  for (const reference of refs) {
    const target = reference.data.target as { kind: ResearchRecordKind; sourceId: string };
    const copied = await client.db.prepare("SELECT target_type,target_id FROM reference_targets WHERE id=?").bind(mapped("reference", reference.sourceId)).first();
    expect(copied).toEqual({ target_type: Object.entries(REFERENCE_IMPORT_KINDS).find(([, kind]) => kind === target.kind)![0], target_id: mapped(target.kind, target.sourceId) });
  }
  const ordered = (await client.db.prepare("SELECT asset_id,file_id FROM state_representation_assets ORDER BY position").all()).results;
  expect(ordered).toHaveLength(2); expect(ordered[0].asset_id).not.toBe(ordered[1].asset_id); expect(ordered[0].file_id).not.toBe(ordered[1].file_id);
  expect(frozen.rows.some(row => row.kind === "projectContent" && row.data.deleted_at !== null)).toBe(true);
  expect(frozen.rows.some(row => row.kind === "projectEdge" && row.data.deleted_at !== null)).toBe(true);
  expect(frozen.rows.filter(row => row.kind === "projectPlacement")).toHaveLength(11);
  expect((await client.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await client.db.prepare("PRAGMA defer_foreign_keys").first()).toEqual({ defer_foreign_keys: 0 });
}
async function assertFiles(f: Fixture, side: "source" | "destination", id: string, pkg: ResearchPackageV1, expected: Map<string, Uint8Array>, target: string) {
  const client = f[side], files = (await client.db.prepare(`SELECT f.*,p.purpose published_purpose,p.verified_sha256,p.verified_byte_size,l.storage_profile_id active_profile_id
    FROM research_package_files f JOIN file_usable_publications p ON p.file_id=f.result_file_id
    JOIN file_location_publications l ON l.location_id=p.active_location_id WHERE f.job_id=? ORDER BY f.archive_path`).bind(id).all()).results;
  expect(files).toHaveLength(15);
  for (const file of files) {
    const definition = pkg.files.find(row => row.packageFileId === file.logical_file_id)!;
    expect(file).toMatchObject({ target_profile_id: target, purpose: definition.purpose, published_purpose: definition.purpose,
      sha256: definition.sha256, verified_sha256: definition.sha256, verified_byte_size: definition.byteSize, active_profile_id: target });
    const response = await f.readFile(side, String(file.result_file_id), definition.purpose); expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected.get(definition.packageFileId));
    const alias = pkg.records.find(row => row.kind === "fileAlias" && row.data.packageFileId === definition.packageFileId);
    if (alias) expect(await client.db.prepare("SELECT r2_key,file_id,original_name,mime_type,created_at FROM assets WHERE id=?").bind(file.candidate_asset_id).first()).toEqual({
      r2_key: null, file_id: file.result_file_id, original_name: alias.data.original_name, mime_type: alias.data.mime_type, created_at: alias.data.created_at });
  }
}
function allSerializedSlots(pkg: ResearchPackageV1) {
  const slots: Array<[ResearchRecordKind, string]> = [["stateAsset", "packageFileId"], ["executionImage", "packageFileId"], ["metrologyReference", "packageFileId"],
    ["commentOccurrence", "packageFileId"], ["stateVerification", "evidencePackageFileId"], ["commentItem", "packageFileId"], ["projectAttachment", "packageFileId"],
    ["recipeRevision", "sourcePackageFileId"], ["sourceImport", "workbookPackageFileId"], ["sourceImport", "manifestPackageFileId"],
    ["event", "packageFileId"], ["event", "thumbnailPackageFileId"], ["attachmentDerivative", "derivedPackageFileId"]];
  for (const [kind, field] of slots) {
    const records = pkg.records.filter(row => row.kind === kind && typeof row.data[field] === "string"); expect(records.length, `${kind}.${field}`).toBeGreaterThan(0);
    for (const record of records) expect(pkg.files.some(file => file.packageFileId === record.data[field])).toBe(true);
  }
  for (const kind of ["fileDerivation", "attachmentDerivative"]) expect(pkg.records.find(row => row.kind === kind)!.data.trust_state).toBe("imported_unverified");
}
async function parity(client: Client, roots: FrozenImportDomainPlan["roots"]) {
  const bindings = packageCaptureBindings(roots, "native-projection-parity", new Date().toISOString());
  const captured = (await client.db.prepare(`${PACKAGE_SNAPSHOT_CLOSURE_SQL} SELECT kind,id,sub,slot,file_id,expected_purpose,resolution_state FROM base_bindings ORDER BY kind,id,sub,slot`).bind(...bindings).all()).results;
  const projected = (await client.db.prepare(`${PACKAGE_SNAPSHOT_CLOSURE_SQL} SELECT p.consumer_kind kind,p.consumer_id id,p.consumer_sub_id sub,p.file_slot slot,
    p.file_id,p.expected_purpose,p.resolution_state FROM file_consumer_projection p JOIN base_bindings b
    ON b.kind=p.consumer_kind AND b.id=p.consumer_id AND b.sub=p.consumer_sub_id AND b.slot=p.file_slot ORDER BY kind,id,sub,slot`).bind(...bindings).all()).results;
  expect(captured.length).toBeGreaterThan(12); expect(captured).toEqual(projected);
  expect(await client.db.prepare("SELECT(SELECT count(*) FROM file_derivations) derivations,(SELECT count(*) FROM attachment_derivatives) cache").first()).toEqual({ derivations: 0, cache: 0 });
}

/** Both installations use the released migrations, native D1 sessions/atomic
 * batches, real R2 and native DigestStream. Only isolated S3 provider bytes are
 * doubled; production admission, format, repository and publisher stay intact. */
it("round trips the entire nonempty 13-slot research graph through real workerd D1/R2 to admitted S3 with independent invocations", async () => {
  const f = await nativePackageRoundtripFixture();
  try {
    const foreign = await buildImportDomainFixture(), bytes = await inputArchive(foreign); allSerializedSlots(foreign.package);
    const seedUpload = await upload(f.source, bytes), seed = await acceptImport(f.source, seedUpload);
    await drain(f.source, seed.receipt.job.id); await assertGraph(f.source, seed.plan, foreign.package);
    expect(await f.source.db.prepare("SELECT source_installation_id,package_id FROM research_package_jobs WHERE id=?").bind(seed.receipt.job.id).first())
      .toEqual({ source_installation_id: foreign.package.sourceInstallationId, package_id: foreign.package.packageId });
    await assertFiles(f, "source", seed.receipt.job.id, foreign.package, foreign.payloads, f.sourceTarget); await parity(f.source, seed.plan.roots);
    const beforeExport = f.provider.puts.length, accepted = checkedResearchRequestReceipt(await f.source.json("/packages/jobs", {
      requestId: crypto.randomUUID(), kind: "data_package", roots: seed.plan.roots })); expect(f.provider.puts.length).toBe(beforeExport);
    const result = await drain(f.source, accepted.job.id); expect(result.output?.available).toBe(true);
    const download = await f.source.request(`/packages/jobs/${accepted.job.id}/download`); expect(download.status).toBe(200);
    const exported = new Uint8Array(await download.arrayBuffer()); expect(sha(exported)).toBe(result.output!.sha256);
    await validateStoreArchive(sourceFromBlob(new Blob([exported])), { expectedSha256: sha(exported) });
    const receiverUpload = await upload(f.destination, exported), pkg = await f.readValidated("destination", receiverUpload); allSerializedSlots(pkg);
    const sourceIdentity = await f.source.db.prepare("SELECT installation_id FROM research_package_source_identity").first();
    const destinationIdentity = await f.destination.db.prepare("SELECT installation_id FROM research_package_source_identity").first();
    expect(pkg.sourceInstallationId).toBe(sourceIdentity!.installation_id); expect(pkg.sourceInstallationId).not.toBe(destinationIdentity!.installation_id);
    const payloads = new Map<string, Uint8Array>();
    for (const file of pkg.files) { const source = foreign.package.files.find(row => row.sha256 === file.sha256 && row.purpose === file.purpose)!; payloads.set(file.packageFileId, foreign.payloads.get(source.packageFileId)!); }
    const copy = await acceptImport(f.destination, receiverUpload), frozenWrites = f.provider.puts.length; await f.setDefaults("destination", f.sourceTarget);
    await drain(f.destination, copy.receipt.job.id); await assertGraph(f.destination, copy.plan, pkg);
    await assertFiles(f, "destination", copy.receipt.job.id, pkg, payloads, f.target); await parity(f.destination, copy.plan.roots);
    expect(f.provider.puts.length).toBeGreaterThan(frozenWrites);
    const settledPuts = f.provider.puts.length, counts = await f.destination.db.prepare("SELECT(SELECT count(*) FROM projects) projects,(SELECT count(*) FROM comment_submissions) comments,(SELECT count(*) FROM research_package_files) files").first();
    const replay = checkedResearchRequestReceipt(await f.destination.json("/packages/imports", copy.input)); expect(replay.job.id).toBe(copy.receipt.job.id);
    const ordinary = checkedResearchRequestReceipt(await f.destination.json("/packages/imports", { ...copy.input, requestId: crypto.randomUUID() }));
    expect(ordinary).toMatchObject({ reused: true, job: { id: copy.receipt.job.id } }); expect(f.provider.puts.length).toBe(settledPuts);
    expect(await f.destination.db.prepare("SELECT(SELECT count(*) FROM projects) projects,(SELECT count(*) FROM comment_submissions) comments,(SELECT count(*) FROM research_package_files) files").first()).toEqual(counts);
    await f.setDefaults("destination", f.target); const another = await acceptImport(f.destination, receiverUpload, true);
    expect(another.plan.roots).not.toEqual(copy.plan.roots); await drain(f.destination, another.receipt.job.id);
    await assertGraph(f.destination, another.plan, pkg); await assertFiles(f, "destination", another.receipt.job.id, pkg, payloads, f.target); await parity(f.destination, another.plan.roots);
    expect(await f.destination.db.prepare("SELECT(SELECT count(*) FROM projects) projects,(SELECT count(*) FROM comment_submissions) comments").first()).toEqual({ projects: 2, comments: 2 });
    expect((await f.destination.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]); expect(f.provider.violations).toEqual([]);
    expect(f.provider.puts.some(url => url.includes("/research/"))).toBe(true);
    for (const client of [f.source, f.destination]) {
      const manifest = await snapshotFullExportV23(client.db as unknown as D1Database);
      expect(await validateFullExportV23(manifest)).toEqual(manifest);
      expect(manifest.tables.research_package_jobs.some(row => row.kind === "import" && row.state === "completed")).toBe(true);
      expect(manifest.tables.research_package_identity_maps.length).toBeGreaterThan(0);
      if (client === f.destination) expect(manifest.tables.research_package_requests.some(row => row.reused === 1)).toBe(true);
    }
    const settledProviderRequests = f.provider.requests.length, race = await f.activationRace();
    expect(race).toMatchObject({ observedBatchFence: true, competitor: { bindingRevision: 2 }, errorStatus: 409, newActivationCount: 0 });
    expect(race.after).toMatchObject({ binding_revision: race.competitor.bindingRevision, activation_operation_id: race.competitor.operationId });
    expect(race.originalAfter).toEqual(race.originalBefore); expect(f.provider.requests).toHaveLength(settledProviderRequests);
  } finally { await f.dispose(); }
}, 60_000);

import { createHash, randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect } from "vitest";
import { checkedResearchJobStatus, checkedResearchRequestReceipt } from "../../shared/contracts/research-package-api";
import { RESEARCH_PACKAGE_CATALOG } from "../../shared/contracts/research-package-catalog";
import { validateResearchPackage } from "../../shared/contracts/research-package";
import { createStoreArchiveStream, measureStoreArchive, sourceFromBlob, validateStoreArchive, type ArchiveEntry } from "../../shared/domain/research-archive";
import { fixture, it } from "../files/jobs/local-runtime.qualification-support";
import { retainedCanonicalFileCase } from "../collaboration/current-v28-canonical-comment-file.qualification-support";
import { prepareGenuineCurrentV26R2Pair, type GenuineR2Pair } from "../recovery/current-v26-r2-node-pair.qualification-support";
import { activateR2PackagePeer, nodePackagePeer, packageFixtureArchive, released, type PackagePeer } from "./public-r2-node-pair.qualification-support";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const prefix = "/api/packages";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function ensure(value: unknown): asserts value { if (!value) throw new Error("Original final-payload qualification observation unavailable"); }
async function parentDirectory() {
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? "";
  ensure(isAbsolute(parent) && resolve(parent) === parent && await realpath(parent) === parent); return parent;
}
async function corruptedFinalPayloadArchive() {
  const original = await packageFixtureArchive();
  const originalIndex = await validateStoreArchive(sourceFromBlob(new Blob([original.bytes.slice().buffer as ArrayBuffer])), { expectedSha256: original.measured.sha256 });
  const payloadEntries = originalIndex.entries.filter(entry => entry.kind === "payload"); expect(payloadEntries).toHaveLength(15);
  const last = payloadEntries.at(-1); ensure(last);
  const declaration = original.value.package.files.find(file => file.path === last.path); ensure(declaration);
  const contents = new Map<string, Uint8Array>([...originalIndex.metadata.entries(),
    ...original.value.package.files.map(file => [file.path, original.value.payloads.get(file.packageFileId)!] as const)]);
  const damaged = contents.get(last.path)!.slice(); ensure(damaged.byteLength > 0);
  const first = damaged[0]; ensure(typeof first === "number"); damaged[0] = first ^ 1; contents.set(last.path, damaged);
  const entries: ArchiveEntry[] = originalIndex.entries.map(entry => {
    const bytes = contents.get(entry.path); ensure(bytes);
    return { path: entry.path, kind: entry.kind, byteSize: bytes.byteLength, sha256: digest(bytes) };
  });
  const open = async (entry: ArchiveEntry) => new Response(contents.get(entry.path)!.slice().buffer as ArrayBuffer).body!;
  // The writer measures the actual changed body. It emits matching descriptors,
  // central-directory CRCs and a new complete ZIP hash; metadata stays original.
  const measured = await measureStoreArchive(entries, open);
  const bytes = new Uint8Array(await new Response(createStoreArchiveStream(entries, open)).arrayBuffer());
  expect(bytes.byteLength).toBe(original.bytes.byteLength); expect(bytes.byteLength).toBe(measured.byteSize);
  expect(digest(bytes)).toBe(measured.sha256); expect(measured.sha256).not.toBe(original.measured.sha256);
  const envelope = await validateStoreArchive(sourceFromBlob(new Blob([bytes.slice().buffer as ArrayBuffer])), { expectedSha256: measured.sha256 });
  for (const [path, metadata] of originalIndex.metadata) expect(envelope.metadata.get(path)).toEqual(metadata);
  const pkg = await validateResearchPackage(JSON.parse(new TextDecoder().decode(envelope.metadata.get("manifest.json")!)),
    JSON.parse(new TextDecoder().decode(envelope.metadata.get("records.json")!)));
  expect(pkg.files).toEqual(original.value.package.files); expect(pkg.records).toEqual(original.value.package.records);
  const mismatches = envelope.entries.filter(entry => entry.kind === "payload" && pkg.files.find(file => file.path === entry.path)!.sha256 !== entry.sha256);
  expect(mismatches.map(entry => entry.path)).toEqual([last.path]); expect(envelope.entries.at(-1)?.path).toBe(last.path);
  expect(mismatches[0]!.sha256).toBe(digest(damaged)); expect(mismatches[0]!.sha256).not.toBe(declaration.sha256);
  return { bytes, measured, lastPath: last.path, logicalFileId: declaration.packageFileId,
    declaredPayloadSha256: declaration.sha256, actualPayloadSha256: digest(damaged), payloadByteSize: declaration.byteSize,
    crcAndWholeArchiveVerified: true, metadataUnchanged: true, otherPayloadsVerified: payloadEntries.length - mismatches.length };
}
async function canonicalRows(peer: PackagePeer) {
  const tables = [...new Map(Object.values(RESEARCH_PACKAGE_CATALOG).map(spec => [spec.table, spec])).values()].sort((a, b) => a.table.localeCompare(b.table));
  const observed: Record<string, Record<string, unknown>[]> = {};
  for (const spec of tables) {
    ensure(/^[a-z][a-z0-9_]*$/.test(spec.table) && spec.id.every(field => /^[a-z][a-z0-9_]*$/.test(field)));
    observed[spec.table] = await peer.rows(`SELECT * FROM "${spec.table}" ORDER BY ${spec.id.map(field => '"' + field + '"').join(',')}`);
  }
  return observed;
}
async function refuseCorruptArchive(peer: PackagePeer, emitValidation: () => Promise<void>, pair?: GenuineR2Pair) {
  const corrupt = await corruptedFinalPayloadArchive(), before = await canonicalRows(peer);
  const publicationBefore = Number((await peer.rows("SELECT count(*) n FROM file_usable_publications"))[0]?.n);
  expect((await peer.rows("SELECT count(*) n FROM research_package_jobs"))[0]?.n).toBe(0);
  const uploadInput = { requestId: randomUUID(), byteSize: corrupt.bytes.byteLength, sha256: corrupt.measured.sha256 };
  const accepted = await peer.request("POST", prefix + "/uploads", uploadInput); expect(accepted.status).toBe(202);
  const upload = checkedResearchRequestReceipt(accepted.value); expect(upload.job.state).toBe("awaiting_upload");
  const sent = await peer.request("PUT", `${prefix}/jobs/${upload.job.id}/upload`, corrupt.bytes,
    { "content-type": "application/zip", "content-length": String(corrupt.bytes.byteLength) }); expect(sent.status).toBe(200);
  const artifact = (await peer.rows(`SELECT f.state,f.result_file_id,f.result_location_id,p.verified_sha256,p.verified_byte_size,l.object_key
    FROM research_package_files f JOIN file_usable_publications p ON p.file_id=f.result_file_id
    JOIN file_location_publications l ON l.location_id=f.result_location_id WHERE f.job_id=? AND f.entry_kind='artifact'`, [upload.job.id]))[0]; ensure(artifact);
  expect(artifact).toMatchObject({ state: "published", verified_sha256: corrupt.measured.sha256, verified_byte_size: corrupt.bytes.byteLength });
  if (pair) {
    ensure(typeof artifact.object_key === "string"); const actual = await pair.readObject(artifact.object_key);
    expect(actual.byteSize).toBe(corrupt.bytes.byteLength); expect(new Uint8Array(actual.bytes)).toEqual(corrupt.bytes);
    expect(digest(new Uint8Array(actual.bytes))).toBe(corrupt.measured.sha256);
  }
  await emitValidation();
  const status = await peer.request("GET", `${prefix}/jobs/${upload.job.id}`); expect(status.status).toBe(200);
  const paused = checkedResearchJobStatus(status.value);
  expect(paused).toMatchObject({ id: upload.job.id, kind: "upload", state: "paused", phase: "validate", reason: "package_validation_or_storage_failed", result: null });
  const preview = await peer.request("GET", `${prefix}/jobs/${upload.job.id}/preview`);
  expect(preview.status).toBe(409); expect(preview.value).toEqual({ error: "Package validation has not completed" });
  const revision = (await peer.rows("SELECT MAX(policy_revision) revision FROM storage_role_policy_revisions"))[0]?.revision;
  ensure(typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1);
  const copyInput = { requestId: randomUUID(), uploadJobId: upload.job.id, anotherCopy: false, expectedRolePolicyRevision: revision };
  for (let replay = 0; replay < 2; replay++) {
    const copy = await peer.request("POST", prefix + "/imports", copyInput);
    expect(copy.status).toBe(409); expect(copy.value).toEqual({ error: "Archive validation has not completed" });
  }
  expect(await peer.rows("SELECT id FROM research_package_jobs WHERE kind='import'")).toEqual([]);
  expect(await peer.rows("SELECT job_id FROM research_package_identity_maps")).toEqual([]);
  expect(await peer.rows("SELECT job_id FROM research_package_records")).toEqual([]);
  expect(await peer.rows("SELECT job_id FROM research_package_files WHERE entry_kind='payload'")).toEqual([]);
  expect((await peer.rows("SELECT count(*) n FROM research_package_requests"))[0]?.n).toBe(1);
  expect((await peer.rows("SELECT count(*) n FROM file_usable_publications"))[0]?.n).toBe(publicationBefore + 1);
  const durable = (await peer.rows("SELECT actor,state,phase,reason,frozen_archive_json,domain_plan_json,result_json FROM research_package_jobs WHERE id=?", [upload.job.id]))[0];
  expect(durable).toEqual({ actor: peer.actor, state: "paused", phase: "validate", reason: "package_validation_or_storage_failed",
    frozen_archive_json: null, domain_plan_json: null, result_json: null });
  expect(await canonicalRows(peer)).toEqual(before); await released(peer);
  return { schema: "genuine-final-package-payload-corruption-refusal/1", provider: peer.provider, uploadJobId: upload.job.id,
    rawArchiveFileId: artifact.result_file_id, rawArchiveSha256: corrupt.measured.sha256, rawArchiveBytes: corrupt.bytes.byteLength,
    finalPayloadPath: corrupt.lastPath, finalLogicalFileId: corrupt.logicalFileId, finalPayloadBytes: corrupt.payloadByteSize,
    declaredPayloadSha256: corrupt.declaredPayloadSha256, actualPayloadSha256: corrupt.actualPayloadSha256,
    validCrcAndOuterSha256: corrupt.crcAndWholeArchiveVerified, originalMetadataUnchanged: corrupt.metadataUnchanged,
    otherFourteenPayloadsVerified: corrupt.otherPayloadsVerified === 14, finalPayloadMismatchOnly: true,
    originalPublicUploadAcceptedAndVerified: true, originalPublicValidationPaused: true, originalPublicPreviewAndImportDenied: true,
    publishedPayloadFiles: 0, importedIdentityRows: 0, importedRecordRows: 0, canonicalRowsUnchanged: true,
    retainedRawArchivePublicationDelta: 1, pausedOriginalArchiveRetained: true,
    failureBoundary: "full_archive_validation_before_preview_or_payload_copy", lateCopyOrGraphPublicationFaultQualified: false,
    scheduledCadenceQualified: false };
}
async function closeOwners(pair: GenuineR2Pair | undefined, node: Fixture | undefined, failure: unknown, failed: boolean) {
  const results = await Promise.allSettled([...(node ? [node.close()] : []), ...(pair ? [pair.close()] : [])]);
  const failures = results.flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []);
  if (failures.length) throw new AggregateError([...(failed ? [failure] : []), ...failures], "Original corrupt-payload qualification work or first close failed");
  if (failed) throw failure;
}
describe("genuine public final Package payload integrity refusal", () => {
  it("refuses a CRC-valid final corrupted payload through ordinary Node session and CSRF without publishing an imported graph", () => retainedCanonicalFileCase(async () => {
    await parentDirectory(); const node = await fixture({ administrator: true, enableLocalJobs: true, seedBusinessRows: false }), peer = nodePackagePeer(node);
    let failed = false, failure: unknown, proof: Record<string, unknown> | undefined;
    try {
      expect((await peer.request("POST", "/api/files/migrations/executor", { enabled: true })).status).toBe(200);
      const denied = await node.request("POST", prefix + "/uploads", { requestId: randomUUID(), byteSize: 1, sha256: "a".repeat(64) }, { "x-sfw-csrf": "invalid" });
      expect(denied.status).toBe(403); expect((await peer.rows("SELECT count(*) n FROM research_package_jobs"))[0]?.n).toBe(0);
      proof = await refuseCorruptArchive(peer, async () => { expect((await node.dispatchJobsOnce()).outcome).toBe("paused"); });
    } catch (error) { failed = true; failure = error; }
    await closeOwners(undefined, node, failure, failed); ensure(proof);
    await writeFile(join(node.root, "final-payload-corruption-receipt.json"), JSON.stringify({ ...proof, genuineNodeSessionCsrf: true,
      invalidCsrfDenied: true, originalFirstCloseAcknowledged: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }), 60_000);
  it("refuses a CRC-valid final corrupted payload through genuine R2 Access without publishing an imported graph", () => retainedCanonicalFileCase(async () => {
    const parent = await parentDirectory(); let pair: GenuineR2Pair | undefined, failed = false, failure: unknown, proof: Record<string, unknown> | undefined;
    try {
      pair = await prepareGenuineCurrentV26R2Pair(parent, { fileEvidenceOperator: true });
      const activation = await activateR2PackagePeer(pair);
      proof = await refuseCorruptArchive(activation.peer, pair.schedule, pair);
    } catch (error) { failed = true; failure = error; }
    await closeOwners(pair, undefined, failure, failed); ensure(pair && proof);
    const closedD1Consistency = pair.closedDatabaseConsistency();
    await writeFile(join(pair.root, "final-payload-corruption-receipt.json"), JSON.stringify({ ...proof, genuineR2Access: true,
      actualNativeR2ArchiveBytesVerified: true, closedD1Consistency, originalFirstCloseAcknowledged: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }), 60_000);
});

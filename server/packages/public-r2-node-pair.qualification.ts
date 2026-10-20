import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect } from "vitest";
import { fixture, it } from "../files/jobs/local-runtime.qualification-support";
import { retainedCanonicalFileCase } from "../collaboration/current-v28-canonical-comment-file.qualification-support";
import { prepareGenuineCurrentV26R2Pair, type GenuineR2Pair } from "../recovery/current-v26-r2-node-pair.qualification-support";
import { activateR2PackagePeer, exportPackage, importPackage, importedPackageFiles, nodePackagePeer, packageFixtureArchive, released } from "./public-r2-node-pair.qualification-support";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function ensure(value: unknown): asserts value { if (!value) throw new Error("Configure original public Package pair inputs"); }
async function parentDirectory() {
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? "";
  ensure(isAbsolute(parent) && resolve(parent) === parent && await realpath(parent) === parent); return parent;
}
async function persistReceipt(parent: string, name: string, receipt: Record<string, unknown>) {
  const directory = join(parent, `public-r2-node-package-${randomUUID()}`); await mkdir(directory, { mode: 0o700 });
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.info("Retained genuine public Package pair receipt:", path);
}
async function closeOwners(pair: GenuineR2Pair | undefined, node: Fixture | undefined, failure: unknown, failed: boolean) {
  const results = await Promise.allSettled([...(node ? [node.close()] : []), ...(pair ? [pair.close()] : [])]);
  const failures = results.flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []);
  if (failures.length) throw new AggregateError([...(failed ? [failure] : []), ...failures], "Original public Package pair work or first close failed");
  if (failed) throw failure;
}

describe("genuine current public R2 and Node nonempty Package pair", () => {
  it("imports a genuine native R2 exported15-File Package through ordinary Node session and CSRF HTTP", () => retainedCanonicalFileCase(async () => {
    const parent = await parentDirectory();
    let pair: GenuineR2Pair | undefined, node: Fixture | undefined, failed = false, failure: unknown, receipt: Record<string, unknown> | undefined;
    try {
      pair = await prepareGenuineCurrentV26R2Pair(parent, { fileEvidenceOperator: true });
      const activation = await activateR2PackagePeer(pair), source = activation.peer;
      const seed = await packageFixtureArchive();
      const seeded = await importPackage(source, seed.bytes, seed.value.package);
      const r2Files = await importedPackageFiles(source, seeded.job.id, seed.value.package, seed.value.payloads, pair);
      const exported = await exportPackage(source, seeded.job, seed.value.package, seed.value.payloads);
      // This exact artifact was produced and downloaded by the real R2 worker;
      // its manifest/record identities and original STORE bytes remain intact.
      await writeFile(join(pair.root, "actual-r2-native-package.zip"), exported.bytes, { flag: "wx", mode: 0o600 });
      node = await fixture({ administrator: true, enableLocalJobs: true, seedBusinessRows: false });
      const target = nodePackagePeer(node);
      expect((await target.rows("SELECT id FROM samples")).length).toBe(0);
      expect((await target.rows("SELECT id FROM projects")).length).toBe(0);
      expect((await target.request("POST", "/api/files/migrations/executor", { enabled: true })).status).toBe(200);
      const invalidCsrf = await node.request("POST", "/api/packages/uploads", { requestId: randomUUID(), byteSize: exported.bytes.byteLength, sha256: exported.sha256 }, { "x-sfw-csrf": "invalid" });
      expect(invalidCsrf.status).toBe(403); expect((await target.rows("SELECT count(*) n FROM research_package_jobs"))[0]?.n).toBe(0);
      const copied = await importPackage(target, exported.bytes, exported.package);
      const nodeFiles = await importedPackageFiles(target, copied.job.id, exported.package, exported.payloads);
      const nodeExport = await exportPackage(target, copied.job, exported.package, exported.payloads);
      await writeFile(join(node.root, "actual-node-roundtrip-package.zip"), nodeExport.bytes, { flag: "wx", mode: 0o600 });
      expect(nodeExport.package.sourceInstallationId).not.toBe(exported.package.sourceInstallationId);
      await released(source); await released(target);
      receipt = { schema: "genuine-current-public-r2-node-package-pair/1", direction: "r2_to_node", files: 15,
        sourceProvider: "r2", destinationProvider: "local", nativeSourceArchiveSha256: exported.sha256, copiedNativeArchiveSha256: nodeExport.sha256,
        sourcePackageId: exported.package.packageId, sourceInstallationId: exported.package.sourceInstallationId,
        targetInstallationId: nodeExport.package.sourceInstallationId, sourceRoots: exported.package.roots, targetRoots: copied.job.result!.roots,
        actualNativeR2BytesVerified: true, exactOriginalStorePayloadsVerified: true, originalArchiveImportedWithoutRetagging: true,
        genuineNodeSessionAndCsrf: true, invalidCsrfDenied: true, exactTypedGraphAndIdentityReceipts: true,
        activation: { ...activation, peer: undefined }, sourceFiles: r2Files, targetFiles: nodeFiles,
        sourceCaptures: exported.captures, targetCaptures: nodeExport.captures,
        sourceFixture: pair.root, destinationFixture: node.root, scheduledCadence120SecondsQualified: false };
    } catch (error) { failed = true; failure = error; }
    await closeOwners(pair, node, failure, failed); ensure(receipt);
    ensure(pair); const closedD1Consistency = pair.closedDatabaseConsistency();
    await persistReceipt(parent, "r2-to-node", { ...receipt, closedD1Consistency, originalFirstCloseAcknowledged: true });
  }), 60_000);
  it("imports a genuine native Node exported15-File Package through fresh R2 Access and public HTTP", () => retainedCanonicalFileCase(async () => {
    const parent = await parentDirectory();
    let pair: GenuineR2Pair | undefined, node: Fixture | undefined, failed = false, failure: unknown, receipt: Record<string, unknown> | undefined;
    try {
      node = await fixture({ administrator: true, enableLocalJobs: true, seedBusinessRows: false });
      const source = nodePackagePeer(node);
      expect((await source.rows("SELECT id FROM samples")).length).toBe(0);
      expect((await source.rows("SELECT id FROM projects")).length).toBe(0);
      expect((await source.request("POST", "/api/files/migrations/executor", { enabled: true })).status).toBe(200);
      const seed = await packageFixtureArchive();
      const invalidCsrf = await node.request("POST", "/api/packages/uploads", { requestId: randomUUID(), byteSize: seed.bytes.byteLength, sha256: seed.measured.sha256 }, { "x-sfw-csrf": "invalid" });
      expect(invalidCsrf.status).toBe(403); expect((await source.rows("SELECT count(*) n FROM research_package_jobs"))[0]?.n).toBe(0);
      const seeded = await importPackage(source, seed.bytes, seed.value.package);
      const nodeFiles = await importedPackageFiles(source, seeded.job.id, seed.value.package, seed.value.payloads);
      const exported = await exportPackage(source, seeded.job, seed.value.package, seed.value.payloads);
      await writeFile(join(node.root, "actual-node-native-package.zip"), exported.bytes, { flag: "wx", mode: 0o600 });
      pair = await prepareGenuineCurrentV26R2Pair(parent, { fileEvidenceOperator: true });
      const activation = await activateR2PackagePeer(pair), target = activation.peer;
      // Fresh R2 imports the original Node download, with its genuine native
      // source IDs and STORE bytes, through its ordinary Access-validated router.
      const copied = await importPackage(target, exported.bytes, exported.package);
      const r2Files = await importedPackageFiles(target, copied.job.id, exported.package, exported.payloads, pair);
      const r2Export = await exportPackage(target, copied.job, exported.package, exported.payloads);
      await writeFile(join(pair.root, "actual-r2-roundtrip-package.zip"), r2Export.bytes, { flag: "wx", mode: 0o600 });
      expect(r2Export.package.sourceInstallationId).not.toBe(exported.package.sourceInstallationId);
      await released(source); await released(target);
      receipt = { schema: "genuine-current-public-r2-node-package-pair/1", direction: "node_to_r2", files: 15,
        sourceProvider: "local", destinationProvider: "r2", nativeSourceArchiveSha256: exported.sha256, copiedNativeArchiveSha256: r2Export.sha256,
        sourcePackageId: exported.package.packageId, sourceInstallationId: exported.package.sourceInstallationId,
        targetInstallationId: r2Export.package.sourceInstallationId, sourceRoots: exported.package.roots, targetRoots: copied.job.result!.roots,
        actualNativeR2BytesVerified: true, exactOriginalStorePayloadsVerified: true, originalArchiveImportedWithoutRetagging: true,
        genuineNodeSessionAndCsrf: true, invalidCsrfDenied: true, exactTypedGraphAndIdentityReceipts: true,
        activation: { ...activation, peer: undefined }, sourceFiles: nodeFiles, targetFiles: r2Files,
        sourceCaptures: exported.captures, targetCaptures: r2Export.captures,
        sourceFixture: node.root, destinationFixture: pair.root, scheduledCadence120SecondsQualified: false };
    } catch (error) { failed = true; failure = error; }
    await closeOwners(pair, node, failure, failed); ensure(receipt);
    ensure(pair); const closedD1Consistency = pair.closedDatabaseConsistency();
    await persistReceipt(parent, "node-to-r2", { ...receipt, closedD1Consistency, originalFirstCloseAcknowledged: true });
  }), 60_000);

});

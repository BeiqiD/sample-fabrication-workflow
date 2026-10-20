import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { distributionFormat, distributionVersion, distributionNodeVersion, distributionCapabilityScope, distributionInstallationCheckpoint, distributionOfflineRecoveryCheckpoint,
  inventoryDistribution, parseDistributionManifest, verifyNodeDistribution } from "./lib/node-distribution-v28-manifest.mjs";

// These fixtures exercise package content integrity only. They deliberately
// contain no executable application, account, installation, or provider.
const fixtureFiles = ["client/index.html", "client/assets/app.js", "server/main.mjs", "server/identity-cli.cjs", "server/installation-cli.cjs", "server/restore-v28-cli.cjs",
  "tools/verify-node-distribution.mjs", "tools/lib/node-distribution-manifest.mjs", "tools/lib/node-distribution-v28-manifest.mjs", "tools/container-entrypoint.sh"];
const hash = value => createHash("sha256").update(value).digest("hex");
const encoded = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "node-distribution-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of fixtureFiles) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `integrity-fixture:${relative}\n`);
  }
  const sourceInputs = [
    { path: "package-lock.json", bytes: 12, sha256: hash("fixture-lock") },
    { path: "package.json", bytes: 15, sha256: hash("fixture-package") },
    ...["server/main.ts", "server/operations/identity-cli.ts", "server/operations/installation-cli.ts", "server/operations/restore-v28-cli.ts", "server/operations/restore-v28-operator.ts"]
      .map(relative => ({ path: relative, bytes: 1, sha256: hash(`fixture-source:${relative}`) })),
    { path: "server/installation-catalog-v26.ts", bytes: 1, sha256: distributionInstallationCheckpoint.catalogSourceSha256 },
    { path: "server/operational-installation-catalog.ts", bytes: 1, sha256: distributionInstallationCheckpoint.operationalSelectorSha256 },
    { path: "migrations/0024_rt3_local_volume_profiles.sql", bytes: 1, sha256: distributionInstallationCheckpoint.lastMigrationSourceSha256 },
    { path: "server/installation-catalog-v28-candidate.ts", bytes: 1, sha256: distributionOfflineRecoveryCheckpoint.catalogSourceSha256 },
    { path: "server/recovery/empty-target-v28-candidate.ts", bytes: 1, sha256: distributionOfflineRecoveryCheckpoint.emptyTargetSourceSha256 },
    { path: "server/recovery/restore-v28-candidate.ts", bytes: 1, sha256: distributionOfflineRecoveryCheckpoint.restorerSourceSha256 },
    { path: "shared/contracts/system-backup-v5-archive-admission.ts", bytes: 1, sha256: distributionOfflineRecoveryCheckpoint.archiveAdmissionSourceSha256 },
    { path: "shared/contracts/portable-runtime-v28-recovery-catalog.ts", bytes: 1, sha256: distributionOfflineRecoveryCheckpoint.recoveryCatalogSourceSha256 },
    { path: "worker/recovery/portable-runtime-v28-trusted-schema.ts", bytes: 1, sha256: distributionOfflineRecoveryCheckpoint.trustedSchemaSourceSha256 },
    { path: "scripts/lib/restore-system-backup-v28-candidate.ts", bytes: 1, sha256: distributionOfflineRecoveryCheckpoint.archiveRestorerSourceSha256 },
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const inputs = encoded({ version: 1, inputs: sourceInputs });
  await writeFile(path.join(root, "source-inputs.json"), inputs);
  const manifest = { format: distributionFormat, version: distributionVersion, nodeVersion: distributionNodeVersion,
    capabilityScope: distributionCapabilityScope, installationCheckpoint: distributionInstallationCheckpoint,
    offlineRecoveryCheckpoint: distributionOfflineRecoveryCheckpoint,
    packageLockSha256: hash("fixture-lock"), sourceInputsSha256: hash(inputs), files: await inventoryDistribution(root) };
  await writeFile(path.join(root, "manifest.json"), encoded(manifest));
  return { root, manifest };
}
async function rewrite(root, manifest) { await writeFile(path.join(root, "manifest.json"), encoded(manifest)); }
async function replaceSources(root, manifest, raw) {
  await writeFile(path.join(root, "source-inputs.json"), raw);
  manifest.sourceInputsSha256 = hash(raw);
  manifest.files = await inventoryDistribution(root);
  await rewrite(root, manifest);
}


test("supported fixed v3 artifact keeps V26 startup and separately declares inert V28/V5 restore", async t => {
  const { root } = await fixture(t), receipt = await verifyNodeDistribution(root);
  assert.equal(receipt.version, 3); assert.equal(receipt.files, 11); assert.equal(receipt.sourceInputs, 17);
  assert.deepEqual(receipt.installationCheckpoint, distributionInstallationCheckpoint);
  assert.deepEqual(receipt.offlineRecoveryCheckpoint, distributionOfflineRecoveryCheckpoint);
  assert.equal(receipt.capabilityScope, "restricted-development");
});
test("unknown archive/version/catalog and activation claims are rejected", async t => {
  const { manifest } = await fixture(t);
  for (const tuple of [
    { ...distributionOfflineRecoveryCheckpoint, archiveFormat: "v999" },
    { ...distributionOfflineRecoveryCheckpoint, id: "portable-runtime/v26" },
    { ...distributionOfflineRecoveryCheckpoint, migrationCount: 25 },
    { ...distributionOfflineRecoveryCheckpoint, executionEnabled: true },
    { ...distributionOfflineRecoveryCheckpoint, rawMigrationExecution: true },
    { ...distributionOfflineRecoveryCheckpoint, administratorGranted: true },
  ]) assert.throws(() => parseDistributionManifest(encoded({ ...manifest, offlineRecoveryCheckpoint: tuple })));
  assert.throws(() => parseDistributionManifest(encoded({ ...manifest, version: 2 })));
});
test("the fixed V28 executable is required even with a consistent reduced inventory", async t => {
  const { root, manifest } = await fixture(t);
  await unlink(path.join(root, "server/restore-v28-cli.cjs"));
  manifest.files = await inventoryDistribution(root); await rewrite(root, manifest);
  await assert.rejects(verifyNodeDistribution(root));
});
test("truncated executable bytes cannot inherit a retained manifest digest", async t => {
  const { root } = await fixture(t);
  const file = path.join(root, "server/restore-v28-cli.cjs"), bytes = await readFile(file);
  await writeFile(file, bytes.subarray(0, bytes.length - 1)); await assert.rejects(verifyNodeDistribution(root));
});
test("required CLI and fixed archive/catalog inputs cannot disappear from a self-consistent source receipt", async t => {
  const { root, manifest } = await fixture(t);
  const original = JSON.parse(await readFile(path.join(root, "source-inputs.json"), "utf8"));
  for (const relative of ["server/operations/restore-v28-cli.ts", "server/recovery/empty-target-v28-candidate.ts",
    "shared/contracts/system-backup-v5-archive-admission.ts"]) {
    const changed = structuredClone(original); changed.inputs = changed.inputs.filter(input => input.path !== relative);
    await replaceSources(root, manifest, encoded(changed)); await assert.rejects(verifyNodeDistribution(root));
  }
});
test("foreign code-owned restore/catalog digests are rejected despite consistent archive inventory hashes", async t => {
  const { root, manifest } = await fixture(t);
  const original = JSON.parse(await readFile(path.join(root, "source-inputs.json"), "utf8"));
  for (const relative of ["server/installation-catalog-v28-candidate.ts", "server/recovery/restore-v28-candidate.ts",
    "shared/contracts/portable-runtime-v28-recovery-catalog.ts"]) {
    const changed = structuredClone(original); changed.inputs.find(input => input.path === relative).sha256 = hash("foreign-source");
    await replaceSources(root, manifest, encoded(changed)); await assert.rejects(verifyNodeDistribution(root));
  }
});
test("symlink and hardlink aliases cannot impersonate the fixed restore executable", async t => {
  for (const alias of ["symlink", "hardlink"]) {
    const { root } = await fixture(t), destination = path.join(root, "server/restore-v28-cli.cjs");
    await unlink(destination);
    if (alias === "symlink") await symlink("main.mjs", destination);
    else await link(path.join(root, "server/main.mjs"), destination);
    await assert.rejects(verifyNodeDistribution(root));
  }
});
test("a self-consistent extra executable or private grant file does not widen the artifact allowlist", async t => {
  for (const relative of ["server/main-v28.mjs", "administrator-grants.json"]) {
    const { root } = await fixture(t);
    await writeFile(path.join(root, relative), "unreviewed-extra"); await assert.rejects(inventoryDistribution(root));
  }
});

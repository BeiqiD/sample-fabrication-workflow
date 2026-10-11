// Closed v3 packaging extension. Historical v2 parser remains byte-exact.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const distributionFormat = "sample-workflow-node-distribution";
export const distributionVersion = 3;
export const distributionNodeVersion = "24.19.0";
export const distributionCapabilityScope = "restricted-development";
/** Immutable code-owned schema input tuple, not runtime readiness or File grant. */
export const distributionInstallationCheckpoint = Object.freeze({
  id: "portable-runtime/v26", migrationCount: 24,
  catalogSourceSha256: "55688ec4bbfea94423bdc00ae58a5097ed277e4d3169be3ba070b4f09a537aff",
  operationalSelectorSha256: "eb07706e3145278645d1b2077da37e6c247ea605dcc9d8125b7341479ca87100",
  lastMigrationSourceSha256: "010414ba121247175e3bf6fe2eb88028ff8557035b123cfa12970c37e3985533",
});
/** Runtime V26 is unchanged. The additional executable restores only a
 * fixed V5 archive into a new inert V28 destination; it is not a startup grant. */
export const distributionOfflineRecoveryCheckpoint = Object.freeze({
  id: "portable-runtime/v28", migrationCount: 26, archiveFormat: "v5",
  constructionProvenance: "reviewed-final-schema", rawMigrationExecution: false, executionEnabled: false,
  nodeSchemaSha256: "6f09258e8e2a46799e149000a64ab2363696d689fbda68be8816f01d89de46cb",
  imageSchemaSha256: "604e3b04fefed5d3d8aa8281c4fd728cd73cd69dd40056d268ee1880ed558efd",
  catalogSourceSha256: "c56ca021886fa4036854fbb2f5b25e2638b2f8e75b9d8d782f1ebe7aa6103dd7",
  emptyTargetSourceSha256: "ceea8f9c104f75546c875b1df340fd32715e64a0a2094c2a51828e9aad102c54",
  restorerSourceSha256: "723693919899e96ace0168048bcc6ffa57a56cb4a93fd7368fa459e07b5cf517",
  archiveAdmissionSourceSha256: "c8cafb0a0eb740c6b057c5207a116e31fd3f914bab3bcf7d0e0eb3a0c9be2d81",
  recoveryCatalogSourceSha256: "b3e522c6ef10e0d9c999e76db7f3aacb8d6327d34376f6898e8058b5f5d3ca73",
  trustedSchemaSourceSha256: "1116030f9cf61e1e6d808a76cc2a83c4944aedb83cafb3df07086166f162f219",
  archiveRestorerSourceSha256: "5160e50da45733da132b8cbb8972a0c6462e526935481726d1bd949e960780ed",
});
const requiredSourceEntries = Object.freeze({
  "server/main.ts": undefined,
  "server/operations/restore-v28-cli.ts": undefined,
  "server/operations/restore-v28-operator.ts": undefined,
  "server/installation-catalog-v28-candidate.ts": distributionOfflineRecoveryCheckpoint.catalogSourceSha256,
  "server/recovery/empty-target-v28-candidate.ts": distributionOfflineRecoveryCheckpoint.emptyTargetSourceSha256,
  "server/recovery/restore-v28-candidate.ts": distributionOfflineRecoveryCheckpoint.restorerSourceSha256,
  "shared/contracts/system-backup-v5-archive-admission.ts": distributionOfflineRecoveryCheckpoint.archiveAdmissionSourceSha256,
  "shared/contracts/portable-runtime-v28-recovery-catalog.ts": distributionOfflineRecoveryCheckpoint.recoveryCatalogSourceSha256,
  "worker/recovery/portable-runtime-v28-trusted-schema.ts": distributionOfflineRecoveryCheckpoint.trustedSchemaSourceSha256,
  "scripts/lib/restore-system-backup-v28-candidate.ts": distributionOfflineRecoveryCheckpoint.archiveRestorerSourceSha256,
  "server/operations/identity-cli.ts": undefined,
  "server/operations/installation-cli.ts": undefined,
  "server/installation-catalog-v26.ts": distributionInstallationCheckpoint.catalogSourceSha256,
  "server/operational-installation-catalog.ts": distributionInstallationCheckpoint.operationalSelectorSha256,
  "migrations/0024_rt3_local_volume_profiles.sql": distributionInstallationCheckpoint.lastMigrationSourceSha256,
});
export const distributionLimits = Object.freeze({ files: 4096, bytes: 256 * 1024 * 1024,
  manifestBytes: 2 * 1024 * 1024, sourceInputs: 8192, sourceBytes: 512 * 1024 * 1024,
  sourceFileBytes: 16 * 1024 * 1024, depth: 16 });
const requiredFiles = ["client/index.html", "server/main.mjs", "server/identity-cli.cjs", "server/installation-cli.cjs", "server/restore-v28-cli.cjs", "source-inputs.json",
  "tools/verify-node-distribution.mjs", "tools/lib/node-distribution-manifest.mjs", "tools/lib/node-distribution-v28-manifest.mjs",
  "tools/container-entrypoint.sh"];

function fail() { throw new Error("Node distribution integrity check failed"); }
function keys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) fail();
}
export function distributionRelativePath(value) {
  if (typeof value !== "string" || value.length > 512 || !value || value.startsWith("/")
    || /[\\\x00-\x20\x7f]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")
    || value.split("/").length > distributionLimits.depth) fail();
  return value;
}
function allowedPayload(value) {
  return value.startsWith("client/") || requiredFiles.includes(value);
}
function digest(value) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function safeSize(value) { return Number.isSafeInteger(value) && value >= 0; }
function fileIdentity(stat) { return [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(":"); }
function canonicalJson(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > distributionLimits.manifestBytes) fail();
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { fail(); }
  if (raw.toString("utf8") !== `${JSON.stringify(value, null, 2)}\n`) fail();
  return value;
}

export function parseDistributionSourceInputs(raw, packageLockSha256) {
  const value = canonicalJson(raw);
  keys(value, ["version", "inputs"]);
  if (value.version !== 1 || !Array.isArray(value.inputs) || value.inputs.length < 2
    || value.inputs.length > distributionLimits.sourceInputs) fail();
  let previous = "", total = 0;
  for (const input of value.inputs) {
    keys(input, ["path", "bytes", "sha256"]);
    const relative = distributionRelativePath(input.path);
    if (relative <= previous || !safeSize(input.bytes) || input.bytes > distributionLimits.sourceFileBytes
      || !digest(input.sha256)) fail();
    total += input.bytes;
    if (!Number.isSafeInteger(total) || total > distributionLimits.sourceBytes) fail();
    previous = relative;
  }
  const lock = value.inputs.find(input => input.path === "package-lock.json");
  const packageJson = value.inputs.find(input => input.path === "package.json");
  if (!lock || !packageJson || lock.bytes === 0 || packageJson.bytes === 0
    || lock.sha256 !== packageLockSha256) fail();
  for (const [relative, expected] of Object.entries(requiredSourceEntries)) {
    const input = value.inputs.find(item => item.path === relative);
    if (!input || !input.bytes || expected !== undefined && input.sha256 !== expected) fail();
  }
  return value;
}

/** Content integrity under a trusted immutable image, not a signature or a
 * substitute for an independently retained source/image digest. */
export function parseDistributionManifest(raw) {
  // This closed canonical format also rejects duplicated JSON fields.
  const value = canonicalJson(raw);
  keys(value, ["format", "version", "nodeVersion", "capabilityScope", "installationCheckpoint", "offlineRecoveryCheckpoint", "packageLockSha256", "sourceInputsSha256", "files"]);
  if (value.format !== distributionFormat || value.version !== distributionVersion
    || value.nodeVersion !== distributionNodeVersion || value.capabilityScope !== distributionCapabilityScope
    || !digest(value.packageLockSha256)
    || !digest(value.sourceInputsSha256) || !Array.isArray(value.files)
    || value.files.length < requiredFiles.length || value.files.length > distributionLimits.files) fail();
  keys(value.installationCheckpoint, Object.keys(distributionInstallationCheckpoint));
  for (const [key, expected] of Object.entries(distributionInstallationCheckpoint)) {
    if (value.installationCheckpoint[key] !== expected) fail();
  }
  keys(value.offlineRecoveryCheckpoint, Object.keys(distributionOfflineRecoveryCheckpoint));
  for (const [key, expected] of Object.entries(distributionOfflineRecoveryCheckpoint)) {
    if (value.offlineRecoveryCheckpoint[key] !== expected) fail();
  }
  let previous = "", total = 0;
  for (const file of value.files) {
    keys(file, ["path", "bytes", "sha256"]);
    const relative = distributionRelativePath(file.path);
    if (!allowedPayload(relative) || relative <= previous || !safeSize(file.bytes) || !digest(file.sha256)) fail();
    total += file.bytes;
    if (!Number.isSafeInteger(total) || total > distributionLimits.bytes) fail();
    previous = relative;
  }
  for (const required of requiredFiles) if (!value.files.some(file => file.path === required && file.bytes > 0)) fail();
  return value;
}

async function readOwnedFile(filename, maximumBytes, includeRaw = false) {
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) fail();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (fileIdentity(before) !== fileIdentity(opened)) fail();
    const chunks = [], hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      bytes += chunk.length;
      if (bytes > maximumBytes) fail();
      hash.update(chunk); if (includeRaw) chunks.push(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (fileIdentity(opened) !== fileIdentity(after) || bytes !== Number(opened.size)) fail();
    return { raw: includeRaw ? Buffer.concat(chunks) : undefined, bytes, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

/** Build-time inventory and runtime verification share the same strict paths.
 * No symlinks, hard-linked files, undeclared extra files, or ignored state. */
export async function inventoryDistribution(root) {
  const absolute = path.resolve(root);
  if (await realpath(absolute) !== absolute) fail();
  const files = [];
  let total = 0;
  async function walk(relative, depth) {
    if (depth > distributionLimits.depth) fail();
    const directory = path.join(absolute, relative);
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) fail();
    for (const name of (await readdir(directory)).sort()) {
      const entry = relative ? `${relative}/${name}` : name;
      distributionRelativePath(entry);
      const stat = await lstat(path.join(absolute, entry), { bigint: true });
      if (stat.isDirectory()) {
        if (!(["client", "server", "tools", "tools/lib"].includes(entry) || entry.startsWith("client/"))) fail();
        await walk(entry, depth + 1);
      } else {
        if (entry === "manifest.json") continue;
        if (!allowedPayload(entry) || files.length >= distributionLimits.files) fail();
        const actual = await readOwnedFile(path.join(absolute, entry), distributionLimits.bytes - total);
        total += actual.bytes;
        files.push({ path: entry, bytes: actual.bytes, sha256: actual.sha256 });
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) fail();
  }
  await walk("", 0);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function verifyNodeDistribution(root, options = {}) {
  if (options.enforceRuntimeVersion && process.versions.node !== distributionNodeVersion) fail();
  const absolute = path.resolve(root);
  // Check the containing root before opening its manifest.
  if (await realpath(absolute) !== absolute || !(await lstat(absolute)).isDirectory()) fail();
  const manifestRead = await readOwnedFile(path.join(absolute, "manifest.json"), distributionLimits.manifestBytes, true);
  const manifest = parseDistributionManifest(manifestRead.raw);
  const actual = await inventoryDistribution(absolute);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) fail();
  if (actual.find(file => file.path === "source-inputs.json").sha256 !== manifest.sourceInputsSha256) fail();
  const sources = await readOwnedFile(path.join(absolute, "source-inputs.json"), distributionLimits.manifestBytes, true);
  if (sources.sha256 !== manifest.sourceInputsSha256) fail();
  const sourceInputs = parseDistributionSourceInputs(sources.raw, manifest.packageLockSha256);
  return Object.freeze({ format: manifest.format, version: manifest.version,
    nodeVersion: manifest.nodeVersion, capabilityScope: manifest.capabilityScope,
    installationCheckpoint: Object.freeze({ ...manifest.installationCheckpoint }),
    offlineRecoveryCheckpoint: Object.freeze({ ...manifest.offlineRecoveryCheckpoint }), files: actual.length,
    bytes: actual.reduce((sum, file) => sum + file.bytes, 0), sourceInputs: sourceInputs.inputs.length,
    manifestSha256: manifestRead.sha256 });
}

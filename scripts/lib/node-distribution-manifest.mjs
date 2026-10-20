import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const distributionFormat = "sample-workflow-node-distribution";
export const distributionVersion = 2;
export const distributionNodeVersion = "24.19.0";
export const distributionCapabilityScope = "restricted-development";
/** Immutable code-owned schema input tuple, not runtime readiness or File grant. */
export const distributionInstallationCheckpoint = Object.freeze({
  id: "portable-runtime/v26", migrationCount: 24,
  catalogSourceSha256: "55688ec4bbfea94423bdc00ae58a5097ed277e4d3169be3ba070b4f09a537aff",
  operationalSelectorSha256: "eb07706e3145278645d1b2077da37e6c247ea605dcc9d8125b7341479ca87100",
  lastMigrationSourceSha256: "010414ba121247175e3bf6fe2eb88028ff8557035b123cfa12970c37e3985533",
});
const requiredSourceEntries = Object.freeze({
  "server/main.ts": undefined,
  "server/operations/identity-cli.ts": undefined,
  "server/operations/installation-cli.ts": undefined,
  "server/installation-catalog-v26.ts": distributionInstallationCheckpoint.catalogSourceSha256,
  "server/operational-installation-catalog.ts": distributionInstallationCheckpoint.operationalSelectorSha256,
  "migrations/0024_rt3_local_volume_profiles.sql": distributionInstallationCheckpoint.lastMigrationSourceSha256,
});
export const distributionLimits = Object.freeze({ files: 4096, bytes: 256 * 1024 * 1024,
  manifestBytes: 2 * 1024 * 1024, sourceInputs: 8192, sourceBytes: 512 * 1024 * 1024,
  sourceFileBytes: 16 * 1024 * 1024, depth: 16 });
const requiredFiles = ["client/index.html", "server/main.mjs", "server/identity-cli.cjs", "server/installation-cli.cjs", "source-inputs.json",
  "tools/verify-node-distribution.mjs", "tools/lib/node-distribution-manifest.mjs",
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
  keys(value, ["format", "version", "nodeVersion", "capabilityScope", "installationCheckpoint", "packageLockSha256", "sourceInputsSha256", "files"]);
  if (value.format !== distributionFormat || value.version !== distributionVersion
    || value.nodeVersion !== distributionNodeVersion || value.capabilityScope !== distributionCapabilityScope
    || !digest(value.packageLockSha256)
    || !digest(value.sourceInputsSha256) || !Array.isArray(value.files)
    || value.files.length < requiredFiles.length || value.files.length > distributionLimits.files) fail();
  keys(value.installationCheckpoint, Object.keys(distributionInstallationCheckpoint));
  for (const [key, expected] of Object.entries(distributionInstallationCheckpoint)) {
    if (value.installationCheckpoint[key] !== expected) fail();
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
    installationCheckpoint: Object.freeze({ ...manifest.installationCheckpoint }), files: actual.length,
    bytes: actual.reduce((sum, file) => sum + file.bytes, 0), sourceInputs: sourceInputs.inputs.length,
    manifestSha256: manifestRead.sha256 });
}

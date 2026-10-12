import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { expect } from "vitest";
import { admitInstallationRecoverySource, inspect, nativeOwner, original, V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "./collaboration-sample-v28-logical-fixture.qualification";

// Qualification provenance only. These serialized facts never issue a runtime
// identity, membership, grant, installation admission or physical writer lease.
export type LogicalSampleSource = Readonly<{
  kind: "sample-v28-logical-producer/1";
  sourceHead: string;
  databasePath: string;
  databaseSha256: string;
  installationId: string;
  administrator: string;
  alice: string;
  bob: string;
  aliceMember: string;
  bobMember: string;
  checkpointId: "portable-runtime/v28";
  controlRevision: 2;
  enforcement: "enabled";
  normalOriginalCloseAcknowledged: true;
  completedStages: readonly string[];
}>;
export const LOGICAL_PRODUCER_STAGES = Object.freeze([
  "prepare-v26", "prepare-v27", "upgrade-v26", "upgrade-v27", "provision-members", "ordinary-account-proof", "enroll-enable-publish",
]);
const sameFile = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function boundedPrivateBytes(path: string, max: number): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Closed logical fixture path required");
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size > max)
    throw new Error("Private logical fixture file required");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = await handle.stat();
    if (!sameFile(before, first)) throw new Error("Logical fixture owner changed before read");
    const bytes = Buffer.alloc(first.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat(), finalPath = await lstat(path);
    if (offset !== first.size || !sameFile(first, after) || !sameFile(first, finalPath)) throw new Error("Logical fixture read is incomplete or changed");
    return bytes.subarray(0, first.size);
  } finally { await handle.close(); }
}
export const hashClosedLogicalDatabase = async (path: string) => createHash("sha256").update(await boundedPrivateBytes(path, 32 * 1024 * 1024)).digest("hex");
function manifestPath() {
  const path = process.env.SAMPLE_V28_LOGICAL_PRODUCER_MANIFEST;
  if (!path || !isAbsolute(path) || resolve(path) !== path) throw new Error("Explicit new logical producer manifest required");
  return path;
}
export async function writeLogicalSampleSource(value: LogicalSampleSource) {
  const path = manifestPath();
  const parent = dirname(path);
  // The runner supplies a freshly reserved private output parent; never replace
  // a historical output or create a new production installation.
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error("Private logical output parent required");
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); }
  finally { await handle.close(); }
}
export async function readLogicalSampleSource(): Promise<LogicalSampleSource> {
  const resultPath = process.env.SAMPLE_V28_LOGICAL_PRODUCER_RESULT;
  if (!resultPath) throw new Error("Actual completed logical producer result required");
  const actual = JSON.parse((await boundedPrivateBytes(resultPath, 4 * 1024 * 1024)).toString("utf8")) as Record<string, unknown>;
  const results = actual.testResults;
  if (actual.success !== true || actual.numTotalTests !== 7 || actual.numPassedTests !== 7 || actual.numFailedTests !== 0
    || !Array.isArray(results) || results.length !== 1 || !results[0] || typeof results[0] !== "object"
    || !Array.isArray((results[0] as Record<string, unknown>).assertionResults)
    || ((results[0] as Record<string, unknown>).assertionResults as Array<Record<string, unknown>>).length !== 7
    || ((results[0] as Record<string, unknown>).assertionResults as Array<Record<string, unknown>>).some(row => row.status !== "passed"))
    throw new Error("Producer did not complete every independent logical stage");
  const bytes = await boundedPrivateBytes(manifestPath(), 16384);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Closed logical manifest required");
  const row = value as Record<string, unknown>;
  const keys = ["kind", "sourceHead", "databasePath", "databaseSha256", "installationId", "administrator", "alice", "bob", "aliceMember", "bobMember", "checkpointId", "controlRevision", "enforcement", "normalOriginalCloseAcknowledged", "completedStages"].sort();
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(keys) || row.kind !== "sample-v28-logical-producer/1"
    || typeof row.sourceHead !== "string" || !/^[a-f0-9]{40}$/.test(row.sourceHead) || row.sourceHead !== process.env.SAMPLE_V28_LOGICAL_SOURCE_HEAD
    || typeof row.databaseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.databaseSha256)
    || typeof row.databasePath !== "string" || row.checkpointId !== "portable-runtime/v28" || row.controlRevision !== 2 || row.enforcement !== "enabled"
    || row.normalOriginalCloseAcknowledged !== true || JSON.stringify(row.completedStages) !== JSON.stringify(LOGICAL_PRODUCER_STAGES)
    || ["installationId", "administrator", "alice", "bob", "aliceMember", "bobMember"].some(key => typeof row[key] !== "string" || !row[key]))
    throw new Error("Incomplete or foreign logical producer provenance");
  const source = value as LogicalSampleSource;
  if (await hashClosedLogicalDatabase(source.databasePath) !== source.databaseSha256) throw new Error("Original closed producer database changed");
  return source;
}
export async function assertLogicalSampleMembers(path: string, source: LogicalSampleSource) {
  return inspect(path, native => {
    const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
    expect(admission.receipt.installationId).toBe(source.installationId);
    expect(admission.receipt.checkpointId).toBe(source.checkpointId);
    expect(native.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control").get()).toEqual({ schema_version: 2, enforcement: "enabled", revision: 2 });
    const members = native.prepare("SELECT i.subject,i.issuer,m.member_id,m.state,m.can_create_samples FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE i.provider='local' AND i.enabled=1 ORDER BY i.subject").all();
    for (const [principal, memberId, create] of [[source.alice, source.aliceMember, 1], [source.bob, source.bobMember, 0]] as const)
      expect(members).toContainEqual({ subject: principal, issuer: `node-installation:${source.installationId}`, member_id: memberId, state: "active", can_create_samples: create });
    expect(native.prepare("SELECT principal_id,enabled FROM local_accounts WHERE username='system.operator'").get()).toEqual({ principal_id: source.administrator, enabled: 1 });
    expect(native.prepare("SELECT principal_id,enabled FROM local_accounts WHERE username='alice'").get()).toEqual({ principal_id: source.alice, enabled: 1 });
    expect(native.prepare("SELECT principal_id,enabled FROM local_accounts WHERE username='bob'").get()).toEqual({ principal_id: source.bob, enabled: 1 });
    expect(native.prepare("SELECT count(*) n FROM local_sessions").get()?.n).toBe(0);
    expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    return { alice: source.aliceMember, bob: source.bobMember };
  });
}
export async function observedSourceInstallation(path: string) {
  return original(async () => {
    const owner = await nativeOwner(path);
    try { return await owner.lease.withWriter(() => admitInstallationRecoverySource(owner.native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE).receipt.installationId); }
    finally { await owner.close(); }
  });
}

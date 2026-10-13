import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { verifyNodeDistribution } from "../lib/node-distribution-v28-manifest.mjs";

const historicalHead = "9c7c916d9647ffac8efc163c2b7213b40617cb41";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dependencyIdentities = new Map<string, string>();
function requireFact(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("worker_v5_current_producer_" + reason);
}
function object(value: unknown): Record<string, unknown> {
  requireFact(value && typeof value === "object" && !Array.isArray(value), "object");
  return value as Record<string, unknown>;
}
async function privateBytes(path: string, maximum: number) {
  requireFact(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, "private_path");
  const before = await lstat(path);
  requireFact(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid?.()
    && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= maximum, "private_file");
  const bytes = await readFile(path), after = await lstat(path);
  requireFact([before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs].join(":")
    === [after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(":"), "private_file_changed");
  requireFact(bytes.byteLength === before.size, "private_size"); return bytes;
}
function committedSource(root: string, head: string, tree: string) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
  requireFact(git("rev-parse", "--show-toplevel") === root && git("rev-parse", "HEAD") === head
    && git("rev-parse", "HEAD^{tree}") === tree, "actual_committed_source");
  git("diff", "--quiet", "HEAD", "--");
}
async function currentDistribution(root: string, directory: string, manifestSha256: unknown, sourceInputsSha256: unknown) {
  requireFact(isAbsolute(directory) && resolve(directory) === directory && await realpath(directory) === directory, "distribution_path");
  const admitted = await verifyNodeDistribution(directory, { enforceRuntimeVersion: true });
  requireFact(admitted.manifestSha256 === manifestSha256 && admitted.version === 3
    && admitted.offlineRecoveryCheckpoint.id === "portable-runtime/v28", "distribution_manifest");
  const raw = await readFile(join(directory, "source-inputs.json")); requireFact(digest(raw) === sourceInputsSha256, "distribution_inputs");
  const inputs = object(JSON.parse(raw.toString("utf8"))).inputs;
  requireFact(Array.isArray(inputs), "source_inventory");
  const logical = join(root, "node_modules"), logicalStat = await lstat(logical), actual = await realpath(logical), actualStat = await lstat(actual);
  requireFact((logicalStat.isDirectory() || logicalStat.isSymbolicLink()) && actualStat.isDirectory()
    && !actualStat.isSymbolicLink() && await realpath(actual) === actual, "sdk_root");
  const identity = [logical,actual,logicalStat.dev,logicalStat.ino,actualStat.dev,actualStat.ino,actualStat.uid,actualStat.mode].join(":");
  const retained = dependencyIdentities.get(root); requireFact(retained === undefined || retained === identity, "sdk_root_changed");
  dependencyIdentities.set(root, identity);
  for (const item of inputs) {
    const input = object(item); requireFact(typeof input.path === "string" && typeof input.bytes === "number"
      && typeof input.sha256 === "string", "source_tuple");
    const path = join(root, input.path), before = await lstat(path);
    const expected = input.path.startsWith("node_modules/") ? join(actual, input.path.slice("node_modules/".length)) : path;
    requireFact(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
      && await realpath(path) === expected && before.size === input.bytes, "source_file");
    requireFact(digest(await readFile(path)) === input.sha256, "source_hash");
    const after = await lstat(path); requireFact([before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs].join(":")
      === [after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(":"), "source_changed");
  }
  const logicalAfter = await lstat(logical), actualAfter = await lstat(actual);
  requireFact([logical,await realpath(logical),logicalAfter.dev,logicalAfter.ino,actualAfter.dev,actualAfter.ino,actualAfter.uid,actualAfter.mode].join(":")
    === identity, "sdk_root_changed");
}

/** Historical inputs retain their original producer head. Current mode is
 * admitted only through the closed original same-commit producer receipt,
 * actual local Git identity and complete freshly verified distribution inputs. */
export async function assertWorkerV5OriginalProducerInput(rootInput: string, prefix: string,
  kind: "ZERO" | "NONEMPTY" | "BOUND", receipt: Record<string, unknown>, archive: string, archiveSha256: string,
  retainedHistoricalHead = historicalHead): Promise<() => Promise<void>> {
  const currentHead = process.env.WORKER_V5_CURRENT_PRODUCER_HEAD;
  if (currentHead === undefined) {
    requireFact(receipt.head === retainedHistoricalHead, "historical_head"); return async () => {};
  }
  const root = resolve(rootInput), currentTree = process.env.WORKER_V5_CURRENT_PRODUCER_TREE;
  requireFact(/^[a-f0-9]{40}$/.test(currentHead) && typeof currentTree === "string" && /^[a-f0-9]{40}$/.test(currentTree), "current_identity");
  requireFact(await realpath(root) === root && receipt.head === currentHead && receipt.tree === currentTree
    && receipt.kind === "current-v28-post-restore-original-owned-stage/1"
    && receipt.stage === ({ ZERO: "worker-v5-zero", NONEMPTY: "worker-v5-nonempty", BOUND: "worker-v5-bound-producer" }[kind])
    && receipt.status === "PASS" && receipt.exitCode === 0 && receipt.originalChildWaited === true
    && receipt.ownedClosureProven === true && receipt.noFixtureRemoval === true
    && receipt.outerExpired !== true && receipt.firstFailure === undefined && receipt.originalCloseError === undefined
    && receipt.floorOrPrivateIdentityFailure === undefined, "closed_original_producer");
  const results = object(receipt.actualResults);
  const expectedTitle = ({
    ZERO: "captures all actual typed data before any business POST and restores through the current fixed CLI into a fresh inert destination",
    NONEMPTY: "preserves one real ordinary HTTP upload through stopped upgrade, compiled complete capture and compiled inert restore without destination File authority",
    BOUND: "captures one real bound LOCAL attachment without creating a legacy shadow head or changing its typed canonical consumer",
  }[kind]);
  requireFact(results.actualTotal === 1 && results.actualPassed === 1 && results.actualFailed === 0
    && results.actualPending === 0 && results.reporterSuccess === true && results.exactOriginalSelection === true
    && results.pass === true && Array.isArray(results.titles) && results.titles.length === 1
    && results.titles[0] === expectedTitle, "original_selection");
  const expectedSource = ({ ZERO: "server/operations/current-v28-post-restore-source-preparation.qualification.ts",
    NONEMPTY: "server/operations/current-v28-nonempty-backup-restore.qualification.ts",
    BOUND: "server/operations/current-v28-bound-comment-backup.qualification.ts" }[kind]);
  requireFact(digest(await readFile(join(root, expectedSource))) === receipt.qualificationSourceSha256, "original_case_source");
  const snapshot = receipt.finalGroupSnapshot;
  requireFact(Array.isArray(snapshot) && snapshot.every(row => object(row).activeOrOwnershipUnproven === false), "original_owners");
  const producer = object(receipt.currentProducer), path = process.env[prefix + "_PRODUCER_INPUTS"];
  requireFact(typeof path === "string" && path === producer.inputsPath && producer.archive === archive
    && producer.archiveSha256 === archiveSha256 && typeof producer.distribution === "string"
    && producer.sourceFileCount === (kind === "ZERO" ? 0 : 1) && producer.nativeBoundHeadZero === (kind === "BOUND"), "producer_input_binding");
  const distribution = producer.distribution;
  const recheck = async () => {
    committedSource(root, currentHead, currentTree);
    const raw = await privateBytes(path, 1024 * 1024), proof = object(JSON.parse(raw.toString("utf8")));
    requireFact(digest(raw) === producer.inputsSha256 && raw.byteLength === producer.inputsBytes
      && proof.archive === archive && proof.archiveSha256 === archiveSha256, "original_private_proof");
    const archiveBytes = await privateBytes(archive, 8 * 1024 * 1024);
    requireFact(digest(archiveBytes) === archiveSha256 && archiveBytes.byteLength === producer.archiveBytes, "original_archive");
    await currentDistribution(root, distribution, producer.distributionManifestSha256, producer.distributionSourceInputsSha256);
    committedSource(root, currentHead, currentTree);
  };
  await recheck(); return recheck;
}

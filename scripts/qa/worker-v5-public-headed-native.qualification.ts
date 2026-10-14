import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWorkerV5PresentHeadProducerInput } from "./worker-v5-present-head-producer-input";
import { assertWorkerV5OriginalProducerInput } from "./worker-v5-original-producer-input";
import { runGenuineAccessPublicV5Original } from "./worker-v5-public-native.qualification-support";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error("worker_v5_public_headed_input_" + reason); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "object"); return value as Record<string, unknown>;
}
async function run(kind: "RUN_STEP" | "COMMENT") {
  const prefix = kind === "RUN_STEP" ? "WORKER_V5_NATIVE_PRESENT_HEAD_BOUND" : "WORKER_V5_NATIVE_BOUND";
  const archive = process.env[prefix + "_ARCHIVE"], expectedSha256 = process.env[prefix + "_SHA256"];
  const receiptPath = process.env[prefix + "_PRODUCER_RECEIPT"], inputsPath = process.env[prefix + "_PRODUCER_INPUTS"];
  const producerHead = process.env[prefix + "_PRODUCER_HEAD"], currentHead = process.env.WORKER_V5_CURRENT_PRODUCER_HEAD;
  ensure(archive && receiptPath && inputsPath && expectedSha256 && /^[a-f0-9]{64}$/.test(expectedSha256)
    && producerHead && /^[a-f0-9]{40}$/.test(producerHead) && producerHead === currentHead, "same_current_original_input");
  for (const path of [archive, receiptPath, inputsPath]) {
    ensure(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, "canonical_original_path");
    const stat = await lstat(path); ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size > 0, "original_private_file");
  }
  const bytes = await readFile(archive), receiptBytes = await readFile(receiptPath), proofBytes = await readFile(inputsPath);
  ensure(bytes.byteLength <= 8 * 1024 * 1024 && proofBytes.byteLength <= 1024 * 1024, "original_input_budget");
  expect(hash(bytes)).toBe(expectedSha256);
  const receipt = object(JSON.parse(receiptBytes.toString("utf8"))), proof = object(JSON.parse(proofBytes.toString("utf8")));
  const recheckProducer = kind === "RUN_STEP"
    ? await assertWorkerV5PresentHeadProducerInput(SOURCE_ROOT, prefix, receipt, archive, expectedSha256, producerHead)
    : await assertWorkerV5OriginalProducerInput(SOURCE_ROOT, prefix, "BOUND", receipt, archive, expectedSha256, producerHead);
  expect(receipt.status).toBe("PASS"); expect(receipt.originalChildWaited).toBe(true); expect(receipt.ownedClosureProven).toBe(true);
  expect(proof.presentHeads).toBe(1); ensure(typeof proof.sourceInstallationId === "string", "original_native_installation");
  if (kind === "COMMENT") expect(proof).toMatchObject({ schema: "current-genuine-bound-node-comment-v5-producer/1",
    genuineOriginalCommentProducer: true, naturallyIssuedCommentHead: true, immutableSourceShadowChainExact: true,
    currentVerifiedCompiledStoppedCapture: true, noBusinessSqlSeed: true, sourceUnchanged: true,
    oldTypedRowsAndRowidsUnchanged: true, noManufacturedLegacyHeads: true, originalCloseAcknowledged: true });
  await runGenuineAccessPublicV5Original({ archive, expectedSha256, receiptPath, receiptHash: hash(receiptBytes), bytes, recheckProducer }, 1,
    { inputProducerHead: producerHead, headed: kind === "RUN_STEP" ? "run_step_asset" : "comment_submission_item",
      nativeSourceInstallationId: proof.sourceInstallationId });
  expect(hash(await readFile(inputsPath))).toBe(hash(proofBytes)); await recheckProducer();
}
it("restores the qualified genuine Run Step headed V5 through Access public jobs and exact inert R2 history, then held public backup into fresh current Node",
  () => run("RUN_STEP"), 180_000);
it("restores the qualified natural Comment headed V5 through Access public jobs and exact inert R2 history, then held public backup into fresh current Node",
  () => run("COMMENT"), 180_000);

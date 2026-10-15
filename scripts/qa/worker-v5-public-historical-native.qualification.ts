import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWorkerV5OriginalProducerInput } from "./worker-v5-original-producer-input";
import { runGenuineAccessPublicV5Original } from "./worker-v5-public-native.qualification-support";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PINNED_PRODUCER_HEAD = "62ac1d54dcfd2bff6381f2bbfbe4276df1bf3ddc";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const titles = [
  "restores the original zero-File V5 archive through genuine Access public FP5 upload, jobs and inert report",
  "restores the original nonempty V5 through genuine Access public FP5 and recaptures held native R2 through a real backup job into fresh current Node",
] as const;
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error("worker_v5_public_" + reason); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "object"); return value as Record<string, unknown>;
}
it(titles[0],async()=>runGenuineAccessPublicV5Original(await retainedInput("ZERO"),0),120_000);
it(titles[1],async()=>runGenuineAccessPublicV5Original(await retainedInput("NONEMPTY"),1),120_000);

async function retainedInput(kind: "ZERO" | "NONEMPTY") {
  const prefix = "WORKER_V5_" + kind;
  const archive = process.env[prefix + "_ARCHIVE"], expectedSha256 = process.env[prefix + "_SHA256"];
  const receiptPath = process.env[prefix + "_PRODUCER_RECEIPT"];
  ensure(archive && receiptPath && expectedSha256 && /^[a-f0-9]{64}$/.test(expectedSha256), "original_input_missing");
  for (const path of [archive, receiptPath]) ensure(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, "original_input_path");
  const stat = await lstat(archive); ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.size > 0 && stat.size <= 8 * 1024 * 1024, "original_archive_file");
  const bytes = await readFile(archive), receiptBytes = await readFile(receiptPath);
  expect(hash(bytes)).toBe(expectedSha256);
  const receipt = object(JSON.parse(receiptBytes.toString("utf8"))), results = object(receipt.actualResults);
  const recheckProducer = await assertWorkerV5OriginalProducerInput(SOURCE_ROOT, prefix, kind, receipt, archive, expectedSha256, PINNED_PRODUCER_HEAD);
  expect(receipt.status).toBe("PASS");
  expect(receipt.ownedClosureProven).toBe(true); expect(receipt.originalChildWaited).toBe(true);
  expect(results.actualTotal).toBe(1); expect(results.actualPassed).toBe(1); expect(results.actualFailed).toBe(0);
  expect(results.actualPending).toBe(0); expect(results.exactOriginalSelection).toBe(true);
  return { archive, expectedSha256, receiptPath, receiptHash: hash(receiptBytes), bytes, recheckProducer };
}

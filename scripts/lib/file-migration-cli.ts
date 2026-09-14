import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { validateFullExportV10, validateFullExportV11 } from "../../shared/contracts/export-protocol";
import { stableJson } from "../../shared/domain/content-addressing";
import { MAX_FILE_MIGRATION_INPUT_BYTES, MAX_FILE_MIGRATION_INPUT_ROWS,
  MAX_FILE_MIGRATION_PLAN_BYTES, planFileMigration } from "../../shared/contracts/file-migration-plan";

const READ_CHUNK_BYTES = 256 * 1024;

/** Reads one bounded metadata snapshot. A changing input cannot silently become
 * the baseline for a later conversion proposal. This tool never opens a DB,
 * storage adapter, network transport, or archive byte member. */
async function readSnapshot(path: string) {
  // A FIFO must reach the regular-file check without waiting for a writer.
  const input = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Snapshot input must be a regular JSON file");
    if (before.size > BigInt(MAX_FILE_MIGRATION_INPUT_BYTES)) throw new Error("Snapshot exceeds the file migration input byte limit");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, MAX_FILE_MIGRATION_INPUT_BYTES + 1 - total));
      const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE_MIGRATION_INPUT_BYTES) throw new Error("Snapshot exceeds the file migration input byte limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await input.stat({ bigint: true });
    if (before.size !== BigInt(total) || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Snapshot changed while being read; save a fixed snapshot and retry");
    }
    return Buffer.concat(chunks, total);
  } finally { await input.close(); }
}

function parseSnapshot(bytes: Buffer): unknown {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Snapshot must contain valid UTF-8 JSON"); }
  // Enforce the row cap before the complete archive validator walks every cell.
  const tables = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { tables?: unknown }).tables : undefined;
  if (tables && typeof tables === "object" && !Array.isArray(tables)) {
    let count = 0;
    for (const rows of Object.values(tables)) {
      if (Array.isArray(rows)) count += rows.length;
      if (count > MAX_FILE_MIGRATION_INPUT_ROWS) throw new Error("Snapshot exceeds the file migration input row limit");
    }
  }
  return value;
}

/** Exclusive atomic publication: a failure cannot replace a previous report or
 * leave a partial report at the requested output path. */
async function publishNewReport(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Output already exists; choose a new report path");
      throw error;
    }
  } finally { await rm(temporary, { force: true }); }
}

export async function planFileMigrationSnapshot(input: { snapshotPath: string; outputPath: string }) {
  const snapshotPath = resolve(input.snapshotPath), outputPath = resolve(input.outputPath);
  if (snapshotPath === outputPath) throw new Error("Snapshot input and report output must be different paths");
  const bytes = await readSnapshot(snapshotPath);
  const parsed = parseSnapshot(bytes);
  let manifest;
  try {
    manifest = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && (parsed as { schemaVersion?: unknown }).schemaVersion === 11
      ? await validateFullExportV11(parsed) : await validateFullExportV10(parsed);
  } catch { throw new Error("Snapshot does not satisfy the complete schema-10 or schema-11 export contract"); }
  const plan = await planFileMigration(manifest);
  const encoded = `${stableJson(plan)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_FILE_MIGRATION_PLAN_BYTES) throw new Error("Report exceeds the file migration output byte limit");
  await publishNewReport(outputPath, encoded);
  return {
    outputPath,
    snapshotSha256: createHash("sha256").update(bytes).digest("hex"),
    reportSha256: createHash("sha256").update(encoded).digest("hex"),
    executable: false as const,
    bytesVerified: false as const,
    summary: plan.summary,
  };
}

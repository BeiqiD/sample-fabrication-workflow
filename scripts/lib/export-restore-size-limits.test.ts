import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { restoreExportToIsolatedDirectory } from "./export-restore";

const directories: string[] = [];
const MiB = 1024 * 1024;
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function declaredMembers(sizes: number[]) {
  const zip = new JSZip();
  // The intentionally unsupported envelope stops after central-directory
  // admission, without allocating the declared provider payloads.
  zip.file("export-manifest.json", "{}");
  zip.file("export-warnings.json", "[]");
  for (let index = 0; index < sizes.length; index++) zip.file(`original-${index}.bin`, "");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const end = bytes.length - 22;
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    const length = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString("utf8");
    const original = /^original-(\d+)\.bin$/.exec(name);
    if (original) bytes.writeUInt32LE(sizes[Number(original[1])], offset + 24);
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  const directory = await mkdtemp(join(tmpdir(), "restore-limits-")); directories.push(directory);
  const archivePath = join(directory, "archive.zip"); await writeFile(archivePath, bytes);
  return { archivePath, destination: join(directory, "restored"), migrationsDirectory: fileURLToPath(new URL("../../migrations/", import.meta.url)), targetCompatibilitySchema: "S2" as const };
}

it.each([100 * MiB, 128 * MiB])("admits a %i-byte original member to the envelope validator", async size => {
  await expect(restoreExportToIsolatedDirectory(await declaredMembers([size]))).rejects.toThrow("Unsupported complete-export manifest");
});
it("rejects a member above 128 MiB and expanded archives above 256 MiB before decompression", async () => {
  for (const sizes of [[128 * MiB + 1], [128 * MiB, 128 * MiB]]) {
    await expect(restoreExportToIsolatedDirectory(await declaredMembers(sizes))).rejects.toThrow("Archive exceeds isolated restore size limits");
  }
});
it("rejects compressed input above 256 MiB before reading it into memory", async () => {
  const options = await declaredMembers([]); await truncate(options.archivePath, 256 * MiB + 1);
  await expect(restoreExportToIsolatedDirectory(options)).rejects.toThrow("Archive exceeds isolated restore size limits");
});

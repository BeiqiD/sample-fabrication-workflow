import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../../worker/reference-test-support";
import { snapshotFullExportV10 } from "../../worker/export-v10-snapshot";
import { MAX_FILE_MIGRATION_INPUT_BYTES } from "../../shared/contracts/file-migration-plan";
import { planFileMigrationSnapshot } from "./file-migration-cli";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "file-plan-cli-test-"));
  temporaryDirectories.push(directory);
  const database = referenceTestDatabase();
  try {
    database.exec(`INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('plan-sample', 'PLAN-CLI', 'Private sample title', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
      INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES ('plan-event', 'plan-sample', 'image', 'PRIVATE_BODY_SENTINEL', 'unregistered/image',
        '{"privateCredential":"PRIVATE_SECRET_SENTINEL"}', '2026-09-13T00:00:00.000Z');`);
    const snapshot = await snapshotFullExportV10(new SqliteD1Database(database) as unknown as D1Database);
    const inputPath = join(directory, "snapshot.json"), outputPath = join(directory, "plan.json");
    const encoded = JSON.stringify(snapshot);
    await writeFile(inputPath, encoded);
    return { directory, inputPath, outputPath, snapshot, encoded };
  } finally { database.close(); }
}

describe("offline File migration planning boundary", () => {
  it("writes a deterministic non-executable report from validated snapshot metadata without changing its input", async () => {
    const f = await fixture();
    const result = await planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: f.outputPath });
    const output = await readFile(f.outputPath, "utf8");
    expect(result).toMatchObject({ executable: false, bytesVerified: false, outputPath: f.outputPath,
      snapshotSha256: createHash("sha256").update(f.encoded).digest("hex"),
      reportSha256: createHash("sha256").update(output).digest("hex") });
    expect(JSON.parse(output)).toMatchObject({ executable: false, bytesVerified: false });
    expect(output).toContain("unregistered/image");
    expect(output).not.toContain("PRIVATE_BODY_SENTINEL");
    expect(output).not.toContain("PRIVATE_SECRET_SENTINEL");
    expect(await readFile(f.inputPath, "utf8")).toBe(f.encoded);
    const secondPath = join(f.directory, "second.json");
    await planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: secondPath });
    expect(await readFile(secondPath, "utf8")).toBe(output);
    expect((await readdir(f.directory)).sort()).toEqual(["plan.json", "second.json", "snapshot.json"]);
    expect((await stat(f.outputPath)).mode & 0o777).toBe(0o600);
  });

  it("never overwrites a previous report or its input, including two writers racing for one path", async () => {
    const f = await fixture();
    await expect(planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: f.inputPath })).rejects.toThrow("different paths");
    const results = await Promise.allSettled([0, 1].map(() => planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: f.outputPath })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const output = await readFile(f.outputPath, "utf8");
    await expect(planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: f.outputPath })).rejects.toThrow("already exists");
    expect(await readFile(f.outputPath, "utf8")).toBe(output);
    expect(await readFile(f.inputPath, "utf8")).toBe(f.encoded);
    expect((await readdir(f.directory)).sort()).toEqual(["plan.json", "snapshot.json"]);
  });

  it("rejects malformed UTF-8/JSON and wrong or tampered snapshot contracts without publishing a report", async () => {
    const f = await fixture();
    for (const input of [Buffer.from([0xff, 0xfe]), Buffer.from('{"private":"DO_NOT_PRINT_ME",'),
      Buffer.from(JSON.stringify({ ...f.snapshot, schemaVersion: 9 })),
      Buffer.from(JSON.stringify({ ...f.snapshot, tables: { ...f.snapshot.tables, assets: [] },
        artifacts: { ...f.snapshot.artifacts, sourceSchema: { ...f.snapshot.artifacts.sourceSchema, sha256: "0".repeat(64) } } }))]) {
      await writeFile(f.inputPath, input);
      await expect(planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: f.outputPath })).rejects.toThrow(/Snapshot (must contain|does not satisfy)/);
      await expect(stat(f.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readdir(f.directory)).toEqual(["snapshot.json"]);
  });

  it("rejects oversized inputs and directories before parsing or creating an output", async () => {
    const f = await fixture();
    await truncate(f.inputPath, MAX_FILE_MIGRATION_INPUT_BYTES + 1);
    await expect(planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: f.outputPath })).rejects.toThrow("input byte limit");
    await expect(planFileMigrationSnapshot({ snapshotPath: f.directory, outputPath: f.outputPath })).rejects.toThrow("regular JSON file");
    const fifoPath = join(f.directory, "snapshot.fifo");
    execFileSync("mkfifo", [fifoPath]);
    await expect(planFileMigrationSnapshot({ snapshotPath: fifoPath, outputPath: f.outputPath })).rejects.toThrow("regular JSON file");
    await expect(stat(f.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../../worker/reference-test-support";
import { snapshotFullExportV10 } from "../../worker/export-v10-snapshot";
import { snapshotFullExportV11 } from "../../worker/export-v11-snapshot";
import { canonicalR2UploadInput } from "../../shared/contracts/r2-upload";
import { MAX_FILE_MIGRATION_INPUT_BYTES } from "../../shared/contracts/file-migration-plan";
import { planFileMigrationSnapshot } from "./file-migration-cli";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
});

function historicalV10Database() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => /^000[123]_.*\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  return database;
}

async function fixture(version: 10 | 11 = 11) {
  const directory = await mkdtemp(join(tmpdir(), "file-plan-cli-test-"));
  temporaryDirectories.push(directory);
  const database = version === 11 ? referenceTestDatabase() : historicalV10Database();
  try {
    database.exec(`INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('plan-sample', 'PLAN-CLI', 'Private sample title', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z');
      INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES ('plan-event', 'plan-sample', 'image', 'PRIVATE_BODY_SENTINEL', 'unregistered/image',
        '{"privateCredential":"PRIVATE_SECRET_SENTINEL"}', '2026-09-13T00:00:00.000Z');`);
    if (version === 11) {
      const input = await canonicalR2UploadInput("ordinary_image", {
        originalName: "PRIVATE_UPLOAD_FILENAME", mimeType: "image/png", byteSize: 5, sha256: "a".repeat(64),
      });
      database.prepare(`INSERT INTO storage_profiles
        (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at)
        VALUES ('upload-profile', 'r2', ?, 'bootstrap', NULL, 1, 'historical', '2026-09-13T00:00:00.000Z')`).run(
        '{"kind":"local-r2","installationId":"11111111-1111-4111-8111-111111111111","bucketName":"assets"}');
      database.prepare(`INSERT INTO r2_upload_requests (id, actor_email, client_request_id, operation_id,
        ingress, purpose, request_sha256, request_input_json, request_scope, storage_profile_id,
        storage_profile_revision, storage_policy_revision, candidate_asset_id, candidate_object_key,
        status, accepted_result_json, created_at, completed_at, expires_at)
        VALUES ('11111111-1111-4111-8111-111111111112', 'PRIVATE_UPLOAD_ACTOR',
          '11111111-1111-4111-8111-111111111113', '11111111-1111-4111-8111-111111111114',
          'ordinary_image', 'embedded_content', ?, ?, 'system', 'upload-profile', 1, 1,
          '11111111-1111-4111-8111-111111111115', 'upload/candidate', 'pending', NULL,
          '2026-09-13T00:00:00.000Z', NULL, '2026-09-14T00:00:00.000Z')`).run(input.sha256, input.json);
    }
    const adapter = new SqliteD1Database(database) as unknown as D1Database;
    const snapshot = version === 11 ? await snapshotFullExportV11(adapter) : await snapshotFullExportV10(adapter);
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
    expect(JSON.parse(output)).toMatchObject({ executable: false, bytesVerified: false,
      source: { schemaVersion: 11, archiveProfile: "fp1-r2-upload-acceptance" } });
    expect(output).toContain("unregistered/image");
    expect(output).not.toContain("PRIVATE_BODY_SENTINEL");
    expect(output).not.toContain("PRIVATE_SECRET_SENTINEL");
    expect(output).not.toContain("PRIVATE_UPLOAD_");
    expect(output).toContain("accepted_upload");
    expect(output).toContain("upload/candidate");
    expect(await readFile(f.inputPath, "utf8")).toBe(f.encoded);
    const secondPath = join(f.directory, "second.json");
    await planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: secondPath });
    expect(await readFile(secondPath, "utf8")).toBe(output);
    expect((await readdir(f.directory)).sort()).toEqual(["plan.json", "second.json", "snapshot.json"]);
    expect((await stat(f.outputPath)).mode & 0o777).toBe(0o600);
  });

  it("continues to plan a complete historical V10 snapshot using the frozen contract", async () => {
    const f = await fixture(10);
    expect(f.snapshot.tables).not.toHaveProperty("r2_upload_requests");
    await planFileMigrationSnapshot({ snapshotPath: f.inputPath, outputPath: f.outputPath });
    const output = await readFile(f.outputPath, "utf8");
    expect(JSON.parse(output)).toMatchObject({ executable: false, bytesVerified: false,
      source: { schemaVersion: 10, archiveProfile: "fp1-import-acceptance" } });
    expect(output).toContain("unregistered/image");
    expect(await readFile(f.inputPath, "utf8")).toBe(f.encoded);
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
      Buffer.from(JSON.stringify({ ...f.snapshot, schemaVersion: 10, archiveProfile: "fp1-import-acceptance" })),
      Buffer.from(JSON.stringify({ ...f.snapshot, tables: { ...f.snapshot.tables,
        r2_upload_requests: f.snapshot.tables.r2_upload_requests.map((row) => ({ ...row, request_sha256: "0".repeat(64) })) } })),
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

import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { WORKER_SCHEDULER_MIGRATION_NAME } from "../shared/contracts/worker-scheduler-schema-extension";
import { reviewedPortableMigrationSources } from "./reviewed-portable-migration-sources";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "claims-portable-source-inventory-")); directories.push(directory);
  const source = new URL("../migrations/", import.meta.url);
  for (const name of await readdir(source)) await copyFile(new URL(name, source), join(directory, name));
  return { directory, url: pathToFileURL(`${directory}/`) };
}

it("verifies the exact Worker25 suffix while retaining original23/24 portable fixture receipts", () => {
  for (const version of [25, 26] as const) {
    const sources = reviewedPortableMigrationSources(version);
    expect(sources).toHaveLength(version === 25 ? 23 : 24);
    expect(sources.some(source => source.name === WORKER_SCHEDULER_MIGRATION_NAME)).toBe(false);
    expect(sources.at(-1)?.name).toBe(version === 25 ? "0023_portable_local_identity.sql" : "0024_rt3_local_volume_profiles.sql");
  }
});

it("rejects a changed known Worker suffix instead of silently ignoring it", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, WORKER_SCHEDULER_MIGRATION_NAME), "ALTER TABLE file_job_runtime_guard ADD COLUMN other TEXT;\n");
  expect(() => reviewedPortableMigrationSources(26, f.url)).toThrow("Worker scheduler fixture successor digest");
});

it("rejects an unknown additional migration while preserving the closed frozen fixture inventory", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "0026_unreviewed.sql"), "CREATE TABLE unreviewed(id INTEGER);\n");
  expect(() => reviewedPortableMigrationSources(26, f.url)).toThrow("Unreviewed portable fixture migration inventory");
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { restoreExportToIsolatedDirectory } from "../scripts/lib/export-restore";
import {
  type ExportSchemaObject,
  type FullExportManifestV14,
} from "../shared/contracts/export";
import {
  canonicalFileAuthoritySchemaSql,
  fileAuthoritySchemaFingerprint,
  fileAuthoritySchemaSlice,
  FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL,
  FILE_AUTHORITY_SCHEMA_V14_VIEW_NAMES,
} from "../shared/contracts/export-file-authority";
import { createExportArtifact, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV14 } from "../shared/contracts/export-protocol";
import { buildFullExportArchiveV14 } from "../src/lib/exportAll";
import worker from "./index";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const endpoint = "/api/exports/all?archiveSchema=14&archiveWriter=1";
const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const databases: DatabaseSync[] = [];

describe("V14 schema fingerprint normalization", () => {
  it("ignores only SQL comments and layout while preserving quoted bytes and token identity", () => {
    const reviewed = `CREATE VIEW file_quoted_tokens AS
      -- splitter-owned presentation comment
      SELECT '--literal', "/*identifier*/", X'00ff' /* inline comment */;`;
    const split = `CREATE VIEW file_quoted_tokens AS SELECT '--literal',"/*identifier*/",X'00ff'`;
    expect(canonicalFileAuthoritySchemaSql(reviewed)).toEqual(canonicalFileAuthoritySchemaSql(split));
    expect(canonicalFileAuthoritySchemaSql(split)).not.toEqual(canonicalFileAuthoritySchemaSql(
      `CREATE VIEW file_quoted_tokens AS SELECT '--changed',"/*identifier*/",X'00ff'`,
    ));
    expect(canonicalFileAuthoritySchemaSql(split)).not.toEqual(canonicalFileAuthoritySchemaSql(
      `CREATE VIEW file_quoted_tokens AS SELECT '--literal',"/*identifier*/",X '00ff'`,
    ));
  });

  it("selects the same canonical inventory for whole-file and Wrangler-split migrations", { timeout: 30_000 }, async () => {
    const whole = new DatabaseSync(":memory:");
    const split = new DatabaseSync(":memory:");
    databases.push(whole, split);
    for (const name of (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql") && entry <= "0007_fp1_file_authority_transition.sql").sort()) {
      const sql = await readFile(join(migrationsDirectory, name), "utf8");
      whole.exec(sql);
      for (const statement of splitSql(sql)) split.exec(statement);
    }
    const observe = (database: DatabaseSync) => database.prepare(
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name",
    ).all() as unknown as ExportSchemaObject[];
    const wholeObjects = observe(whole);
    const splitObjects = observe(split);
    expect(fileAuthoritySchemaSlice(wholeObjects)).toEqual(fileAuthoritySchemaSlice(splitObjects));
    expect(await fileAuthoritySchemaFingerprint(wholeObjects)).toBe(await fileAuthoritySchemaFingerprint(splitObjects));
    const selected = fileAuthoritySchemaSlice(wholeObjects);
    expect(selected.some((entry) => entry.type === "index" && entry.sql === null)).toBe(true);
    expect(selected.filter((entry) => entry.type === "view").map((entry) => entry.name).sort())
      .toEqual([...FILE_AUTHORITY_SCHEMA_V14_VIEW_NAMES].sort());
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (databases.length) databases.pop()!.close();
});

function fixture() {
  const database = referenceTestDatabase({ throughMigration: "0007_fp1_file_authority_transition.sql" });
  databases.push(database);
  database.exec(`
    INSERT INTO storage_profiles
      (rowid, id, adapter_type, namespace_identity, configuration_source, credential_reference,
        configuration_revision, state, created_at)
    VALUES (-7, 'v14-profile', 'r2', 'v14-bucket', 'bootstrap', NULL, 1, 'historical',
      '2026-09-14T00:00:00.000Z');
    INSERT INTO samples (id, code, title, created_at, updated_at)
    VALUES ('v14-sample', 'V14', 'V14 transition', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z');
    INSERT INTO events (id, sample_id, kind, asset_key, metadata_json, created_at)
    VALUES ('v14-event', 'v14-sample', 'image', 'legacy/v14.png', '{}', '2026-09-14T00:00:00.000Z');
  `);
  const env = { AUTH_MODE: "disabled", DB: new SqliteD1Database(database) as unknown as D1Database } satisfies Env;
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(new URL(path, "https://app.test"), init), env, context);
  return { database, request };
}

async function manifestFrom(request: ReturnType<typeof fixture>["request"]) {
  const response = await request(endpoint);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<FullExportManifestV14>;
}

describe("v14 additive File authority export profile", () => {
  it("negotiates only V14 on the transitioned schema and retains the legacy byte planner", async () => {
    const f = fixture();
    const manifest = await manifestFrom(f.request);
    expect(manifest).toMatchObject({
      schemaVersion: 14,
      archiveWriter: 1,
      archiveProfile: "fp1-file-authority-transition",
    });
    expect(manifest.tables.file_authority_control).toEqual([{
      singleton: 1,
      mode: "legacy",
      revision: 1,
      updated_at: "2026-09-14T00:00:00.000Z",
      activated_at: null,
    }]);
    expect(manifest.tables.file_consumer_direct_projection).toContainEqual(expect.objectContaining({
      consumer_kind: "event",
      consumer_id: "v14-event",
      file_slot: "primary",
      file_id: null,
      legacy_r2_object_key: "legacy/v14.png",
      resolution_state: "legacy_pending",
      decision_id: null,
    }));
    expect(manifest.tables.file_retention_edges).toEqual([]);
    expect(manifest.tables.file_location_retention_edges).toEqual([]);
    expect(manifest.tables.file_location_availability).toEqual([]);
    expect(manifest.blobs).toHaveLength(1);
    expect(manifest.blobs[0]).toMatchObject({ storeKind: "r2", provider: "r2", objectKey: "legacy/v14.png" });
    for (const version of [8, 9, 10, 11, 12, 13]) {
      expect((await f.request(`/api/exports/all?archiveSchema=${version}&archiveWriter=1`)).status).toBe(409);
    }
  });

  it("rejects mode, consumer, sidecar, runtime and view corruption before packaging bytes", async () => {
    const f = fixture();
    const original = await manifestFrom(f.request);
    const cases: Array<(manifest: FullExportManifestV14) => void> = [
      (manifest) => { manifest.tables.file_authority_control[0].mode = "overlap"; },
      (manifest) => { manifest.tables.file_authority_control[0].updated_at = "2026-09-14T00:00:00.001Z"; },
      (manifest) => { manifest.tables.events[0].asset_file_id = "invented-file"; },
      (manifest) => { manifest.tables.file_publications.push({} as never); },
      (manifest) => { manifest.tables.storage_profile_runtime.push({ storage_profile_id: "invented-profile", state: "read_only", registered_at: "2026-09-14", activated_at: null, retired_at: null }); },
      (manifest) => { delete manifest.tables.file_consumer_projection; },
      (manifest) => {
        const direct = manifest.tables.file_consumer_direct_projection.find((row) => row.consumer_id === "v14-event" && row.file_slot === "primary")!;
        const combined = manifest.tables.file_consumer_projection.find((row) => row.consumer_id === "v14-event" && row.file_slot === "primary")!;
        direct.legacy_r2_object_key = "forged/key";
        combined.legacy_r2_object_key = "forged/key";
      },
      (manifest) => {
        const primary = manifest.tables.file_consumer_direct_projection.find(
          (row) => row.consumer_id === "v14-event" && row.file_slot === "primary",
        )!;
        const forged = { ...primary, file_slot: "thumbnail", expected_purpose: "derived_preview", legacy_r2_object_key: "forged/thumbnail" };
        manifest.tables.file_consumer_direct_projection.push(forged);
        manifest.tables.file_consumer_projection.push({ ...forged });
      },
    ];
    for (const corrupt of cases) {
      const manifest = structuredClone(original);
      corrupt(manifest);
      await expect(validateFullExportV14(manifest)).rejects.toThrow(/Full export rejected/);
    }
  });

  it("rejects a rehashed source-schema artifact with a missing authority guard", async () => {
    const f = fixture();
    const manifest = await manifestFrom(f.request);
    manifest.artifacts.sourceSchema.value.objects = manifest.artifacts.sourceSchema.value.objects.filter(
      (entry) => entry.name !== "file_authority_control_update_guard",
    );
    manifest.artifacts.sourceSchema = await createExportArtifact(
      EXPORT_SOURCE_SCHEMA_PATH,
      manifest.artifacts.sourceSchema.value,
    );
    await expect(validateFullExportV14(manifest)).rejects.toThrow(/schema fingerprint/);
  });

  it("rejects rehashed source-schema entries outside the exact fingerprint shape", async () => {
    const f = fixture();
    const original = await manifestFrom(f.request);
    const mutations: Array<(manifest: FullExportManifestV14) => void> = [
      (manifest) => { (manifest.artifacts.sourceSchema.value.objects[0] as unknown as Record<string, unknown>).forged = true; },
      (manifest) => { manifest.artifacts.sourceSchema.value.objects.push({
        type: "trigger", name: "forged_projection_guard", tableName: "file_consumer_projection",
        sql: "CREATE TRIGGER forged_projection_guard INSTEAD OF INSERT ON file_consumer_projection BEGIN SELECT 1; END",
      }); },
      (manifest) => { manifest.artifacts.sourceSchema.value.objects.push({
        type: "index", name: "sqlite_autoindex_file_publications_999", tableName: "file_publications", sql: null,
      }); },
      (manifest) => { manifest.artifacts.sourceSchema.value.objects = manifest.artifacts.sourceSchema.value.objects.filter(
        (entry) => entry.name !== "attachment_derivative_browser_safe_assets",
      ); },
    ];
    for (const mutate of mutations) {
      const manifest = structuredClone(original);
      mutate(manifest);
      manifest.artifacts.sourceSchema = await createExportArtifact(
        EXPORT_SOURCE_SCHEMA_PATH,
        manifest.artifacts.sourceSchema.value,
      );
      await expect(validateFullExportV14(manifest)).rejects.toThrow(/observed schema object|schema fingerprint/);
    }
  });

  it("fails closed when the local rowid claim inventory no longer matches its registries", async () => {
    const f = fixture();
    const guard = f.database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'file_registry_rowid_claims_delete_guard'",
    ).get() as { sql: string };
    f.database.exec(`
      DROP TRIGGER file_registry_rowid_claims_delete_guard;
      DELETE FROM file_registry_rowid_claims WHERE registry_name = 'storage_profiles';
      ${guard.sql};
    `);
    expect(f.database.prepare(FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL).get()).toEqual({ invalid_count: 1 });
    const response = await f.request(endpoint);
    expect(response.status).toBe(500);
  });

  it("fails closed before snapshotting a control-only partial V14 migration", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    for (const name of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql",
      "0004_r2_upload_acceptance.sql", "0005_metrology_reference_acceptance.sql", "0006_comment_acceptance.sql"]) {
      database.exec(await readFile(join(migrationsDirectory, name), "utf8"));
    }
    const transition = await readFile(join(migrationsDirectory, "0007_fp1_file_authority_transition.sql"), "utf8");
    const boundary = transition.indexOf("CREATE TABLE storage_profile_runtime");
    expect(boundary).toBeGreaterThan(0);
    database.exec(transition.slice(0, boundary));
    const d1 = new SqliteD1Database(database);
    const batch = vi.spyOn(d1, "batch");
    const env = { AUTH_MODE: "disabled", DB: d1 as unknown as D1Database } satisfies Env;
    for (const version of [13, 14]) {
      const response = await worker.fetch(new Request(new URL(
        `/api/exports/all?archiveSchema=${version}&archiveWriter=1`, "https://app.test",
      )), env, context);
      expect(response.status).toBe(500);
    }
    expect(batch).not.toHaveBeenCalled();
  });

  it("fails closed before snapshotting when only the final V14 completion marker is absent", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    for (const name of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql",
      "0004_r2_upload_acceptance.sql", "0005_metrology_reference_acceptance.sql", "0006_comment_acceptance.sql"]) {
      database.exec(await readFile(join(migrationsDirectory, name), "utf8"));
    }
    const transition = splitSql(await readFile(join(migrationsDirectory, "0007_fp1_file_authority_transition.sql"), "utf8"));
    expect(transition.at(-1)).toMatch(/^CREATE TRIGGER template_versions_file_replace_guard\b/);
    for (const statement of transition.slice(0, -1)) database.exec(statement);

    const d1 = new SqliteD1Database(database);
    const batch = vi.spyOn(d1, "batch");
    const env = { AUTH_MODE: "disabled", DB: d1 as unknown as D1Database } satisfies Env;
    for (const version of [13, 14]) {
      const response = await worker.fetch(new Request(new URL(
        `/api/exports/all?archiveSchema=${version}&archiveWriter=1`, "https://app.test",
      )), env, context);
      expect(response.status).toBe(500);
    }
    expect(batch).not.toHaveBeenCalled();
  });

  it("keeps SQLite JSON1 authoritative for legacy thumbnail edge cases", async () => {
    const f = fixture();
    const insert = f.database.prepare(`INSERT INTO events (id, sample_id, kind, metadata_json, created_at)
      VALUES (?, 'v14-sample', 'image', ?, '2026-09-14T00:00:01.000Z')`);
    insert.run("v14-duplicate-thumbnail", '{"thumbnailKey":"legacy/first.png","thumbnailKey":"legacy/last.png"}');
    insert.run("v14-surrogate-thumbnail", '{"thumbnailKey":"\\ud800"}');
    insert.run("v14-deep-thumbnail", `{"thumbnailKey":"legacy/deep.png","other":${"[".repeat(1001)}0${"]".repeat(1001)}}`);
    const manifest = await manifestFrom(f.request);
    expect(manifest.tables.file_consumer_direct_projection).toContainEqual(expect.objectContaining({
      consumer_id: "v14-duplicate-thumbnail",
      file_slot: "thumbnail",
      legacy_r2_object_key: "legacy/first.png",
    }));
    expect(manifest.tables.file_consumer_direct_projection.some((row) => row.consumer_id === "v14-surrogate-thumbnail")).toBe(true);
    expect(manifest.tables.file_consumer_direct_projection.some((row) => row.consumer_id === "v14-deep-thumbnail")).toBe(false);
    await expect(validateFullExportV14(manifest)).resolves.toEqual(manifest);
  });

  it("restores an exact V14 archive without inventing authority or changing legacy byte outcomes", async () => {
    const f = fixture();
    const manifest = await manifestFrom(f.request);
    expect(manifest.tables).not.toHaveProperty("file_registry_rowid_claims");
    const packaged = await buildFullExportArchiveV14(manifest, undefined, vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    expect(packaged.results).toHaveLength(1);
    expect(packaged.results[0].outcome).toBe("missing");
    const scratch = await mkdtemp(join(tmpdir(), "export-v14-"));
    try {
      const archivePath = join(scratch, "v14.zip");
      await writeFile(archivePath, Buffer.from(await packaged.archive.arrayBuffer()));
      const restored = await restoreExportToIsolatedDirectory({
        archivePath,
        destination: join(scratch, "restored"),
        migrationsDirectory,
        targetCompatibilitySchema: "S2",
      });
      expect(restored.report).toMatchObject({
        schemaVersion: 14,
        archiveProfile: "fp1-file-authority-transition",
        appliedForwardMigrations: [{ name: "0008_fp1_shadow_runtime.sql" }],
        verification: { rowsEqual: true, foreignKeys: true, integrity: "ok", schemaEqual: true,
          derivedTablesRebuilt: true },
      });

      const alteredMigrations = join(scratch, "altered-migrations");
      await mkdir(alteredMigrations);
      for (const name of await readdir(migrationsDirectory)) {
        if (!name.endsWith(".sql")) continue;
        let sql = await readFile(join(migrationsDirectory, name), "utf8");
        if (name === "0007_fp1_file_authority_transition.sql") {
          const guard = `CREATE TRIGGER file_authority_control_update_guard
BEFORE UPDATE ON file_authority_control BEGIN
  SELECT RAISE(ABORT, 'File authority mode changes require a reviewed forward migration');
END;

`;
          expect(sql).toContain(guard);
          sql = sql.replace(guard, "");
        }
        await writeFile(join(alteredMigrations, name), sql);
      }
      await expect(restoreExportToIsolatedDirectory({
        archivePath,
        destination: join(scratch, "altered-restore"),
        migrationsDirectory: alteredMigrations,
        targetCompatibilitySchema: "S2",
      })).rejects.toThrow(/reviewed migration checkpoint/);

      const database = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        expect(database.prepare("SELECT mode, revision, activated_at FROM file_authority_control").get())
          .toEqual({ mode: "legacy", revision: 1, activated_at: null });
        expect(database.prepare("SELECT asset_file_id, thumbnail_file_id FROM events WHERE id = 'v14-event'").get())
          .toEqual({ asset_file_id: null, thumbnail_file_id: null });
        expect(database.prepare("SELECT COUNT(*) AS count FROM file_publications").get()).toEqual({ count: 0 });
        expect(database.prepare(FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL).get()).toEqual({ invalid_count: 0 });
        expect(database.prepare(`SELECT COUNT(*) AS count FROM file_registry_rowid_claims
          WHERE registry_name = 'storage_profiles'`).get()).toEqual({ count: 1 });
        const restoredProfile = database.prepare("SELECT rowid FROM storage_profiles WHERE id = 'v14-profile'").get() as { rowid: number };
        expect(restoredProfile.rowid).not.toBe(-7);
        expect(database.prepare(`SELECT claimed_rowid FROM file_registry_rowid_claims
          WHERE registry_name = 'storage_profiles'`).get()).toEqual({ claimed_rowid: restoredProfile.rowid });
      } finally {
        database.close();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeFabubloxImportRequestId } from "../../shared/contracts/fabublox-import";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import {
  acceptFabubloxImport, acceptedImportState, readAcceptedImport,
  FabubloxImportAcceptanceUnavailableError, FabubloxImportRequestConflictError,
  type AcceptFabubloxImportInput,
} from "./fabublox-acceptance";

const NOW = "2026-09-13T20:00:00.000Z";
const REQUEST = "c0030000-0000-4000-8000-000000000001";
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function profile(sql: DatabaseSync, id = "profile", type = "r2") {
  sql.prepare(`INSERT INTO storage_profiles VALUES (?, ?, ?, ?, ?, 1, 'historical', ?)`)
    .run(id, type, `namespace:${id}`, type === "r2" ? "bootstrap" : "environment",
      type === "r2" ? null : "environment:SWITCHDRIVE", NOW);
}
function fixture() {
  const sql = referenceTestDatabase(); databases.push(sql); profile(sql);
  return { sql, db: new SqliteD1Database(sql) as unknown as D1Database };
}
function input(override: Partial<AcceptFabubloxImportInput> = {}): AcceptFabubloxImportInput {
  return {
    importId: "import-one", operationId: "owner-one", requestId: REQUEST,
    requestSha256: "a".repeat(64), requestInputJson: '{"manifest":{"title":"Template"}}',
    actorEmail: "actor@example.org", profileId: "profile", profileRevision: 1, policyRevision: 1,
    sourceFilename: "source.xlsx", sourceSha256: "b".repeat(64), sheetName: "Process",
    templateType: "process", recipeFamilyId: "family", warningCount: 0,
    createdAt: NOW, leaseExpiresAt: "2026-09-14T20:00:00.000Z", ...override,
  };
}
function legacy(sql: DatabaseSync, id = "old") {
  sql.prepare(`INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type, created_at)
    VALUES (?, 'ready', 'old.xlsx', ?, 'Process', 'process', ?)`).run(id, "b".repeat(64), NOW);
}
function preparePublication(sql: DatabaseSync) {
  for (const [id, hash] of [["workbook", "d"], ["manifest", "e"]]) {
    sql.prepare(`INSERT INTO assets(id, import_id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES (?, 'import-one', ?, ?, 'application/octet-stream', 5, 'pending', ?, ?)`).run(id, id, id, hash.repeat(64), NOW);
  }
  sql.prepare(`INSERT INTO recipe_families(id, name, template_type, created_at)
    VALUES ('family', 'Template', 'process', ?)`).run(NOW);
  sql.prepare(`INSERT INTO template_versions(id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at)
    VALUES ('template', 'family', 'Template', 'process', 1, ?, '{}', ?)`).run("c".repeat(64), NOW);
  sql.exec("UPDATE imports SET template_version_id='template', workbook_asset_key='workbook', manifest_asset_key='manifest' WHERE id='import-one'");
}
function publish(sql: DatabaseSync, result: unknown = { id: "import-one", templateVersionId: "template", version: 1 }) {
  sql.prepare(`UPDATE imports SET status='ready', finalization_id='finalization', completed_at=?,
    lease_expires_at=NULL, accepted_result_json=? WHERE id='import-one' AND status='pending' AND operation_id='owner-one'`)
    .run(NOW, typeof result === "string" ? result : JSON.stringify(result));
}
function interceptInsert(db: D1Database, performInsert: boolean, failRead = false): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async run() {
              if (performInsert) await bound.run();
              throw new Error("secret deployment detail");
            },
            first: () => failRead ? Promise.reject(new Error("secret read detail")) : bound.first(),
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("durable FabuBlox acceptance", () => {
  it("accepts exactly one execution owner before any file operation", async () => {
    const { sql, db } = fixture();
    const first = await acceptFabubloxImport(db, input());
    expect(first.owned).toBe(true);
    expect(acceptedImportState(first.row)).toEqual({ requestId: REQUEST, importId: "import-one", status: "pending", leaseExpiresAt: input().leaseExpiresAt });
    const repeat = await acceptFabubloxImport(db, input({ importId: "loser", operationId: "other-owner" }));
    expect(repeat.owned).toBe(false);
    expect(repeat.row.id).toBe("import-one");
    expect(sql.prepare("SELECT count(*) n FROM imports").get()!.n).toBe(1);
    expect(sql.prepare("SELECT count(*) n FROM files").get()!.n).toBe(0);
  });

  it("isolates identical client request IDs by actor", async () => {
    const { db } = fixture();
    await acceptFabubloxImport(db, input());
    expect(await readAcceptedImport(db, "another@example.org", REQUEST)).toBeNull();
    const other = await acceptFabubloxImport(db, input({ actorEmail: "another@example.org", importId: "other", operationId: "other-owner" }));
    expect(other.owned).toBe(true);
    expect(other.row.id).toBe("other");
  });

  it.each([
    { requestSha256: "c".repeat(64) },
    { requestInputJson: '{"manifest":{"title":"Changed"}}' },
  ])("rejects a reused request ID with changed immutable input: %j", async (change) => {
    const { db } = fixture(); await acceptFabubloxImport(db, input());
    await expect(acceptFabubloxImport(db, input({ importId: "other", operationId: "other-owner", ...change })))
      .rejects.toBeInstanceOf(FabubloxImportRequestConflictError);
  });

  it("reconciles a committed INSERT with lost acknowledgement on the primary", async () => {
    const { db } = fixture(); const uncertain = interceptInsert(db, true);
    let primaryReads = 0;
    const session = { withSession: (constraint: string) => { expect(constraint).toBe("first-primary"); primaryReads += 1; return uncertain; } } as unknown as D1Database;
    const result = await acceptFabubloxImport(session, input());
    expect(result.owned).toBe(true); expect(primaryReads).toBe(2);
  });

  it.each([false, true])("does not grant execution ownership when uncertain INSERT cannot be observed: read failure %s", async (failRead) => {
    const { db } = fixture();
    await expect(acceptFabubloxImport(interceptInsert(db, false, failRead), input()))
      .rejects.toEqual(new FabubloxImportAcceptanceUnavailableError());
    expect(await readAcceptedImport(db, input().actorEmail, REQUEST)).toBeNull();
  });

  it("replays a completed result after its Template is moved to Trash", async () => {
    const { sql, db } = fixture(); await acceptFabubloxImport(db, input()); preparePublication(sql); publish(sql);
    sql.prepare("UPDATE template_versions SET deleted_at=? WHERE id='template'").run(NOW);
    const replay = await acceptFabubloxImport(db, input({ importId: "other", operationId: "other-owner", profileId: "unavailable-profile" }));
    expect(replay.owned).toBe(false);
    expect(acceptedImportState(replay.row)).toEqual({ requestId: REQUEST, importId: "import-one", status: "ready",
      result: { id: "import-one", templateVersionId: "template", version: 1 } });
  });

  it("preserves failed operation identity instead of restarting it", async () => {
    const { sql, db } = fixture(); await acceptFabubloxImport(db, input());
    sql.exec("UPDATE imports SET status='failed', recovery_operation_id='recovery', lease_expires_at=NULL WHERE id='import-one'");
    expect(() => sql.exec("UPDATE imports SET status='pending' WHERE id='import-one'")).toThrow(/cannot restart/);
    const replay = await acceptFabubloxImport(db, input({ importId: "other", operationId: "other-owner" }));
    expect(replay.owned).toBe(false);
    expect(acceptedImportState(replay.row)).toEqual({ requestId: REQUEST, importId: "import-one", status: "failed" });
  });

  it("normalizes UUID case and rejects malformed request identities", () => {
    expect(normalizeFabubloxImportRequestId(REQUEST.toUpperCase())).toBe(REQUEST);
    for (const bad of ["", ` ${REQUEST}`, `${REQUEST}\n`, REQUEST.replace("-4000-", "-0000-"), REQUEST.replace("-8000-", "-7000-")]) {
      expect(normalizeFabubloxImportRequestId(bad)).toBeNull();
    }
  });
});

describe("FabuBlox acceptance forward schema", () => {
  it("preserves populated legacy rows and rolls back a failed forward migration", () => {
    const sql = new DatabaseSync(":memory:"); databases.push(sql);
    for (const filename of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql"]) {
      sql.exec(readFileSync(new URL(`../../migrations/${filename}`, import.meta.url), "utf8"));
    }
    legacy(sql);
    const prior = sql.prepare("SELECT * FROM imports").get()!;
    const migration = readFileSync(new URL("../../migrations/0003_fp1_import_acceptance.sql", import.meta.url), "utf8");
    sql.exec("BEGIN");
    expect(() => sql.exec(`${migration}\n INSERT INTO nonexistent_table VALUES (1);`)).toThrow();
    sql.exec("ROLLBACK");
    expect(sql.prepare("SELECT * FROM imports").get()).toEqual(prior);
    expect(sql.prepare("PRAGMA table_info(imports)").all().some((column) => column.name === "client_request_id")).toBe(false);
    sql.exec(migration);
    const after = sql.prepare("SELECT * FROM imports").get()!;
    expect(Object.fromEntries(Object.keys(prior).map((key) => [key, after[key]]))).toEqual(prior);
    expect(Object.entries(after).filter(([key]) => !(key in prior)).map(([, value]) => value)).toEqual(Array(8).fill(null));
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains the complete legacy write/recovery path without manufacturing acceptance", () => {
    const { sql } = fixture(); legacy(sql);
    sql.exec("UPDATE imports SET status='failed', operation_id='legacy-owner', recovery_operation_id='recovery' WHERE id='old'");
    expect(() => sql.exec(`UPDATE imports SET client_request_id='${REQUEST}' WHERE id='old'`)).toThrow(/cannot acquire/);
    sql.exec("DELETE FROM imports WHERE id='old'");
  });

  it("rejects partial acceptance and unsuitable profiles", async () => {
    const { sql, db } = fixture();
    expect(() => sql.prepare(`INSERT INTO imports (id,status,source_filename,source_sha256,sheet_name,template_type,created_at,client_request_id)
      VALUES ('partial','pending','source','hash','Sheet','process',?,?)`).run(NOW, REQUEST)).toThrow(/complete/);
    profile(sql, "managed", "switchdrive");
    await expect(acceptFabubloxImport(db, input({ profileId: "managed" }))).rejects.toBeInstanceOf(FabubloxImportAcceptanceUnavailableError);
    expect(sql.prepare("SELECT count(*) n FROM imports").get()!.n).toBe(0);
  });

  it("fences accepted identity against updates, deletion and SQLite replacement", async () => {
    const { sql, db } = fixture(); await acceptFabubloxImport(db, input());
    for (const assignment of ["id='changed'", "actor_email='other'", "operation_id='other'", "client_request_id=NULL",
      "request_sha256=NULL", "request_input_json='{}'", "request_scope=NULL", "storage_profile_id=NULL",
      "storage_profile_revision=NULL", "storage_policy_revision=NULL"]) {
      expect(() => sql.exec(`UPDATE imports SET ${assignment} WHERE id='import-one'`)).toThrow(/immutable/);
    }
    expect(() => sql.exec("DELETE FROM imports WHERE id='import-one'")).toThrow(/cannot be deleted/);
    sql.exec("PRAGMA recursive_triggers=OFF");
    expect(() => sql.prepare(`INSERT OR REPLACE INTO imports (id,status,source_filename,source_sha256,sheet_name,template_type,created_at)
      VALUES ('import-one','ready','replacement','hash','Sheet','process',?)`).run(NOW)).toThrow(/immutable/);
    expect((await readAcceptedImport(db, input().actorEmail, REQUEST))?.id).toBe("import-one");
  });

  it("requires atomic result publication backed by the owning Template version", async () => {
    const { sql, db } = fixture(); await acceptFabubloxImport(db, input()); preparePublication(sql);
    expect(() => sql.exec("UPDATE imports SET status='ready' WHERE id='import-one'")).toThrow(/publication state/);
    for (const result of ["{", { id: "other", templateVersionId: "template", version: 1 },
      { id: "import-one", templateVersionId: "other", version: 1 },
      { id: "import-one", templateVersionId: "template", version: 2 },
      { id: "import-one", templateVersionId: "template", version: 1, extra: true }]) {
      expect(() => publish(sql, result)).toThrow(/result/);
      expect(sql.prepare("SELECT status FROM imports WHERE id='import-one'").get()!.status).toBe("pending");
    }
    publish(sql);
    for (const assignment of ["accepted_result_json=NULL", "accepted_result_json='{}'", "status='failed'"]) {
      expect(() => sql.exec(`UPDATE imports SET ${assignment} WHERE id='import-one'`)).toThrow(/immutable/);
    }
  });

  it("rejects oversized metadata before recording any acceptance", async () => {
    const { db } = fixture();
    await expect(acceptFabubloxImport(db, input({ requestInputJson: JSON.stringify({ payload: "é".repeat(66000) }) })))
      .rejects.toThrow(/Invalid import acceptance input/);
    expect(await readAcceptedImport(db, input().actorEmail, REQUEST)).toBeNull();
  });
});

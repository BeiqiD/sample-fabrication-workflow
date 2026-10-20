import { afterEach, describe, expect, it, vi } from "vitest";
import { d1FileJobRepository } from "../../files/jobs/d1-repository";
import { referenceTestDatabase, SqliteD1Database } from "../../reference-test-support";
import { SqlPackageRepository } from "./sql-repository";
import { packageSqlDatabase } from "./worker-runtime";

const actor = "review@example.test", at = "2026-10-20T00:00:00.000Z", older = "2020-01-01T00:00:00.000Z";
const sha = "a".repeat(64);
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(sql => sql.close()); });

function fixture() {
  const sql = referenceTestDatabase({ throughMigration: "0025_scheduler_fair_turn.sql" }); databases.push(sql);
  // Seed synthetic status history without provider acceptance. Restore every
  // exact migrated trigger before reads; preserve real tables, keys and indexes.
  const triggers = sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as { name: string; sql: string }[];
  for (const trigger of triggers) sql.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  sql.exec("PRAGMA foreign_keys=ON; BEGIN");
  sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2','review-namespace','bootstrap',NULL,1,'historical',?)").run(at);
  const file = sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES(?,'embedded_content','system',1,?,'unresolved',?)");
  const location = sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES(?,?,'profile',?,'unresolved',?)");
  const publication = sql.prepare("INSERT INTO file_location_publications VALUES(?,?,'profile',?,1,?,'full_read_sha256','review',?,?)");
  for (let index = 0; index < 50; index++) {
    const id = `file:${index}`, source = `location:${index}`;
    file.run(id, sha, at); location.run(source, id, id, at); publication.run(source, id, id, sha, at, at);
  }
  const packageJob = sql.prepare(`INSERT INTO research_package_jobs(id,request_id,actor,kind,input_json,package_id,source_installation_id,
    accepted_at,target_policy_json,state,phase,updated_at) VALUES(?,?,?,'data_package','{}',?,'source',?,'{}','queued','snapshot',?)`);
  const packageFile = sql.prepare(`INSERT INTO research_package_files(job_id,logical_file_id,entry_kind,purpose,byte_size,sha256,
    archive_path,media_type,hold_operation_id,target_profile_id,target_profile_revision,target_namespace,target_policy_revision,
    candidate_file_id,state,updated_at) VALUES(?,?,'payload','embedded_content',1,?,?,'application/octet-stream',?,'profile',1,
    'review-namespace',2,?,'pending',?)`);
  const migrationJob = sql.prepare(`INSERT INTO file_migration_jobs(id,request_id,actor,input_json,target_profile_id,
    target_configuration_revision,target_namespace,accepted_at,state,updated_at)
    VALUES(?,?,?,'{}','profile',1,'review-namespace',?,'queued',?)`);
  const migrationItem = sql.prepare(`INSERT INTO file_migration_items(job_id,file_id,purpose,source_location_id,source_profile_id,
    source_configuration_revision,source_namespace,source_object_key,byte_size,sha256,hold_operation_id,state,updated_at)
    VALUES(?,?,'embedded_content',?,'profile',1,'review-namespace',?,1,?,?,'pending',?)`);
  for (let index = 0; index < 1100; index++) {
    const id = `job:${String(index).padStart(5, "0")}`, visible = index < 100;
    const accepted = visible ? at : older, owner = visible ? actor : "other@example.test";
    packageJob.run(id, `request:${id}`, owner, `package:${id}`, accepted, accepted);
    migrationJob.run(id, `request:${id}`, owner, accepted, accepted);
    for (let item = 0; item < (visible ? 10 : 50); item++) {
      const logical = `file:${item}`;
      packageFile.run(id, logical, sha, logical, `package-hold:${id}:${item}`, `candidate:${id}:${item}`, at);
      migrationItem.run(id, logical, `location:${item}`, logical, sha, `migration-hold:${id}:${item}`, at);
    }
  }
  sql.exec("COMMIT");
  for (const trigger of triggers) sql.exec(trigger.sql);
  expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const database = new SqliteD1Database(sql), db = database as unknown as D1Database, queries: string[] = [];
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation(query => {
    if (query.startsWith("WITH selected_jobs AS")) queries.push(query);
    return prepare(query);
  });
  return { sql, database, db, queries };
}

describe("selected-job aggregation query plans", () => {
  it("seeks only selected Package and Migration child rows before and after SQLite statistics are populated", async () => {
    const f = fixture();
    const packages = new SqlPackageRepository(packageSqlDatabase(f.db));
    const migrations = d1FileJobRepository(f.db);
    const packageRows = await packages.list(actor), migrationRows = await migrations.list();
    expect(packageRows).toHaveLength(100); expect(migrationRows).toHaveLength(100);
    expect(packageRows.every(row => row.filesTotal === 10)).toBe(true);
    expect(migrationRows.every(row => row.remaining === 10)).toBe(true);
    expect(f.queries).toHaveLength(2);
    for (const analyze of [false, true]) {
      if (analyze) f.sql.exec("ANALYZE");
      for (const [index, alias] of ["f", "i"].entries()) {
        const plan = f.sql.prepare(`EXPLAIN QUERY PLAN ${f.queries[index]}`).all(...(index === 0 ? [actor] : []))
          .map(row => String(row.detail));
        expect(plan.some(detail => new RegExp(`^SEARCH ${alias}\\b.*\\(job_id=\\?\\)`).test(detail)), plan.join("\n")).toBe(true);
        expect(plan.some(detail => new RegExp(`^SCAN ${alias}\\b`).test(detail)), plan.join("\n")).toBe(false);
      }
    }
  });
});

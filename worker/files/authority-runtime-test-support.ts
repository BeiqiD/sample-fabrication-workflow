import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { referenceTestDatabase } from "../reference-test-support";

/**
 * Test-only future cutover. Latest migrations do not authorize activation.
 * Temporarily bypass only the control transition guard; every publication,
 * receipt, alias and typed-consumer guard stays installed. Restore the exact
 * control guard in the same transaction before returning the database.
 */
export function enableFutureFileAuthority(sql: DatabaseSync, now = new Date().toISOString()) {
  assert.equal(sql.prepare("SELECT mode FROM file_authority_control").get()!.mode, "overlap");
  const control = sql.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='file_authority_control_update_guard'").get();
  assert.equal(typeof control?.sql, "string");
  sql.exec("BEGIN");
  try {
    sql.exec("DROP TRIGGER file_authority_control_update_guard");
    sql.prepare("UPDATE file_authority_control SET mode='active',updated_at=?").run(now);
    sql.prepare("UPDATE file_authority_runtime_guard SET incarnation=?,enabled=1,enabled_by='runtime-test',updated_at=? WHERE singleton=1")
      .run(crypto.randomUUID(), now);
    sql.exec(String(control!.sql));
    assert.equal(sql.prepare("SELECT sql FROM sqlite_schema WHERE name='file_authority_control_update_guard'").get()!.sql, control!.sql);
    sql.exec("COMMIT");
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}

/** Load all real migrations, legally enter overlap, then simulate future active. */
export function futureActiveRuntimeDatabase(prepareOverlap?: (sql: DatabaseSync) => void) {
  const sql = referenceTestDatabase();
  try {
    sql.exec("PRAGMA foreign_keys=ON");
    sql.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'future-runtime-test',? FROM file_shadow_control")
      .run(new Date().toISOString());
    prepareOverlap?.(sql);
    enableFutureFileAuthority(sql);
    return sql;
  } catch (error) {
    sql.close();
    throw error;
  }
}

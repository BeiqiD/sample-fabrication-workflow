import type { ReviewedRecoveryMigration } from "./versioned-catalog";
import { RECOVERY_MIGRATIONS } from "./trusted-schema";
import { canonicalFileAuthoritySchemaSql } from "../../shared/contracts/export-file-authority";

/** Wrangler's installation-local bookkeeping is created from reviewed code,
 * after the entire restored schema/data graph has passed verification. */
export const RECOVERY_MIGRATION_LEDGER_SQL = 'CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
const normalize = (sql: string) => JSON.stringify(canonicalFileAuthoritySchemaSql(sql));
function ensure(value: unknown): asserts value { if (!value) throw new Error("recovery_migration_ledger_not_reviewed"); }
export async function inspectRecoveryMigrationLedger(db: D1Database, required = false, migrations: readonly Readonly<ReviewedRecoveryMigration>[] = RECOVERY_MIGRATIONS) {
  const schema = await db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='d1_migrations'").first<{ sql: string }>();
  if (!schema) { ensure(!required); return { present: false, complete: false }; }
  ensure(normalize(schema.sql) === normalize(RECOVERY_MIGRATION_LEDGER_SQL));
  const objects = await db.prepare("SELECT type,name FROM sqlite_schema WHERE tbl_name='d1_migrations' AND sql IS NOT NULL").all<{ type:string;name:string }>();
  ensure(objects.success && objects.results.length===1 && objects.results[0].type==='table' && objects.results[0].name==='d1_migrations');
  const result = await db.prepare("SELECT CAST(id AS TEXT) id,name,applied_at FROM d1_migrations ORDER BY d1_migrations.id").all<{ id: string; name: string; applied_at: string }>();
  ensure(result.success && (result.results.length === 0 && !required || result.results.length === migrations.length));
  if (result.results.length) for(const [index,row] of result.results.entries()) {
    if(row.id!==String(index+1)||row.name!==migrations[index].name) throw new Error(`recovery_migration_ledger_identity:${index}:${row.id}:${row.name}`);
    if(typeof row.applied_at!=="string"||!Number.isFinite(Date.parse(row.applied_at))) throw new Error(`recovery_migration_ledger_clock:${index}:${row.applied_at}`);
  }
  return { present: true, complete: result.results.length === migrations.length };
}
export async function recoveryMigrationLedgerStatements(db: D1Database, migrations: readonly Readonly<ReviewedRecoveryMigration>[] = RECOVERY_MIGRATIONS) {
  const existing = await inspectRecoveryMigrationLedger(db, false, migrations);
  return [
    ...(!existing.present ? [db.prepare(RECOVERY_MIGRATION_LEDGER_SQL)] : []),
    ...(!existing.complete ? migrations.map((migration,index) => db.prepare("INSERT INTO d1_migrations(id,name) VALUES(?,?)").bind(index+1,migration.name)) : []),
  ];
}
export async function inspectRecoveryPlatformSchema(db:D1Database) {
  const objects=await db.prepare("SELECT type,name,tbl_name tableName,sql FROM sqlite_schema WHERE tbl_name IN('_cf_METADATA','_cf_KV') AND sql IS NOT NULL")
    .all<{type:string;name:string;tableName:string;sql:string}>();
  ensure(objects.success);
  for(const object of objects.results){
    // _cf_METADATA is observed in the actual native D1 qualification baseline.
    // No unqualified platform DDL or attached application object is hidden.
    const reviewed=object.name==='_cf_METADATA'?'CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY,value BLOB)'
      :object.name==='_cf_KV'?'CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID':null;
    ensure(reviewed&&object.type==='table'&&object.name===object.tableName&&normalize(object.sql)===normalize(reviewed));
  }
}

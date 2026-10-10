import type { ExportSchemaObject } from "../../shared/contracts/export";
import { canonicalFileAuthoritySchemaSql } from "../../shared/contracts/export-file-authority";
import { checkedPortableApplicationSchema } from "../../shared/contracts/export-portable-runtime";
import { RECOVERY_MIGRATION_LEDGER_SQL } from "./target-migrations";

export interface CurrentCloudflareSchemaInspection {
  applicationObjects: ExportSchemaObject[];
  /** Schema ownership only; the caller separately inspects ledger row receipts. */
  ledgerPresent: boolean;
}
const fields = ["type", "name", "tableName", "sql"] as const;
const types = new Set(["table", "index", "view", "trigger"]);
const platformTables = new Set(["d1_migrations", "_cf_KV", "_cf_METADATA", "sqlite_sequence"]);
const reviewedPlatform: readonly ExportSchemaObject[] = Object.freeze([
  Object.freeze({ type: "table", name: "d1_migrations", tableName: "d1_migrations", sql: RECOVERY_MIGRATION_LEDGER_SQL }),
  Object.freeze({ type: "index", name: "sqlite_autoindex_d1_migrations_1", tableName: "d1_migrations", sql: null }),
  Object.freeze({ type: "table", name: "sqlite_sequence", tableName: "sqlite_sequence", sql: "CREATE TABLE sqlite_sequence(name,seq)" }),
  Object.freeze({ type: "table", name: "_cf_KV", tableName: "_cf_KV", sql: "CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID" }),
  Object.freeze({ type: "table", name: "_cf_METADATA", tableName: "_cf_METADATA", sql: "CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY,value BLOB)" }),
]);
const platformNames = new Set(reviewedPlatform.map(object => object.name));
function fail(reason: string): never { throw new Error(`current_cloudflare_schema_${reason}`); }
function observedObjects(values: readonly ExportSchemaObject[]): ExportSchemaObject[] {
  if (!Array.isArray(values) || values.length > 2048) return fail("inventory");
  const names = new Set<string>();
  return values.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== fields.length
      || Object.keys(value).sort().join(",") !== [...fields].sort().join(",")
      || fields.some(field => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, field) ?? {}, "value"))) return fail("object_fields");
    const { type, name, tableName, sql } = value;
    if (!types.has(type) || typeof name !== "string" || !name || name.includes("\0") || names.has(name)
      || typeof tableName !== "string" || !tableName || tableName.includes("\0")
      || sql !== null && (typeof sql !== "string" || !sql)) return fail("object_value_or_duplicate");
    names.add(name);
    return { type, name, tableName, sql };
  });
}
const lexical = (sql: string) => JSON.stringify(canonicalFileAuthoritySchemaSql(sql));
function matches(actual: ExportSchemaObject, reviewed: ExportSchemaObject): boolean {
  return actual.type === reviewed.type && actual.name === reviewed.name && actual.tableName === reviewed.tableName
    && (reviewed.sql === null ? actual.sql === null : typeof actual.sql === "string" && lexical(actual.sql) === lexical(reviewed.sql));
}

/** Observe the complete sqlite_schema inventory, including SQL-null indexes.
 * Every field, duplicate and exact platform ownership is checked before any
 * omission. Only reviewed engine tables are optional; the AUTOINCREMENT ledger
 * requires its exact unique autoindex and SQLite sequence object as one trio.
 * No prefix-based platform/internal omission, archive SQL or destination DDL is
 * accepted. This synchronous boundary does not admit an application schema.
 * An empty target must still have truly zero remaining objects; a populated
 * source/target must use the complete current checker below. */
export function stripReviewedCurrentCloudflarePlatformSchema(values: readonly ExportSchemaObject[]): CurrentCloudflareSchemaInspection {
  const observed = observedObjects(values), owned = new Set<string>(), application: ExportSchemaObject[] = [];
  for (const object of observed) {
    if (platformNames.has(object.name) || platformTables.has(object.tableName)) {
      const reviewed = reviewedPlatform.find(value => value.name === object.name);
      if (!reviewed || !matches(object, reviewed)) return fail("platform_not_reviewed");
      owned.add(object.name);
    } else application.push(object);
  }
  const ledgerPresent = owned.has("d1_migrations");
  if (ledgerPresent !== owned.has("sqlite_autoindex_d1_migrations_1") || ledgerPresent !== owned.has("sqlite_sequence")) return fail("ledger_pair");
  return { applicationObjects: application, ledgerPresent };
}

/** Exact platform admission followed by the full code-owned current application
 * pin. There is no allowEmpty/allowExtra mode. Historical readers are unchanged. */
export async function inspectCurrentCloudflareSchema(values: readonly ExportSchemaObject[]): Promise<CurrentCloudflareSchemaInspection> {
  const { applicationObjects, ledgerPresent } = stripReviewedCurrentCloudflarePlatformSchema(values);
  // All primitive fields were copied before this asynchronous application pin
  // check. Mutating the caller's inventory cannot retarget the admitted tuple.
  return { applicationObjects: await checkedPortableApplicationSchema(applicationObjects), ledgerPresent };
}

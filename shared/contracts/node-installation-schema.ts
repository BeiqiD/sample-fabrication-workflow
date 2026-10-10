// Code-owned platform-local SQLite objects. These are admitted only after the
// exact current application checkpoint and migration receipts are validated.
export interface InstallationSchemaObject {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  tableName: string;
  sql: string;
}
export const NODE_INSTALLATION_DDL = `CREATE TABLE node_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  installation_id TEXT NOT NULL CHECK(length(installation_id)=36),
  catalog_id TEXT NOT NULL,
  schema_checkpoint TEXT NOT NULL,
  schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256)=64),
  created_at TEXT NOT NULL
)`;
export const NODE_MIGRATIONS_DDL = `CREATE TABLE node_migrations (
  ordinal INTEGER PRIMARY KEY CHECK(ordinal>0),
  name TEXT NOT NULL UNIQUE,
  raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64),
  checkpoint_id TEXT NOT NULL UNIQUE,
  schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256)=64),
  status TEXT NOT NULL CHECK(status='applied'),
  applied_at TEXT NOT NULL
)`;
export const NODE_PLATFORM_OBJECTS: readonly InstallationSchemaObject[] = Object.freeze([
  Object.freeze({ type: "table", name: "node_installation", tableName: "node_installation", sql: NODE_INSTALLATION_DDL }),
  Object.freeze({ type: "table", name: "node_migrations", tableName: "node_migrations", sql: NODE_MIGRATIONS_DDL }),
]);

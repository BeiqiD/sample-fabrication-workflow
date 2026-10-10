import { createHash } from 'node:crypto';
import type { SqliteCapability } from '../sqlite';

/** Code-owned local identity v1 DDL. The prototype inspector admits only an
 * isolated database; the installed constructor requires a complete reviewed
 * installation checkpoint. This module never installs tables or activates a
 * product writer. The paired current catalog owns migration/recovery policy;
 * historical V19–V24 do not admit this identity schema. */
export const PROTOTYPE_IDENTITY_STATEMENTS = Object.freeze([
  `CREATE TABLE local_identity_installation (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    bootstrap_principal_id TEXT NOT NULL UNIQUE,
    catalog_id TEXT NOT NULL CHECK(catalog_id = 'local-identity-v1'),
    initialized_at INTEGER NOT NULL CHECK(initialized_at >= 0)
  ) STRICT`,
  `CREATE TABLE local_accounts (
    principal_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_verifier TEXT NOT NULL,
    credential_revision INTEGER NOT NULL CHECK(credential_revision >= 1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0)
  ) STRICT`,
  `CREATE TABLE local_admin_grants (
    principal_id TEXT PRIMARY KEY REFERENCES local_accounts(principal_id),
    granted_at INTEGER NOT NULL CHECK(granted_at >= 0)
  ) STRICT`,
  `CREATE TABLE local_sessions (
    token_hash TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id),
    credential_revision INTEGER NOT NULL CHECK(credential_revision >= 1),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    absolute_expires_at INTEGER NOT NULL CHECK(absolute_expires_at > created_at),
    last_seen_at INTEGER NOT NULL CHECK(last_seen_at >= created_at AND last_seen_at < absolute_expires_at),
    revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at)
  ) STRICT`,
  `CREATE INDEX local_sessions_principal ON local_sessions(principal_id)`,
  `CREATE TABLE local_login_throttle (
    bucket_hash TEXT PRIMARY KEY,
    window_started_at INTEGER NOT NULL CHECK(window_started_at >= 0),
    attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 20)
  ) STRICT`,
  `CREATE TABLE local_auth_events (
    sequence INTEGER PRIMARY KEY,
    principal_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('bootstrap','destination_bootstrap','login','login_denied','session_rotated','password_reset','account_disabled','administrator_revoked')),
    happened_at INTEGER NOT NULL CHECK(happened_at >= 0)
  ) STRICT`,
]);
export const PROTOTYPE_IDENTITY_RECOVERY_CLASSIFICATION = Object.freeze({
  local_identity_installation: 'destination-owned; never grant from imported bootstrap claims',
  local_accounts: 'protected identity/username/verifier/revision material only; restore enabled=0; excluded from research packages',
  local_admin_grants: 'current destination authority; imported grants remain inert',
  local_sessions: 'ephemeral authority; exclude and revoke across recovery',
  local_login_throttle: 'destination-local ephemeral admission',
  local_auth_events: 'protected audit provenance; imported events are not grants',
});
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
export const PROTOTYPE_IDENTITY_SCHEMA_SHA256 = createHash('sha256')
  .update(PROTOTYPE_IDENTITY_STATEMENTS.map(normalize).sort().join('\n')).digest('hex');
export async function assertExactLocalIdentityObjects(database: SqliteCapability): Promise<void> {
  const rows = (await database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name IN ('local_identity_installation','local_accounts','local_admin_grants','local_sessions','local_sessions_principal','local_login_throttle','local_auth_events') ORDER BY name").all()).results;
  if (rows.length !== PROTOTYPE_IDENTITY_STATEMENTS.length || rows.some(row => typeof row.sql !== 'string')) throw new Error('Local identity catalog does not match');
  const digest = createHash('sha256').update(rows.map(row => normalize(row.sql as string)).sort().join('\n')).digest('hex');
  if (digest !== PROTOTYPE_IDENTITY_SCHEMA_SHA256) throw new Error('Local identity catalog does not match');
}
const admitted = new WeakSet<object>();
export interface PrototypeIdentityCatalogAdmission { readonly scope: 'isolated-prototype-only' }

/** Exact catalog admission, including absence of other application tables.
 * There is deliberately no prefix-based omission or archive-provided DDL. */
export async function inspectPrototypeIdentityCatalog(database: SqliteCapability): Promise<PrototypeIdentityCatalogAdmission> {
  const rows = (await database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()).results;
  if (rows.length !== PROTOTYPE_IDENTITY_STATEMENTS.length || rows.some(row => typeof row.sql !== 'string')) throw new Error('Prototype identity catalog does not match');
  const actual = createHash('sha256').update(rows.map(row => normalize(row.sql as string)).sort().join('\n')).digest('hex');
  if (actual !== PROTOTYPE_IDENTITY_SCHEMA_SHA256) throw new Error('Prototype identity catalog does not match');
  const token = Object.freeze({ scope: 'isolated-prototype-only' as const });
  admitted.add(token); return token;
}
export function assertPrototypeIdentityAdmission(admission: PrototypeIdentityCatalogAdmission): void {
  if (!admitted.has(admission)) throw new Error('An inspected isolated prototype identity catalog is required');
}

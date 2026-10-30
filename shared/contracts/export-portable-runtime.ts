import type { ExportJsonArtifact, ExportSchemaObject, FullExportManifestV24 } from "./export";
import { FULL_EXPORT_ARCHIVE_PROFILE_V24, FULL_EXPORT_ARCHIVE_SCHEMA_V24, FULL_EXPORT_ARCHIVE_WRITER } from "./export";
import { createExportArtifact, validateFullExportV24 } from "./export-protocol";
import { contentExportSchemaObjects } from "./storage-configuration-schema";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_LEXICAL_SCHEMA_SHA256, PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS } from "./portable-runtime-recovery-catalog";
import { canonicalFileAuthoritySchemaSql } from "./export-file-authority";
import { sha256Hex, stableJson } from "../domain/content-addressing";

export const PORTABLE_IDENTITY_MIGRATION_NAMES = ["0023_portable_local_identity.sql"] as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V25 = 25 as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V25 = "portable-runtime-local-identity" as const;
export const PORTABLE_RUNTIME_SOURCE_CHECKPOINT_PATH = "artifacts/portable-runtime-checkpoint.json";
export const PORTABLE_IDENTITY_TABLE_NAMES = ["local_identity_installation", "local_accounts", "local_admin_grants",
  "local_sessions", "local_login_throttle", "local_auth_events"] as const;
export interface PortableRuntimeSourceCheckpoint {
  version: 1; kind: "portable-runtime-source-checkpoint"; checkpointId: typeof PORTABLE_RUNTIME_CHECKPOINT_ID;
  applicationSchemaSha256: typeof PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256;
  schemaComparison: "reviewed-sqlite-lexical-tokens/1";
  installationObjects: ExportSchemaObject[];
  identityPolicy: "protected-only-no-research-credentials-or-authority/1";
}
/** V25 pins its actual current physical application schema separately from the
 * frozen V24 business proof. The checkpoint carries only the additional
 * installation objects; their union with the existing observed business schema
 * must match the entire current pin. This avoids duplicating large trigger DDL
 * within the existing backup metadata budget. Account cells and authority never
 * enter content, and observed SQL never supplies a recovery target's DDL. */
export interface FullExportManifestV25 extends Omit<FullExportManifestV24, "schemaVersion" | "archiveProfile" | "artifacts"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V25; archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V25;
  artifacts: FullExportManifestV24["artifacts"] & { portableCheckpoint: ExportJsonArtifact<PortableRuntimeSourceCheckpoint> };
}
/** New explicit negotiation; the historical request/readers keep their exact
 * version inventory. No implicit upgrade can reinterpret an old archive. */
export function supportedPortableExportRequest(url: URL): boolean {
  return [...url.searchParams].length === 2 && url.searchParams.getAll("archiveSchema").length === 1
    && url.searchParams.getAll("archiveWriter").length === 1 && url.searchParams.get("archiveSchema") === "25"
    && url.searchParams.get("archiveWriter") === String(FULL_EXPORT_ARCHIVE_WRITER);
}
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Portable full export rejected: ${reason}`);
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort()), "closed fields");
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** The canonical application pin excludes SQLite-owned objects. Observe and
 * separately qualify their exact inventory too: frozen content fingerprints
 * include SQL-null autoindexes owned by application tables. No observed object
 * is discarded before its fields and reviewed inventory have been checked. */
export async function checkedPortableApplicationSchema(values: readonly ExportSchemaObject[]): Promise<ExportSchemaObject[]> {
  ensure(Array.isArray(values) && values.length <= 2048, "schema inventory");
  const names = new Set<string>();
  const objects = values.map(value => {
    exact(value, ["type", "name", "tableName", "sql"]);
    ensure(typeof value.type === "string" && ["table", "index", "view", "trigger"].includes(value.type) && typeof value.name === "string"
      && value.name.length > 0 && !names.has(value.name) && typeof value.tableName === "string"
      && (value.sql === null || typeof value.sql === "string" && value.sql.length > 0), "schema object");
    names.add(value.name);
    return { type: value.type, name: value.name, tableName: value.tableName, sql: value.sql } as ExportSchemaObject;
  }).sort((left, right) => compare(left.type, right.type) || compare(left.name, right.name));
  const internal = objects.filter(value => value.sql === null || value.name.startsWith("sqlite_"));
  ensure(stableJson(internal) === stableJson(PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS), "current internal schema inventory");
  const canonical = objects.filter(value => value.sql !== null && !value.name.startsWith("sqlite_"));
  // D1's reviewed migration splitter omits SQL comments. The separately pinned
  // lexical object proof admits that presentation without changing raw native
  // installation receipts, quoted SQL bytes, object ownership or internal DDL.
  const lexical = canonical.map(object => ({ ...object, sql: canonicalFileAuthoritySchemaSql(object.sql!) }));
  ensure(await sha256Hex(JSON.stringify(lexical)) === PORTABLE_RUNTIME_RECOVERY_LEXICAL_SCHEMA_SHA256, "current application schema");
  return objects;
}
export function portableBusinessSchema(objects: readonly ExportSchemaObject[]): ExportSchemaObject[] {
  const identity = new Set<string>(PORTABLE_IDENTITY_TABLE_NAMES);
  return contentExportSchemaObjects(objects.filter(object => !identity.has(object.tableName)));
}
export function portableBusinessManifestV24(content: FullExportManifestV25): FullExportManifestV24 {
  const { portableCheckpoint: _checkpoint, ...artifacts } = content.artifacts;
  return { ...content, schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V24, archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V24, artifacts };
}
export async function createFullExportV25(content: FullExportManifestV24, applicationObjects: readonly ExportSchemaObject[]): Promise<FullExportManifestV25> {
  const objects = await checkedPortableApplicationSchema(applicationObjects);
  const contentNames = new Set(content.artifacts.sourceSchema.value.objects.map(object => object.name));
  const value: PortableRuntimeSourceCheckpoint = { version: 1, kind: "portable-runtime-source-checkpoint",
    checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID, applicationSchemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
    schemaComparison: "reviewed-sqlite-lexical-tokens/1",
    installationObjects: objects.filter(object => !contentNames.has(object.name)), identityPolicy: "protected-only-no-research-credentials-or-authority/1" };
  return validateFullExportV25({ ...content, schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V25, archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V25,
    artifacts: { ...content.artifacts, portableCheckpoint: await createExportArtifact(PORTABLE_RUNTIME_SOURCE_CHECKPOINT_PATH, value) } });
}
export async function validateFullExportV25(value: unknown): Promise<FullExportManifestV25> {
  exact(value, ["schemaVersion", "archiveProfile", "archiveWriter", "exportedAt", "tables", "blobs", "excludedOutputs", "relocatedSources", "backupHoldOwner", "artifacts"]);
  ensure(value.schemaVersion === FULL_EXPORT_ARCHIVE_SCHEMA_V25 && value.archiveProfile === FULL_EXPORT_ARCHIVE_PROFILE_V25, "version");
  exact(value.artifacts, ["sourceSchema", "retiredFields", "sourceRowids", "portableCheckpoint"]);
  const checkpoint = value.artifacts.portableCheckpoint;
  exact(checkpoint, ["path", "byteSize", "sha256", "value"]);
  exact(checkpoint.value, ["version", "kind", "checkpointId", "applicationSchemaSha256", "schemaComparison", "installationObjects", "identityPolicy"]);
  const proof = checkpoint.value;
  ensure(proof.version === 1 && proof.kind === "portable-runtime-source-checkpoint" && proof.checkpointId === PORTABLE_RUNTIME_CHECKPOINT_ID
    && proof.applicationSchemaSha256 === PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256
    && proof.schemaComparison === "reviewed-sqlite-lexical-tokens/1"
    && proof.identityPolicy === "protected-only-no-research-credentials-or-authority/1", "checkpoint policy");
  const { portableCheckpoint: _checkpoint, ...artifacts } = value.artifacts;
  const business = await validateFullExportV24({ ...value, schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V24,
    archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V24, artifacts });
  ensure(Array.isArray(proof.installationObjects), "installation schema inventory");
  const objects = await checkedPortableApplicationSchema([...business.artifacts.sourceSchema.value.objects,
    ...proof.installationObjects as ExportSchemaObject[]]);
  ensure(stableJson(business.artifacts.sourceSchema.value.objects) === stableJson(portableBusinessSchema(objects)), "current content projection");
  const contentNames = new Set(business.artifacts.sourceSchema.value.objects.map(object => object.name));
  const expected = await createExportArtifact(PORTABLE_RUNTIME_SOURCE_CHECKPOINT_PATH, { ...proof,
    installationObjects: objects.filter(object => !contentNames.has(object.name)) });
  ensure(stableJson(checkpoint) === stableJson(expected), "checkpoint artifact");
  return { ...business, schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V25, archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V25,
    artifacts: { ...business.artifacts, portableCheckpoint: expected as ExportJsonArtifact<PortableRuntimeSourceCheckpoint> } };
}

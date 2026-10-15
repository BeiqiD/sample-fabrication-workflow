// Inactive separate V28 candidate. All historical envelopes/readers stay unchanged.
import { COLLABORATION_TABLE_NAMES_V28, COLLABORATION_RECOVERY_POLICY_V28 } from "./collaboration-schema-v28";
import type { ExportJsonArtifact, ExportSchemaObject } from "./export";
import { FULL_EXPORT_ARCHIVE_WRITER } from "./export";
import { FULL_EXPORT_ARCHIVE_SCHEMA_V28, FULL_EXPORT_ARCHIVE_PROFILE_V28, validateFullExportBusinessV28, type FullExportBusinessManifestV28 } from "./export-business-v28";
import { LOCAL_PROFILE_HISTORY_TABLE_NAMES, LOCAL_PROFILE_INSTALLATION_TABLE_NAMES } from "./export-local-profiles-v26";
import type { ProtectedLocalHistoryV28 } from "./export-local-file-runtime-v28";
export { FULL_EXPORT_ARCHIVE_SCHEMA_V28, FULL_EXPORT_ARCHIVE_PROFILE_V28 } from "./export-business-v28";
import { createExportArtifact } from "./export-protocol";
import { contentExportSchemaObjects } from "./storage-configuration-schema";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_LEXICAL_SCHEMA_SHA256, PORTABLE_RUNTIME_INTERNAL_SCHEMA_OBJECTS } from "./portable-runtime-v28-recovery-catalog";
import { canonicalFileAuthoritySchemaSql } from "./export-file-authority";
import { sha256Hex, stableJson } from "../domain/content-addressing";

export const PORTABLE_IDENTITY_MIGRATION_NAMES = ["0023_portable_local_identity.sql"] as const;
export const PORTABLE_RUNTIME_SOURCE_CHECKPOINT_PATH = "artifacts/portable-runtime-checkpoint.json";
export const PORTABLE_IDENTITY_TABLE_NAMES = ["local_identity_installation", "local_accounts", "local_admin_grants",
  "local_sessions", "local_login_throttle", "local_auth_events"] as const;
export interface PortableRuntimeSourceCheckpointV28 {
  version: 4; kind: "portable-runtime-source-checkpoint"; checkpointId: typeof PORTABLE_RUNTIME_CHECKPOINT_ID;
  applicationSchemaSha256: typeof PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256;
  schemaComparison: "reviewed-sqlite-lexical-tokens/1";
  installationObjects: ExportSchemaObject[];
  identityPolicy: "protected-only-no-research-credentials-or-authority/1";
  collaborationPolicy: typeof COLLABORATION_RECOVERY_POLICY_V28;
}
/** V28 owns its whole application schema and the explicitly unchanged V26 business proof. The checkpoint carries only the additional
 * installation objects; their union with the existing observed business schema
 * must match the entire current pin. This avoids duplicating large trigger DDL
 * within the existing backup metadata budget. Account cells and authority never
 * enter content, and observed SQL never supplies a recovery target's DDL. */
export interface FullExportManifestV28 extends Omit<FullExportBusinessManifestV28, "schemaVersion" | "archiveProfile" | "artifacts"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V28; archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V28;
  artifacts: FullExportBusinessManifestV28["artifacts"] & { portableCheckpoint: ExportJsonArtifact<PortableRuntimeSourceCheckpointV28> };
}
/** New explicit negotiation; the historical request/readers keep their exact
 * version inventory. No implicit upgrade can reinterpret an old archive. */
export function supportedPortableV28ExportRequest(url: URL): boolean {
  return [...url.searchParams].length === 2 && url.searchParams.getAll("archiveSchema").length === 1
    && url.searchParams.getAll("archiveWriter").length === 1 && url.searchParams.get("archiveSchema") === "28"
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
export async function checkedPortableApplicationSchemaV28(values: readonly ExportSchemaObject[]): Promise<ExportSchemaObject[]> {
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
export function portableBusinessSchemaV28(objects: readonly ExportSchemaObject[]): ExportSchemaObject[] {
  const identity = new Set<string>([...PORTABLE_IDENTITY_TABLE_NAMES, ...LOCAL_PROFILE_HISTORY_TABLE_NAMES, ...LOCAL_PROFILE_INSTALLATION_TABLE_NAMES, ...COLLABORATION_TABLE_NAMES_V28]);
  return contentExportSchemaObjects(objects.filter(object => !identity.has(object.tableName)));
}
export function portableBusinessManifestV28(content: FullExportManifestV28): FullExportBusinessManifestV28 {
  const { portableCheckpoint: _checkpoint, ...artifacts } = content.artifacts;
  return { ...content, artifacts };
}
export async function createFullExportV28(content: FullExportBusinessManifestV28, applicationObjects: readonly ExportSchemaObject[],
  protectedLocalHistory?: ProtectedLocalHistoryV28): Promise<FullExportManifestV28> {
  const objects = await checkedPortableApplicationSchemaV28(applicationObjects);
  const contentNames = new Set(content.artifacts.sourceSchema.value.objects.map(object => object.name));
  const value: PortableRuntimeSourceCheckpointV28 = { version: 4, kind: "portable-runtime-source-checkpoint",
    checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID, applicationSchemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
    schemaComparison: "reviewed-sqlite-lexical-tokens/1",
    installationObjects: objects.filter(object => !contentNames.has(object.name)), identityPolicy: "protected-only-no-research-credentials-or-authority/1", collaborationPolicy: COLLABORATION_RECOVERY_POLICY_V28 };
  return validateFullExportV28({ ...content, schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V28, archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V28,
    artifacts: { ...content.artifacts, portableCheckpoint: await createExportArtifact(PORTABLE_RUNTIME_SOURCE_CHECKPOINT_PATH, value) } }, protectedLocalHistory);
}
/** Whole V5 owners supply only same-image decoded history; the standalone call
 * has no protected history and cannot admit local provider content. This data
 * seam is semantic source evidence, never a runtime grant or provider binding. */
export async function validateFullExportV28(value: unknown, protectedLocalHistory?: ProtectedLocalHistoryV28): Promise<FullExportManifestV28> {
  exact(value, ["schemaVersion", "archiveProfile", "archiveWriter", "exportedAt", "tables", "blobs", "excludedOutputs", "relocatedSources", "backupHoldOwner", "artifacts"]);
  ensure(value.schemaVersion === FULL_EXPORT_ARCHIVE_SCHEMA_V28 && value.archiveProfile === FULL_EXPORT_ARCHIVE_PROFILE_V28, "version");
  exact(value.artifacts, ["sourceSchema", "retiredFields", "sourceRowids", "portableCheckpoint"]);
  const checkpoint = value.artifacts.portableCheckpoint;
  exact(checkpoint, ["path", "byteSize", "sha256", "value"]);
  exact(checkpoint.value, ["version", "kind", "checkpointId", "applicationSchemaSha256", "schemaComparison", "installationObjects", "identityPolicy", "collaborationPolicy"]);
  const proof = checkpoint.value;
  ensure(proof.version === 4 && proof.kind === "portable-runtime-source-checkpoint" && proof.checkpointId === PORTABLE_RUNTIME_CHECKPOINT_ID
    && proof.applicationSchemaSha256 === PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256
    && proof.schemaComparison === "reviewed-sqlite-lexical-tokens/1"
    && proof.identityPolicy === "protected-only-no-research-credentials-or-authority/1"
    && proof.collaborationPolicy === COLLABORATION_RECOVERY_POLICY_V28, "checkpoint policy");
  const { portableCheckpoint: _checkpoint, ...artifacts } = value.artifacts;
  const business = await validateFullExportBusinessV28({ ...value, artifacts }, protectedLocalHistory);
  ensure(Array.isArray(proof.installationObjects), "installation schema inventory");
  const objects = await checkedPortableApplicationSchemaV28([...business.artifacts.sourceSchema.value.objects,
    ...proof.installationObjects as ExportSchemaObject[]]);
  ensure(stableJson(business.artifacts.sourceSchema.value.objects) === stableJson(portableBusinessSchemaV28(objects)), "current content projection");
  const contentNames = new Set(business.artifacts.sourceSchema.value.objects.map(object => object.name));
  const expected = await createExportArtifact(PORTABLE_RUNTIME_SOURCE_CHECKPOINT_PATH, { ...proof,
    installationObjects: objects.filter(object => !contentNames.has(object.name)) });
  ensure(stableJson(checkpoint) === stableJson(expected), "checkpoint artifact");
  return { ...business, schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V28, archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V28,
    artifacts: { ...business.artifacts, portableCheckpoint: expected as ExportJsonArtifact<PortableRuntimeSourceCheckpointV28> } };
}

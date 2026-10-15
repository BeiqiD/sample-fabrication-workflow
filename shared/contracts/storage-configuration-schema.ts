import type { ExportSchemaObject } from "./export";
import { FILE_NATIVE_RUNTIME_LOCAL_TABLES } from "./file-native-runtime";

/** Installation administration is separate from the portable content registry.
 * Ordinary Sample/Project archives carry neither candidates nor credentials. */
export const SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES = [
  "system_storage_profiles",
  "system_storage_credential_descriptors",
  "system_storage_credential_payloads",
  "system_storage_configuration_revisions",
  "system_storage_configuration_audit",
  "system_storage_candidate_checks",
  "system_storage_candidate_check_audit",
  "system_storage_credential_reenvelopes",
  ...FILE_NATIVE_RUNTIME_LOCAL_TABLES,
] as const;
export const SYSTEM_STORAGE_CONFIGURATION_MIGRATION = "0014_fp2_storage_configuration.sql" as const;
export const SYSTEM_STORAGE_CANDIDATE_CHECK_MIGRATION = "0015_fp2_storage_candidate_checks.sql" as const;
export const SYSTEM_STORAGE_CREDENTIAL_REENVELOPE_MIGRATION = "0016_fp2_credential_reenvelopes.sql" as const;
export const SYSTEM_RECOVERY_INSTALLATION_MIGRATION = "0021_fp5_system_recovery.sql" as const;
export const SYSTEM_INSTALLATION_LOCAL_MIGRATIONS = [SYSTEM_STORAGE_CONFIGURATION_MIGRATION, SYSTEM_STORAGE_CANDIDATE_CHECK_MIGRATION,
  SYSTEM_STORAGE_CREDENTIAL_REENVELOPE_MIGRATION, SYSTEM_RECOVERY_INSTALLATION_MIGRATION] as const;
// Preserve the historical reader's import while extending only its explicit
// installation-local exclusion. Its content migration chain and hashes stay frozen.
export const SYSTEM_STORAGE_CONFIGURATION_MIGRATIONS = SYSTEM_INSTALLATION_LOCAL_MIGRATIONS;
const systemTables = new Set<string>(SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES);

/** The FP5 executor is installation local. Only this reviewed closed inventory
 * is omitted; an unknown table with a similar prefix remains visible and fails
 * the ordinary content-schema qualification. */
export const SYSTEM_RECOVERY_LOCAL_TABLE_NAMES = [
  "system_recovery_runtime", "system_recovery_jobs", "system_recovery_requests",
  "system_recovery_metadata_chunks", "system_recovery_files", "system_recovery_attempts",
  "system_recovery_target_claim", "system_recovery_maintenance", "system_recovery_write_leases",
  "system_recovery_legacy_holds", "system_recovery_maintenance_requests",
  "system_recovery_target_provenance", "system_recovery_target_files",
] as const;
export const INSTALLATION_LOCAL_CONFIGURATION_TABLE_NAMES = [
  ...SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES, ...SYSTEM_RECOVERY_LOCAL_TABLE_NAMES,
] as const;
const recoveryTables = new Set<string>(SYSTEM_RECOVERY_LOCAL_TABLE_NAMES);

/** The V19 content schema stays frozen. Omit only explicitly classified system
 * tables and their owned indexes/triggers; unknown application objects remain
 * visible to the historical fingerprint and therefore cannot disappear. */
export function contentExportSchemaObjects(objects: ExportSchemaObject[]) {
  return objects.filter((object) => !systemTables.has(object.tableName) && !recoveryTables.has(object.tableName));
}

import type { ExportSchemaObject } from "./export";

/** Installation administration is separate from the portable content registry.
 * Ordinary Sample/Project archives carry neither candidates nor credentials. */
export const SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES = [
  "system_storage_profiles",
  "system_storage_credential_descriptors",
  "system_storage_credential_payloads",
  "system_storage_configuration_revisions",
  "system_storage_configuration_audit",
] as const;
export const SYSTEM_STORAGE_CONFIGURATION_MIGRATION = "0014_fp2_storage_configuration.sql" as const;
const systemTables = new Set<string>(SYSTEM_STORAGE_CONFIGURATION_TABLE_NAMES);

/** The V19 content schema stays frozen. Omit only explicitly classified system
 * tables and their owned indexes/triggers; unknown application objects remain
 * visible to the historical fingerprint and therefore cannot disappear. */
export function contentExportSchemaObjects(objects: ExportSchemaObject[]) {
  return objects.filter((object) => !systemTables.has(object.tableName));
}

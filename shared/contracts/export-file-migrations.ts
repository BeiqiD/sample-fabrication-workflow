import type { ExportTables, ExportSchemaObject, FileShadowSourceRowids } from "./export";
import { fileShadowSchemaFingerprint } from "./export-file-shadow";
import { validateFileNativeReferences } from "./export-file-native-references";
import { validateFileNativeRuntimeExport } from "./export-file-native-runtime";
import { validateFileJobHistory } from "./export-file-jobs";

export const FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256 = "4a918e94af5c19554da453e4ef39b93aa353371d85ed9af01f62f2ee6b1f0f40";

/** Only V22 recognizes independent migration verification. A V21 archive has
 * no migration histories and retains its exact accepted-location contract. */
export async function validateFileMigrationExport(tables: ExportTables, schema: ExportSchemaObject[], sourceRowids?: FileShadowSourceRowids, snapshotClock?: string) {
  if (await fileShadowSchemaFingerprint(schema) !== FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256)
    throw new Error("Full export rejected: File migration schema fingerprint");
  validateFileNativeReferences(tables, schema);
  const history = validateFileJobHistory(tables);
  await validateFileNativeRuntimeExport(tables, schema, sourceRowids, { schemaSha256: FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256, ...history }, snapshotClock);
}

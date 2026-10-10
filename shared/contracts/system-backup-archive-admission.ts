import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "./system-recovery-catalog";
import { validateSystemBackupDocuments } from "./system-backup";
import { systemBackupArchiveMetadata } from "../domain/system-backup-archive";
import { validateStoreArchive, type ArchiveSource, type ArchiveOptions } from "../domain/research-archive";

/** Shared full STORE/CRC/SHA and closed document admission. Uploaded report
 * markup is compared with regenerated inert presentation, never executed. */
export async function validateSystemBackupArchive(source: ArchiveSource, options: ArchiveOptions & { expectedSha256: string }) {
  let documents: Awaited<ReturnType<typeof validateSystemBackupDocuments>> | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const validated = await validateStoreArchive(source, { ...options, expectedEntries: async metadata => {
    const read = (path: string) => {
      const bytes = metadata.get(path); if (!bytes) throw new Error("system_backup_metadata_inventory");
      return JSON.parse(decoder.decode(bytes));
    };
    documents = await validateSystemBackupDocuments(read("manifest.json"), read("records.json"), { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES });
    return (await systemBackupArchiveMetadata(documents.manifest, documents.records, documents.manifest)).entries;
  } });
  if (!documents) throw new Error("system_backup_metadata_inventory");
  return { ...documents, byteSize: validated.byteSize, sha256: validated.sha256, entries: validated.entries };
}

import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "./system-recovery-catalog";
import { validateSystemBackupDocuments } from "./system-backup";
import { validateSystemBackupDocumentsV2 } from "./system-backup-v2";
import { systemBackupArchiveMetadata } from "../domain/system-backup-archive";
import { validateStoreArchive, type ArchiveSource, type ArchiveOptions } from "../domain/research-archive";

type DocumentsV1 = { format: "v1" } & Awaited<ReturnType<typeof validateSystemBackupDocuments>>;
type DocumentsV2 = { format: "v2" } & Awaited<ReturnType<typeof validateSystemBackupDocumentsV2>>;
/** V1 always uses its frozen V24/image1 catalog. V2 admits only the separately
 * code-owned V25/image2 catalog and explicit inert identity recovery policy. */
export async function validateVersionedSystemBackupArchive(source: ArchiveSource, options: ArchiveOptions & { expectedSha256: string }) {
  let documents: DocumentsV1 | DocumentsV2 | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const validated = await validateStoreArchive(source, { ...options, expectedEntries: async metadata => {
    const read = (path: string) => {
      const bytes = metadata.get(path); if (!bytes) throw new Error("system_backup_metadata_inventory");
      return JSON.parse(decoder.decode(bytes)) as unknown;
    };
    const manifest = read("manifest.json"), records = read("records.json");
    const schema = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>).schema : undefined;
    if (schema === "system-backup/1") documents = { format: "v1", ...await validateSystemBackupDocuments(manifest, records,
      { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: RECOVERY_TABLES }) };
    else if (schema === "system-backup/2") documents = { format: "v2", ...await validateSystemBackupDocumentsV2(manifest, records) };
    else throw new Error("system_backup_version_unsupported");
    return (await systemBackupArchiveMetadata(documents.manifest, documents.records, documents.manifest)).entries;
  } });
  if (!documents) throw new Error("system_backup_metadata_inventory");
  return { ...documents, byteSize: validated.byteSize, sha256: validated.sha256, entries: validated.entries };
}

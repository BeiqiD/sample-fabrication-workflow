// SOURCE-ONLY V28/image5 archive reader. The historical versioned dispatcher is unchanged.
import { validateSystemBackupDocumentsV5 } from "./system-backup-v5";
import { systemBackupArchiveMetadata } from "../domain/system-backup-archive";
import { validateStoreArchive, type ArchiveSource, type ArchiveOptions } from "../domain/research-archive";
export async function validateV28SystemBackupArchiveCandidate(source: ArchiveSource,
  options: ArchiveOptions & { expectedSha256: string }) {
  let documents: Awaited<ReturnType<typeof validateSystemBackupDocumentsV5>> | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const validated = await validateStoreArchive(source, { ...options, expectedEntries: async metadata => {
    const read = (path: string) => {
      const bytes = metadata.get(path); if (!bytes) throw new Error("system_backup_metadata_inventory");
      return JSON.parse(decoder.decode(bytes)) as unknown;
    };
    documents = await validateSystemBackupDocumentsV5(read("manifest.json"), read("records.json"));
    return (await systemBackupArchiveMetadata(documents.manifest, documents.records, documents.manifest)).entries;
  } });
  if (!documents) throw new Error("system_backup_metadata_inventory");
  return { format: "v5" as const, ...documents, byteSize: validated.byteSize, sha256: validated.sha256, entries: validated.entries };
}

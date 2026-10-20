// Explicit SOURCE-only V5 ZIP admission. No historical/default dispatcher imports this module.
import { validateSystemBackupDocumentsV5, type SystemBackupManifestV5, type SystemBackupRecordsV5 } from "./system-backup-v5";
import { systemBackupArchiveMetadata } from "../domain/system-backup-archive";
import { validateStoreArchive, type ArchiveSource, type ArchiveOptions, type ArchiveIndexEntry } from "../domain/research-archive";

export interface AdmittedV5SystemBackupArchiveCandidate {
  format: "v5";
  manifest: SystemBackupManifestV5;
  records: SystemBackupRecordsV5;
  byteSize: number;
  sha256: string;
  entries: ArchiveIndexEntry[];
}

/** Validate the complete ZIP, its original V5 documents and every promised
 * member hash. This reader neither opens an original provider nor admits a
 * destination. A partial archive remains valid forensic input; a constructor
 * must independently require complete recovery before creating a target. The
 * outer owner retains custody of this source and its cleanup. */
export async function admitV5SystemBackupArchiveCandidate(source: ArchiveSource,
  options: ArchiveOptions & { expectedSha256: string }): Promise<AdmittedV5SystemBackupArchiveCandidate> {
  let documents: Awaited<ReturnType<typeof validateSystemBackupDocumentsV5>> | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const validated = await validateStoreArchive(source, { ...options, expectedEntries: async metadata => {
    const read = (path: string): unknown => {
      const bytes = metadata.get(path);
      if (!bytes) throw new Error("v5_archive_candidate_metadata_inventory");
      return JSON.parse(decoder.decode(bytes)) as unknown;
    };
    documents = await validateSystemBackupDocumentsV5(read("manifest.json"), read("records.json"));
    return (await systemBackupArchiveMetadata(documents.manifest, documents.records, documents.manifest)).entries;
  } });
  if (!documents) throw new Error("v5_archive_candidate_metadata_inventory");
  return { format: "v5", ...documents, byteSize: validated.byteSize, sha256: validated.sha256, entries: validated.entries };
}

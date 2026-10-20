import { validateSystemBackupDocumentsV5 } from "./system-backup-v5";
import { validateSystemBackupDocumentsV3 } from "./system-backup-v3";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_TABLES } from "./system-recovery-catalog";
import { validateSystemBackupDocuments } from "./system-backup";
import { validateSystemBackupDocumentsV2 } from "./system-backup-v2";
import { systemBackupArchiveMetadata } from "../domain/system-backup-archive";
import { validateStoreArchive, type ArchiveSource, type ArchiveOptions } from "../domain/research-archive";

type DocumentsV1 = { format: "v1" } & Awaited<ReturnType<typeof validateSystemBackupDocuments>>;
type DocumentsV3 = { format: "v3" } & Awaited<ReturnType<typeof validateSystemBackupDocumentsV3>>;
type DocumentsV5 = { format: "v5" } & Awaited<ReturnType<typeof validateSystemBackupDocumentsV5>>;
type DocumentsV2 = { format: "v2" } & Awaited<ReturnType<typeof validateSystemBackupDocumentsV2>>;
/** V1 always uses its frozen V24/image1 catalog. V2 admits only the separately
 * code-owned V25/image2 catalog; V3 admits only V26/image3 with protected
 * histories and empty destination bindings. Unknown tuples remain closed. */
async function validateOriginalSystemBackupArchive(source: ArchiveSource, options: ArchiveOptions & { expectedSha256: string }, workerV5: boolean) {
  let documents: DocumentsV1 | DocumentsV2 | DocumentsV3 | DocumentsV5 | undefined;
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
    else if (schema === "system-backup/3") documents = { format: "v3", ...await validateSystemBackupDocumentsV3(manifest, records) };
    else if (workerV5 && schema === "system-backup/5") documents = { format: "v5", ...await validateSystemBackupDocumentsV5(manifest, records) };
    else throw new Error("system_backup_version_unsupported");
    return (await systemBackupArchiveMetadata(documents.manifest, documents.records, documents.manifest)).entries;
  } });
  if (!documents) throw new Error("system_backup_metadata_inventory");
  return { ...documents, byteSize: validated.byteSize, sha256: validated.sha256, entries: validated.entries };
}

/** Default historical caller retains its exact V1–3 return/admission contract. */
export async function validateVersionedSystemBackupArchive(source: ArchiveSource, options: ArchiveOptions & { expectedSha256: string }) {
  const result = await validateOriginalSystemBackupArchive(source, options, false);
  if (result.format === "v5") throw new Error("system_backup_version_unsupported");
  return result;
}
/** Fixed Worker public lane additionally admits the complete code-owned V5 ZIP. */
export async function validateWorkerSystemBackupArchive(source: ArchiveSource, options: ArchiveOptions & { expectedSha256: string }) {
  return validateOriginalSystemBackupArchive(source, options, true);
}

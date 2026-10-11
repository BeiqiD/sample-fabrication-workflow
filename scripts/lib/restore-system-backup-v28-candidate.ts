// Explicit candidate V28 reader/target only; no CLI, default dispatcher or deployment selects it.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { restorePortableV28CandidateSystemBackupIntoDirectory } from "../../server/recovery/restore-v28-candidate";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission";
import { SYSTEM_BACKUP_MAX_ARCHIVE_BYTES } from "../../shared/contracts/system-backup";
import { openStoreArchiveEntry } from "../../shared/domain/research-archive";
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource, nodeRecoveryFileSha256, writePrivateRecoveryStream } from "./system-backup-node-io";
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`SOURCE-ONLY V28 offline recovery rejected: ${reason}`);
}
/** Own one newly created private directory, freeze the bounded ZIP before admission,
 * and preserve a failed target for diagnosis. Uploaded SQL never selects target DDL.
 * No source membership, identity mapping, root policy or grant row is imported. */
export async function restoreV28SystemBackupToIsolatedDirectoryCandidate(options: {
  archivePath: string; destination: string; expectedSha256: string;
}) {
  const destination = resolve(options.destination), inputSource = await nodeRecoveryArchiveSource(resolve(options.archivePath));
  ensure(inputSource.byteSize <= SYSTEM_BACKUP_MAX_ARCHIVE_BYTES, "archive_budget");
  await mkdir(destination, { mode: 0o700 }); // Refuse preexisting destinations; never remove another owner's path.
  const originalArchivePath = join(destination, "original-archive.zip");
  await writePrivateRecoveryStream(originalArchivePath, await inputSource.open!(0, inputSource.byteSize));
  const source = await nodeRecoveryArchiveSource(originalArchivePath), sourceHash = await nodeRecoveryFileSha256(originalArchivePath);
  ensure(sourceHash.byteSize === inputSource.byteSize && options.expectedSha256 === sourceHash.sha256, "archive_sha256");
  const admitted = await validateV28SystemBackupArchiveCandidate(source, { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: sourceHash.sha256 });
  ensure(admitted.manifest.completeness === "complete", "partial_backup_not_complete_recovery");
  await mkdir(join(destination, "files"), { mode: 0o700 }); await mkdir(join(destination, "metadata"), { mode: 0o700 });
  await mkdir(join(destination, "report"), { mode: 0o700 });
  for (const entry of admitted.entries) {
    const path = join(destination, entry.kind === "metadata" ? `metadata/${entry.path}` : entry.path);
    await writePrivateRecoveryStream(path, await openStoreArchiveEntry(source, entry, NODE_RECOVERY_ARCHIVE_OPTIONS));
  }
  ensure((await nodeRecoveryFileSha256(originalArchivePath)).sha256 === admitted.sha256, "retained_original_archive_changed");
  return restorePortableV28CandidateSystemBackupIntoDirectory({ directory: destination, archiveSha256: admitted.sha256,
    manifest: admitted.manifest, records: admitted.records });
}

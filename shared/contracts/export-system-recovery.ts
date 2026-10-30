import type { FullExportManifestV24 } from "./export";
import { stableJson } from "../domain/content-addressing";
import { fileShadowSchemaFingerprint } from "./export-file-shadow";
import { validateFileJobHistory } from "./export-file-jobs";
import { FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-migrations";
import { RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256, validateResearchPackageHistory } from "./export-research-packages";
import { researchImportedPreviewEvidence, researchNativeR2AssetEvidence } from "./export-research-preview-provenance";
import { buildSystemRecoveryBlobExportPlan, SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256,
  validateSystemRecoveryEvidenceHistory } from "./export-system-recovery-evidence";
import { validateSystemRecoveryNativeRuntimeExport } from "./export-file-system-recovery-runtime";

export { buildSystemRecoveryBlobExportPlan } from "./export-system-recovery-evidence";
export const SYSTEM_RECOVERY_SCHEMA_FINGERPRINT_SHA256 = SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256;
export async function validateSystemRecoveryExport(manifest: FullExportManifestV24) {
  const schema = manifest.artifacts.sourceSchema.value;
  if (manifest.backupHoldOwner !== null && (typeof manifest.backupHoldOwner !== "string" || manifest.backupHoldOwner.length < 1 || manifest.backupHoldOwner.length > 128 || manifest.backupHoldOwner.includes("\0")))
    throw new Error("Full export rejected: invalid system backup hold owner");
  if (await fileShadowSchemaFingerprint(schema.objects) !== SYSTEM_RECOVERY_SCHEMA_FINGERPRINT_SHA256) throw new Error("Full export rejected: invalid system recovery schema fingerprint");
  const packages = validateResearchPackageHistory(manifest.tables), migrations = validateFileJobHistory(manifest.tables);
  const recovery = validateSystemRecoveryEvidenceHistory(manifest.tables);
  if (!Array.isArray(manifest.excludedOutputs) || stableJson(manifest.excludedOutputs) !== stableJson(buildSystemRecoveryBlobExportPlan(manifest.tables, schema.snapshotClock, manifest.backupHoldOwner).excludedOutputs))
    throw new Error("Full export rejected: invalid system recovery disposable output inventory");
  if (!Array.isArray(manifest.relocatedSources) || stableJson(manifest.relocatedSources) !== stableJson(buildSystemRecoveryBlobExportPlan(manifest.tables, schema.snapshotClock, manifest.backupHoldOwner).relocatedSources))
    throw new Error("Full export rejected: invalid system recovery relocated source inventory");
  const imported = researchImportedPreviewEvidence(manifest.tables), aliases = researchNativeR2AssetEvidence(manifest.tables);
  await validateSystemRecoveryNativeRuntimeExport(manifest.tables, schema.objects, manifest.artifacts.sourceRowids.value, {
    schemaSha256: SYSTEM_RECOVERY_SCHEMA_FINGERPRINT_SHA256,
    publishedLocations: new Set([...migrations.publishedLocations, ...packages.publishedLocations, ...recovery.publishedLocations]),
    historicalResultLocation: (fileId, source, destination) => migrations.historicalResultLocation(fileId, source, destination)
      || recovery.historicalResultLocation(fileId, source, destination),
    importedPreviewEvidence: (table, row, column) => imported(table, row, column) || recovery.importedPreviewEvidence(table, row, column),
    packageR2AssetEvidence: asset => aliases(asset) || recovery.packageR2AssetEvidence(asset),
    recoveredAliasEvidence: recovery.recoveredAliasEvidence,
    historicalSchemaSha256s: [FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256, RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256],
  }, schema.snapshotClock);
}

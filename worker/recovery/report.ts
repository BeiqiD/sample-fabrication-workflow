import { stableJson, sha256Hex } from "../../shared/domain/content-addressing";
import type { SystemBackupManifestV1, SystemBackupRecordsV1 } from "../../shared/contracts/system-backup";
import type { SystemRecoveryCell } from "../../shared/contracts/system-recovery-image";
import { recoveryProtectedSettingsReport, recoveryImageTableRows } from "./protected-settings";

export interface RecoveryCellDifference {
  table: string; row: string; column: string; before: SystemRecoveryCell | null;
  after: SystemRecoveryCell | null; reason: "destination_mapping" | "file_binding" | "authority_conversion" | "derived_reconstruction";
}
export interface SystemRecoveryReport {
  schema: "system-recovery-report/1"; targetId: string; jobId: string; incarnation: string;
  recoveryPoint: string; historicalLaterChangesLost: boolean; mode: "historical" | "planned";
  sourceImageSha256: string; targetCheckpoint: string; verified: true;
  counts: { tables: number; originalRows: number; files: number; bytes: number; auditedCellDifferences: number };
  protectedSettings: ReturnType<typeof recoveryProtectedSettingsReport>;
  execution: { shadow: false; authority: false; fileJobs: false; recoveryJobs: false; cleanup: false; oldJobReplay: false };
  differences: RecoveryCellDifference[];
  deploymentCutover: { automaticBindingChange: false; operatorRequired: true; steps: string[];
    rollback: "safe_before_target_writes_only"; sourceRetainedReadOnly: true };
}
export async function createSystemRecoveryReport(input: {
  targetId: string; jobId: string; incarnation: string; manifest: SystemBackupManifestV1; records: SystemBackupRecordsV1;
  mode: "historical" | "planned"; differences: RecoveryCellDifference[]; targetProof: unknown;
}): Promise<SystemRecoveryReport> {
  const sourceImageSha256 = await sha256Hex(stableJson(input.records.image));
  return { schema: "system-recovery-report/1", targetId: input.targetId, jobId: input.jobId, incarnation: input.incarnation,
    recoveryPoint: input.records.image.sourceSnapshotClock, mode: input.mode,
    historicalLaterChangesLost: input.mode === "historical", sourceImageSha256,
    targetCheckpoint: await sha256Hex(stableJson({ targetId: input.targetId, incarnation: input.incarnation,
      sourceImageSha256, targetProof: input.targetProof })), verified: true,
    counts: { tables: Object.keys(input.records.image.tables).length, originalRows: recoveryImageTableRows(input.records.image),
      files: input.manifest.files.length, bytes: input.manifest.counts.bytes, auditedCellDifferences: input.differences.length },
    protectedSettings: recoveryProtectedSettingsReport(input.records),
    execution: { shadow: false, authority: false, fileJobs: false, recoveryJobs: false, cleanup: false, oldJobReplay: false },
    differences: input.differences,
    deploymentCutover: { automaticBindingChange: false, operatorRequired: true,
      steps: ["Keep the source write fence and old background executors stopped.",
        "Compare the approved target identity and verified recovery checkpoint with this report.",
        "Provision target provider bindings and review encrypted settings with separately supplied root keys; use fresh credential admission.",
        "Review and activate the Worker D1 binding to this isolated target; retain the old source read-only.",
        "Check authenticated Sample and Project reads before explicitly enabling destination writes.",
        "Resume only reviewed new jobs; archived migration, deletion and cleanup records remain provenance."],
      rollback: "safe_before_target_writes_only", sourceRetainedReadOnly: true } };
}

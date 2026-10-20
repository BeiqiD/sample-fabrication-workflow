import { checkedResearchJobStatus, type ResearchJobStatus } from "../../../shared/contracts/research-package-api";
import type { PackageFile, PackageJob, PackageStatus } from "./types";

/** One bounded row per job, without loading its file inventory or frozen plan. */
export interface PackageStatusProjection extends Pick<PackageJob, "id" | "request_id" | "kind" | "state" | "phase"
  | "accepted_at" | "updated_at" | "reason" | "package_id" | "result_json" | "expires_at"> {
  files_total: number;
  files_verified: number;
  bytes_total: number;
  bytes_verified: number;
  all_files_total: number;
  all_files_verified: number;
  all_bytes_total: number;
  all_bytes_verified: number;
  output_state: PackageFile["state"] | null;
  output_byte_size: number | null;
  output_sha256: string | null;
  output_retained: number;
}

export function packageRepositoryStatus(row: PackageStatusProjection): PackageStatus {
  return { id: row.id, requestId: row.request_id, kind: row.kind, state: row.state, phase: row.phase,
    acceptedAt: row.accepted_at, updatedAt: row.updated_at, reason: row.reason, packageId: row.package_id,
    filesTotal: row.files_total, filesVerified: row.files_verified, bytesTotal: row.bytes_total,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    downloadUrl: row.output_state === "published" && row.kind !== "upload" && row.state === "completed"
      ? `/api/packages/jobs/${row.id}/download` : null, expiresAt: row.expires_at };
}

export function publicPackageStatus(row: PackageStatusProjection, now = Date.now()): ResearchJobStatus {
  const upload = row.kind === "upload";
  const measured = ["write", "done"].includes(row.phase) && (row.kind === "data_package" || row.kind === "report");
  const totalFiles = upload ? row.all_files_total : row.files_total;
  const bytesTotal = upload ? row.all_bytes_total : row.bytes_total;
  return checkedResearchJobStatus({ id: row.id, requestId: row.request_id, kind: row.kind, state: row.state, phase: row.phase,
    acceptedAt: row.accepted_at, updatedAt: row.updated_at, reason: row.reason,
    progress: { totalFiles, bytesTotal,
      completedFiles: measured ? totalFiles : upload ? row.all_files_verified : row.files_verified,
      bytesDone: measured ? bytesTotal : upload ? row.all_bytes_verified : row.bytes_verified },
    output: row.output_state !== null && row.expires_at ? {
      available: row.output_retained === 1 && row.output_state === "published" && row.state === "completed"
        && Date.parse(row.expires_at) > now,
      byteSize: row.output_byte_size, sha256: row.output_sha256, expiresAt: row.expires_at,
    } : null,
    result: row.result_json ? JSON.parse(row.result_json) : null });
}

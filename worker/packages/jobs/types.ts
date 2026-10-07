import type { FilePurpose } from "../../../shared/contracts/files";
import type { JobSqlDatabase, JobSqlStatement } from "../../files/jobs/sql-repository";
import type { JobBoundStorage } from "../../files/jobs/types";

export type PackageKind = "data_package" | "report" | "upload" | "import";
export type PackageState = "awaiting_upload" | "queued" | "running" | "preview" | "paused" | "cancel_requested" | "completed" | "cancelled";
export interface PackageRoot { kind: "sample" | "project"; id: string }
export interface FrozenPackageTarget { profileId: string; configurationRevision: 1; namespaceIdentity: string; policyRevision: number }
export type PackageTargets = Readonly<Record<FilePurpose, FrozenPackageTarget>>;
export interface PackageJob {
  id: string; request_id: string; actor: string; kind: PackageKind; input_json: string;
  package_id: string; source_installation_id: string; source_upload_job_id: string | null;
  package_digest: string | null; copy_identity: string | null; accepted_at: string;
  target_policy_json: string; domain_plan_json: string | null; frozen_archive_json: string | null;
  state: PackageState; phase: string; generation: number; owner_token: string | null;
  runtime_incarnation: string | null; lease_expires_at: string | null; updated_at: string;
  actor_checked_at: string | null; result_json: string | null; reason: string | null; expires_at: string | null;
}
export interface PackageClaim extends PackageJob { owner_token: string; runtime_incarnation: string; lease_expires_at: string }
export interface PackageFile {
  job_id: string; logical_file_id: string; entry_kind: "source" | "payload" | "artifact";
  purpose: FilePurpose; byte_size: number; sha256: string; archive_path: string; media_type: string;
  alias_original_name:string|null;alias_created_at:string|null;
  source_file_id: string | null; source_location_id: string | null; source_profile_id: string | null;
  source_alias_id: string | null;
  source_profile_revision: number | null; source_namespace: string | null; source_object_key: string | null;
  hold_operation_id: string; target_profile_id: string | null; target_profile_revision: number | null;
  target_namespace: string | null; target_policy_revision: number | null; candidate_file_id: string | null;
  candidate_asset_id: string | null; archive_entry_json: string | null;
  reuse_file_id: string | null; reuse_location_id: string | null; reuse_asset_id: string | null;
  state: "pending" | "copying" | "verified" | "published" | "failed" | "cancelled";
  result_file_id: string | null; result_location_id: string | null; updated_at: string; reason: string | null;
}
export interface PackageAttempt {
  id: string; job_id: string; logical_file_id: string; file_id: string; location_id: string;
  object_key: string; owner_token: string; generation: number; runtime_incarnation: string;
  state: "staged" | "write_started" | "unknown" | "verified" | "published" | "failed" | "cancelled";
  created_at: string; write_started_at: string | null; io_settled_at: string | null;
  verified_byte_size: number | null; verified_sha256: string | null;
}
export interface PackageStatus {
  id: string; requestId: string; kind: PackageKind; state: PackageState; phase: string;
  acceptedAt: string; updatedAt: string; reason: string | null; packageId: string;
  filesTotal: number; filesVerified: number; bytesTotal: number; result: unknown | null;
  downloadUrl: string | null; expiresAt: string | null;
}
export interface PackageRecord { record_kind: string; source_id: string; record_json: string; ordinal: number }
export interface PackageRepository {
  database: JobSqlDatabase;
  claim(incarnation: string, owner: string, authorize: (actor: string) => boolean): Promise<PackageClaim | null>;
  owns(claim: PackageClaim): Promise<boolean>;
  guard(db: JobSqlDatabase, claim: PackageClaim): JobSqlStatement;
  job(id: string): Promise<PackageJob | null>;
  status(id: string, actor: string): Promise<PackageStatus | null>;
  files(id: string): Promise<PackageFile[]>;
  records(id: string): Promise<PackageRecord[]>;
  attempt(file: PackageFile): Promise<PackageAttempt | null>;
  stage(claim: PackageClaim, file: PackageFile): Promise<PackageAttempt>;
  startWrite(claim: PackageClaim, attempt: PackageAttempt): Promise<void>;
  settled(attempt: PackageAttempt): Promise<void>;
  verify(claim: PackageClaim, file: PackageFile, attempt: PackageAttempt): Promise<void>;
  checkpoint(claim: PackageClaim, phase: string, values?: { archive?: unknown; result?: unknown }): Promise<void>;
  pause(claim: PackageClaim, reason: string, attempt?: PackageAttempt | null): Promise<void>;
  addOutput(claim: PackageClaim, expectation: {byteSize:number;sha256:string}): Promise<void>;
  publishFile(claim: PackageClaim, file: PackageFile, attempt: PackageAttempt): Promise<void>;
  publish(claim: PackageClaim, domainStatements?: readonly JobSqlStatement[], result?: unknown): Promise<void>;
}
export interface PackageCapabilities {
  repository: PackageRepository;
  incarnation: string;
  authorizeActor(actor: string): boolean;
  now(): Date;
  randomId(): string;
  openStorage(target: { profileId: string; configurationRevision: number }, access: "read" | "write",
    beforeRequest: (operation: Readonly<{ method: "GET" | "HEAD" | "PUT" | "DELETE"; key: string }>) => Promise<boolean>,
    signal: AbortSignal): Promise<JobBoundStorage>;
  /** Format/domain capabilities are shared by Worker and future runtimes. */
  measureExport(claim: PackageClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<unknown>;
  exportBody(claim: PackageClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  validateUpload(claim: PackageClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<unknown>;
  importBody(claim: PackageClaim, file: PackageFile, current: () => Promise<boolean>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  importPublication(claim: PackageClaim): Promise<{ statements: readonly JobSqlStatement[]; result: unknown }>;
}

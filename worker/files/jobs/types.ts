import type { FileJobStatus, FileJobTarget, AcceptFileMigrationInput, FileMigrationPlan, FileJobExecutorStatus, FileMigrationInventory, FileMigrationItems } from "../../../shared/contracts/file-jobs";
import type { ByteReader } from "../byte-reader";
import type { ByteWriter } from "../byte-writer";
import type { Sha256Factory } from "../byte-verification";

export interface JobClaim {
  id: string; actor: string; target_profile_id: string; target_configuration_revision: number;
  target_namespace: string; owner_token: string; generation: number; runtime_incarnation: string;
}
export interface MigrationItem {
  job_id: string; file_id: string; source_location_id: string; source_profile_id: string;
  source_configuration_revision: number; source_namespace: string; source_object_key: string;
  byte_size: number; sha256: string; hold_operation_id: string; state: string;
}
export interface MigrationAttempt {
  id: string; location_id: string; object_key: string; state: string;
  owner_token: string; generation: number; runtime_incarnation: string; io_settled_at: string | null;
}
export interface MigrationCleanupCopy {
  job_id: string; file_id: string; source_location_id: string; hold_operation_id: string;
  active_location_id: string; profile_id: string; configuration_revision: number;
  object_key: string; byte_size: number; sha256: string; verification_hold_id: string;
}
export interface MigrationCleanupArtifact extends MigrationAttempt {
  job_id: string; file_id: string; profile_id: string; configuration_revision: number;
  namespace_identity: string; byte_size: number; sha256: string; hold_operation_id: string;
}
export interface FileJobRepository {
  plan(input: AcceptFileMigrationInput): Promise<FileMigrationPlan>;
  accept(input: AcceptFileMigrationInput, actor: string, authorize?: () => boolean): Promise<FileJobStatus>;
  claim(incarnation: string, owner: string, authorize: (actor: string) => boolean): Promise<JobClaim | null>;
  owns(claim: JobClaim): Promise<boolean>;
  nextItem(claim: JobClaim): Promise<MigrationItem | null>;
  attempt(item: MigrationItem): Promise<MigrationAttempt | null>;
  stage(claim: JobClaim, item: MigrationItem): Promise<MigrationAttempt>;
  startWrite(claim: JobClaim, attempt: MigrationAttempt): Promise<void>;
  observeSettled(attempt: MigrationAttempt): Promise<void>;
  verify(claim: JobClaim, item: MigrationItem, attempt: MigrationAttempt): Promise<void>;
  cutover(claim: JobClaim, item: MigrationItem, attempt: MigrationAttempt): Promise<boolean>;
  fail(claim: JobClaim, item: MigrationItem, attempt: MigrationAttempt | null, reason: string): Promise<void>;
  pause(claim: JobClaim, reason: string): Promise<void>;
  release(claim: JobClaim): Promise<void>;
  heartbeat(incarnation: string): Promise<void>;
  status(id: string): Promise<FileJobStatus | null>;
  list(): Promise<FileJobStatus[]>;
  executorStatus(): Promise<FileJobExecutorStatus>;
  control(id: string, action: "pause" | "resume" | "cancel" | "retry"): Promise<FileJobStatus>;
  requestCleanup(id: string, actor: string, authorize?: () => boolean): Promise<FileJobStatus>;
  cleanupCopy(incarnation: string): Promise<MigrationCleanupCopy | null>;
  releaseCleanup(copy: MigrationCleanupCopy, incarnation: string): Promise<boolean>;
  releaseVerificationHold(copy: MigrationCleanupCopy): Promise<void>;
  inventory(input: { profileId?: string; cursor?: string; limit: number }): Promise<FileMigrationInventory>;
  items(id: string, cursor?: string): Promise<FileMigrationItems>;
  cleanupArtifact(incarnation: string): Promise<MigrationCleanupArtifact | null>;
  releaseArtifact(artifact: MigrationCleanupArtifact, incarnation: string): Promise<void>;
  runtimeEnabled(incarnation: string): Promise<boolean>;
  cleanupGranted(jobId: string, incarnation: string): Promise<boolean>;
  releaseUnneededSource(incarnation: string): Promise<boolean>;
}
export interface JobBoundStorage {
  namespaceIdentity: string; adapterType: "r2" | "switchdrive" | "s3";
  reader: ByteReader; writer?: ByteWriter; createHash: Sha256Factory;
  /** Unique single PUT is atomically visible only after its completed commit.
   * Required to reconcile unknown writes without original positive settlement. */
  atomicSinglePut: boolean;
}
export interface FileJobCapabilities {
  repository: FileJobRepository;
  openStorage(target: FileJobTarget, access: "read" | "write",
    beforeRequest: (operation: Readonly<{ method: "GET" | "HEAD" | "PUT" | "DELETE"; key: string }>) => Promise<boolean>,
    signal: AbortSignal): Promise<JobBoundStorage>;
  authorizeAdministrator(actor: string): boolean;
  /** Separately authorized installation maintenance. An accepted cleanup
   * obligation survives revocation of the original migration actor. */
  authorizeSystemCleanup(): boolean;
  now(): Date;
  randomId(): string;
  incarnation: string;
}

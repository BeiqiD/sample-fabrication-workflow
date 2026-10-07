/** Installation-local privileged system backup/recovery protocol. These jobs
 * never extend the frozen research-package kind or portable table enums. */
export const SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const SYSTEM_RECOVERY_MAX_STEP_MS = 60_000;
export const SYSTEM_RECOVERY_MAX_ATTEMPTS = 5;
export type SystemRecoveryJobKind = "backup" | "upload" | "recovery";
export type SystemRecoveryJobState = "awaiting_upload" | "queued" | "running" | "preview" | "paused" | "completed" | "cancelled";
export type SystemRecoveryJobPhase = "snapshot" | "inventory" | "measure" | "write" | "validate" | "claim" | "schema" | "rows" | "files" | "reinstall" | "verify" | "ready" | "done";
export type SystemRecoveryJobControl = "pause" | "resume" | "retry" | "cancel" | "cleanup";
export interface SystemRecoveryBackupInput { requestId: string; kind: "backup"; mode: "historical" | "planned" }
export interface SystemRecoveryMaintenanceStatus {
  state: "open" | "draining" | "fenced"; generation: number; token: string | null;
  checkpoint: string | null; backupJobId: string | null; activeWriters: number;
}
export interface SystemRecoveryMaintenanceInput { requestId: string; action: "enter" | "finalize" | "release"; expectedGeneration: number }
export interface SystemRecoveryMaintenanceReceipt extends SystemRecoveryMaintenanceInput { status: SystemRecoveryMaintenanceStatus }
export interface SystemRecoveryUploadInput { requestId: string; byteSize: number; sha256: string }
export interface SystemRecoveryStorageMapping { sourceProfileId: string; destinationProfileId: string; configurationRevision: number }
export interface SystemRecoveryImportInput {
  requestId: string; uploadJobId: string; expectedTargetId: string;
  mapping: SystemRecoveryStorageMapping[];
  mode: "historical" | "planned"; acknowledgeLaterChanges: boolean;
  /** Partial uploads remain inspectable; this flag never authorizes a complete
   * cutover or invents unavailable source bytes. */
  acknowledgePartial: boolean;
}
export interface SystemRecoveryCutoverInput { requestId: string; expectedTargetId: string; expectedCheckpoint: string }
export interface SystemRecoveryJobStatus {
  id: string; requestId: string; kind: SystemRecoveryJobKind; state: SystemRecoveryJobState; phase: SystemRecoveryJobPhase;
  acceptedAt: string; updatedAt: string; reason: string | null;
  progress: { completedFiles: number; totalFiles: number; bytesDone: number; bytesTotal: number };
  output: { available: boolean; byteSize: number; sha256: string; expiresAt: string } | null;
  result: { targetId: string; ready: boolean; cutover: boolean; checkpoint: string | null } | null;
}
export interface SystemRecoveryReceipt { requestId: string; job: SystemRecoveryJobStatus; reused: boolean }
export interface SystemRecoveryCapabilities {
  supported: boolean; canManage: boolean; enabled: boolean; stale: boolean; lastHeartbeatAt: string | null;
  cadenceSeconds: 120; maxStepMs: 60000; reason: string | null;
  target: { configured: boolean; id: string | null; mode: "fresh" };
  maintenance: { state: "open" | "draining" | "fenced"; checkpoint: string | null };
}
export interface SystemRecoveryPreview {
  schema: "system-recovery-preview/1";
  archive: { schema: string; byteSize: number; sha256: string; complete: boolean; legacy: boolean; recoveryPoint: string };
  counts: { tables: number; rows: number; files: number; bytes: number; availableFiles: number; unavailableFiles: number };
  files: Array<{ id: string; purpose: string; byteSize: number; status: string; reason: string | null; sourceProfileId: string | null }>;
  profiles: Array<{ id: string; adapterType: string; namespaceIdentity: string }>;
  protectedSettings: { included: boolean; credentialRecovery: "excluded" | "quarantined" | "key_available"; warnings: string[] };
  oldJobs: { paused: number; automaticReplay: false };
  target: { id: string | null; available: boolean; reason: string | null };
  source: { maintenanceRequired: true; checkpoint: string | null; mode: "historical" | "planned" };
  canRecover: boolean; canCutover: boolean; reasons: string[];
}
export interface SystemRecoveryBackupPreview {
  schema: "system-backup-preview/1"; available: boolean; reasons: string[];
  bounds: { archiveBytes: 104857600; payloadBytes: 100663296; metadataBytes: 4194304; files: 100; maxStepMs: 60000 };
  includesProtectedSettings: true; credentialsRequireKeyring: true;
  maintenance: { state: "open" | "draining" | "fenced"; checkpoint: string | null };
}
export interface SystemRecoveryPublicReport {
  schema: "system-recovery-public-report/1"; jobId: string; targetId: string;
  recoveryPoint: string; mode: "historical" | "planned"; historicalLaterChangesLost: boolean;
  sourceImageSha256: string; targetCheckpoint: string;
  counts: { tables: number; originalRows: number; files: number; bytes: number; auditedCellDifferences: number };
  protectedSettings: { included: boolean; policy: "quarantined"; rootKeysIncluded: false; automaticExecution: false; freshConfigurationRequired: true };
  execution: { shadow: false; authority: false; fileJobs: false; recoveryJobs: false; cleanup: false; oldJobReplay: false };
  changes: Array<{ table: string; column: string; reason: string; count: number }>;
  handoff: { automaticBindingChange: false; operatorRequired: true; sourceRetainedReadOnly: true; rollback: "safe_before_target_writes_only"; steps: string[] };
}
export class SystemRecoveryInputError extends Error {
  constructor() { super("Invalid system recovery input or response."); this.name = "SystemRecoveryInputError"; }
}
function invalid(): never { throw new SystemRecoveryInputError(); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !keys.includes(key))) invalid();
  return row;
}
function text(value: unknown, limit = 256): string {
  if (typeof value !== "string" || !value || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)
    || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value) invalid();
  return value;
}
function id(value: unknown): string { const result = text(value, 128); if (result === "." || result === ".." || /[\s/\\]/.test(result)) invalid(); return result; }
function integer(value: unknown, max: number, min = 0): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(); return Number(value); }
function bool(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function sha(value: unknown): string { const result = text(value, 64); if (!/^[a-f0-9]{64}$/.test(result)) invalid(); return result; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) invalid(); return value as T; }
function timestamp(value: unknown): string { const result = text(value, 32); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) invalid(); return result; }
function nullableText(value: unknown, limit = 256): string | null { return value === null ? null : text(value, limit); }
function list(value: unknown, max = 100): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function reasonList(value: unknown): string[] { return list(value).map(value => reason(value) ?? invalid()); }
function reason(value: unknown): string | null { if (value === null) return null; const result = text(value, 128); if (!/^[a-z][a-z0-9_]*$/.test(result)) invalid(); return result; }
export function checkedSystemRecoveryBackupInput(value: unknown): SystemRecoveryBackupInput {
  const row = object(value, ["requestId", "kind", "mode"]); return { requestId: id(row.requestId), kind: oneOf(row.kind, ["backup"]), mode: oneOf(row.mode, ["historical", "planned"]) };
}
export function checkedSystemRecoveryUploadInput(value: unknown): SystemRecoveryUploadInput {
  const row = object(value, ["requestId", "byteSize", "sha256"]);
  return { requestId: id(row.requestId), byteSize: integer(row.byteSize, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES, 22), sha256: sha(row.sha256) };
}
export function checkedSystemRecoveryImportInput(value: unknown): SystemRecoveryImportInput {
  const row = object(value, ["requestId", "uploadJobId", "expectedTargetId", "mapping", "acknowledgePartial", "mode", "acknowledgeLaterChanges"]);
  if (!Array.isArray(row.mapping) || row.mapping.length > 100) invalid();
  const mapping = row.mapping.map(value => { const item = object(value, ["sourceProfileId", "destinationProfileId", "configurationRevision"]);
    return { sourceProfileId: id(item.sourceProfileId), destinationProfileId: id(item.destinationProfileId), configurationRevision: integer(item.configurationRevision, Number.MAX_SAFE_INTEGER, 1) }; });
  if (new Set(mapping.map(value => value.sourceProfileId)).size !== mapping.length) invalid();
  const mode = oneOf(row.mode, ["historical", "planned"]), acknowledgeLaterChanges = bool(row.acknowledgeLaterChanges);
  if (mode === "historical" && !acknowledgeLaterChanges) invalid();
  return { requestId: id(row.requestId), uploadJobId: id(row.uploadJobId), expectedTargetId: id(row.expectedTargetId), mapping,
    acknowledgePartial: bool(row.acknowledgePartial), mode, acknowledgeLaterChanges };
}
export function checkedSystemRecoveryCutoverInput(value: unknown): SystemRecoveryCutoverInput {
  const row = object(value, ["requestId", "expectedTargetId", "expectedCheckpoint"]);
  return { requestId: id(row.requestId), expectedTargetId: id(row.expectedTargetId), expectedCheckpoint: sha(row.expectedCheckpoint) };
}
export function checkedSystemRecoveryJobControl(value: unknown): SystemRecoveryJobControl {
  return oneOf(object(value, ["action"]).action, ["pause", "resume", "retry", "cancel", "cleanup"]);
}
export function checkedSystemRecoveryJobStatus(value: unknown): SystemRecoveryJobStatus {
  const row = object(value, ["id", "requestId", "kind", "state", "phase", "acceptedAt", "updatedAt", "reason", "progress", "output", "result"]);
  const p = object(row.progress, ["completedFiles", "totalFiles", "bytesDone", "bytesTotal"]);
  const progress = { completedFiles: integer(p.completedFiles, 100), totalFiles: integer(p.totalFiles, 100),
    bytesDone: integer(p.bytesDone, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES), bytesTotal: integer(p.bytesTotal, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES) };
  if (progress.completedFiles > progress.totalFiles || progress.bytesDone > progress.bytesTotal) invalid();
  let output: SystemRecoveryJobStatus["output"] = null, result: SystemRecoveryJobStatus["result"] = null;
  if (row.output !== null) { const item = object(row.output, ["available", "byteSize", "sha256", "expiresAt"]);
    output = { available: bool(item.available), byteSize: integer(item.byteSize, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES, 22), sha256: sha(item.sha256), expiresAt: timestamp(item.expiresAt) }; }
  if (row.result !== null) { const item = object(row.result, ["targetId", "ready", "cutover", "checkpoint"]);
    result = { targetId: id(item.targetId), ready: bool(item.ready), cutover: bool(item.cutover), checkpoint: item.checkpoint === null ? null : sha(item.checkpoint) }; }
  return { id: id(row.id), requestId: id(row.requestId), kind: oneOf(row.kind, ["backup", "upload", "recovery"]),
    state: oneOf(row.state, ["awaiting_upload", "queued", "running", "preview", "paused", "completed", "cancelled"]),
    phase: oneOf(row.phase, ["snapshot", "inventory", "measure", "write", "validate", "claim", "schema", "rows", "files", "reinstall", "verify", "ready", "done"]),
    acceptedAt: timestamp(row.acceptedAt), updatedAt: timestamp(row.updatedAt), reason: reason(row.reason), progress, output, result };
}
export function checkedSystemRecoveryReceipt(value: unknown): SystemRecoveryReceipt {
  const row = object(value, ["requestId", "job", "reused"]);
  return { requestId: id(row.requestId), job: checkedSystemRecoveryJobStatus(row.job), reused: bool(row.reused) };
}
function maintenance(value: unknown): SystemRecoveryCapabilities["maintenance"] {
  const item = object(value, ["state", "checkpoint"]);
  return { state: oneOf(item.state, ["open", "draining", "fenced"]), checkpoint: item.checkpoint === null ? null : sha(item.checkpoint) };
}
export function checkedSystemRecoveryCapabilities(value: unknown): SystemRecoveryCapabilities {
  const row = object(value, ["supported", "canManage", "enabled", "stale", "lastHeartbeatAt", "cadenceSeconds", "maxStepMs", "reason", "target", "maintenance"]);
  const target = object(row.target, ["configured", "id", "mode"]);
  if (row.cadenceSeconds !== 120 || row.maxStepMs !== 60000 || target.mode !== "fresh") invalid();
  return { supported: bool(row.supported), canManage: bool(row.canManage), enabled: bool(row.enabled), stale: bool(row.stale),
    lastHeartbeatAt: row.lastHeartbeatAt === null ? null : timestamp(row.lastHeartbeatAt), cadenceSeconds: 120, maxStepMs: 60000,
    reason: reason(row.reason), target: { configured: bool(target.configured), id: target.id === null ? null : id(target.id), mode: "fresh" }, maintenance: maintenance(row.maintenance) };
}
export function checkedSystemRecoveryBackupPreview(value: unknown): SystemRecoveryBackupPreview {
  const row = object(value, ["schema", "available", "reasons", "bounds", "includesProtectedSettings", "credentialsRequireKeyring", "maintenance"]);
  const b = object(row.bounds, ["archiveBytes", "payloadBytes", "metadataBytes", "files", "maxStepMs"]);
  if (row.schema !== "system-backup-preview/1" || b.archiveBytes !== 104857600 || b.payloadBytes !== 100663296 || b.metadataBytes !== 4194304
    || b.files !== 100 || b.maxStepMs !== 60000 || row.includesProtectedSettings !== true || row.credentialsRequireKeyring !== true) invalid();
  return { schema: "system-backup-preview/1", available: bool(row.available), reasons: reasonList(row.reasons),
    bounds: { archiveBytes: 104857600, payloadBytes: 100663296, metadataBytes: 4194304, files: 100, maxStepMs: 60000 },
    includesProtectedSettings: true, credentialsRequireKeyring: true, maintenance: maintenance(row.maintenance) };
}
export function checkedSystemRecoveryPreview(value: unknown): SystemRecoveryPreview {
  const row = object(value, ["schema", "archive", "counts", "files", "profiles", "protectedSettings", "oldJobs", "target", "source", "canRecover", "canCutover", "reasons"]);
  if (row.schema !== "system-recovery-preview/1") invalid();
  const a = object(row.archive, ["schema", "byteSize", "sha256", "complete", "legacy", "recoveryPoint"]);
  const c = object(row.counts, ["tables", "rows", "files", "bytes", "availableFiles", "unavailableFiles"]);
  const p = object(row.protectedSettings, ["included", "credentialRecovery", "warnings"]), old = object(row.oldJobs, ["paused", "automaticReplay"]);
  const t = object(row.target, ["id", "available", "reason"]), s = object(row.source, ["maintenanceRequired", "checkpoint", "mode"]);
  if (old.automaticReplay !== false || s.maintenanceRequired !== true) invalid();
  const counts = { tables: integer(c.tables, 512), rows: integer(c.rows, 100000), files: integer(c.files, 100),
    bytes: integer(c.bytes, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES), availableFiles: integer(c.availableFiles, 100), unavailableFiles: integer(c.unavailableFiles, 100) };
  if (counts.availableFiles + counts.unavailableFiles !== counts.files) invalid();
  const files = list(row.files).map(value => { const f = object(value, ["id", "purpose", "byteSize", "status", "reason", "sourceProfileId"]);
    return { id: id(f.id), purpose: text(f.purpose, 128), byteSize: integer(f.byteSize, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES),
      status: text(f.status, 64), reason: reason(f.reason), sourceProfileId: nullableText(f.sourceProfileId, 128) }; });
  const profiles = list(row.profiles).map(value => { const p = object(value, ["id", "adapterType", "namespaceIdentity"]);
    return { id: id(p.id), adapterType: text(p.adapterType, 64), namespaceIdentity: text(p.namespaceIdentity, 2000) }; });
  return { schema: "system-recovery-preview/1", archive: { schema: text(a.schema, 64), byteSize: integer(a.byteSize, SYSTEM_RECOVERY_MAX_ARCHIVE_BYTES, 22),
    sha256: sha(a.sha256), complete: bool(a.complete), legacy: bool(a.legacy), recoveryPoint: timestamp(a.recoveryPoint) }, counts, files, profiles,
    protectedSettings: { included: bool(p.included), credentialRecovery: oneOf(p.credentialRecovery, ["excluded", "quarantined", "key_available"]), warnings: reasonList(p.warnings) },
    oldJobs: { paused: integer(old.paused, 100000), automaticReplay: false }, target: { id: t.id === null ? null : id(t.id), available: bool(t.available), reason: reason(t.reason) },
    source: { maintenanceRequired: true, checkpoint: s.checkpoint === null ? null : sha(s.checkpoint), mode: oneOf(s.mode, ["historical", "planned"]) },
    canRecover: bool(row.canRecover), canCutover: bool(row.canCutover), reasons: reasonList(row.reasons) };
}
export function checkedSystemRecoveryMaintenanceStatus(value: unknown): SystemRecoveryMaintenanceStatus {
  const row = object(value, ["state", "generation", "token", "checkpoint", "backupJobId", "activeWriters"]);
  return { state: oneOf(row.state, ["open", "draining", "fenced"]), generation: integer(row.generation, Number.MAX_SAFE_INTEGER),
    token: row.token === null ? null : id(row.token), checkpoint: row.checkpoint === null ? null : sha(row.checkpoint),
    backupJobId: row.backupJobId === null ? null : id(row.backupJobId), activeWriters: integer(row.activeWriters, Number.MAX_SAFE_INTEGER) };
}
export function checkedSystemRecoveryMaintenanceInput(value: unknown): SystemRecoveryMaintenanceInput {
  const row = object(value, ["requestId", "action", "expectedGeneration"]);
  return { requestId: id(row.requestId), action: oneOf(row.action, ["enter", "finalize", "release"]), expectedGeneration: integer(row.expectedGeneration, Number.MAX_SAFE_INTEGER) };
}
export function checkedSystemRecoveryMaintenanceReceipt(value: unknown): SystemRecoveryMaintenanceReceipt {
  const row = object(value, ["requestId", "action", "expectedGeneration", "status"]);
  return { ...checkedSystemRecoveryMaintenanceInput({ requestId: row.requestId, action: row.action, expectedGeneration: row.expectedGeneration }), status: checkedSystemRecoveryMaintenanceStatus(row.status) };
}

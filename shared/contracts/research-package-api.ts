import type { FilePurpose } from "./files";

export const RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const RESEARCH_PACKAGE_MAX_FILE_BYTES = 96 * 1024 * 1024;
export const RESEARCH_PACKAGE_MAX_METADATA_BYTES = 4 * 1024 * 1024;
export const RESEARCH_PACKAGE_MAX_FILES = 100;
export const RESEARCH_PACKAGE_MAX_RECORDS = 1200;
export const RESEARCH_PACKAGE_MAX_ROOTS = 20;
export const RESEARCH_PACKAGE_PREFLIGHT_REASONS = ["definition_media_destination_conflict", "canonical_definition_conflict", "import_plan_budget",
  "publication_row_size_limit", "publication_statement_limit", "destination_name_preflight_limit", "destination_name_limit", "destination_name_conflict",
  "unsupported_source_import_state"] as const;
export type ResearchPackagePreflightReason = typeof RESEARCH_PACKAGE_PREFLIGHT_REASONS[number];
export const RESEARCH_PACKAGE_PREFLIGHT_ERROR = "Package copy preflight is unsupported or conflicts with existing immutable content.";

export interface ResearchRoot { kind: "sample" | "project"; id: string }
export type ResearchExportKind = "data_package" | "report";
export interface ResearchExportPlanInput { kind: ResearchExportKind; roots: ResearchRoot[] }
export interface ResearchExportInput extends ResearchExportPlanInput { requestId: string }
export interface ResearchUploadInput { requestId: string; byteSize: number; sha256: string }
export interface ResearchImportInput { requestId: string; uploadJobId: string; anotherCopy: boolean; expectedRolePolicyRevision: number | null; naming?: { suffix: string } }
export type ResearchJobKind = ResearchExportKind | "upload" | "import";
export type ResearchJobState = "awaiting_upload" | "queued" | "running" | "preview" | "paused" | "cancel_requested" | "completed" | "cancelled";
export type ResearchJobPhase = "snapshot" | "measure" | "write" | "validate" | "preview" | "copy" | "publish" | "done";
export interface ResearchJobStatus {
  id: string; requestId: string; kind: ResearchJobKind; state: ResearchJobState; phase: ResearchJobPhase;
  acceptedAt: string; updatedAt: string; reason: string | null;
  progress: { completedFiles: number; totalFiles: number; bytesDone: number; bytesTotal: number };
  output: { available: boolean; byteSize: number; sha256: string; expiresAt: string } | null;
  result: { roots: ResearchRoot[]; reused: boolean } | null;
}
export interface ResearchRequestReceipt { requestId: string; job: ResearchJobStatus; reused: boolean }
export interface ResearchCapability { available: boolean; reasons: string[] }
export interface ResearchPackagePreview {
  schema: "research-package-preview/1"; kind: ResearchExportKind; roots: ResearchRoot[];
  counts: { records: number; files: number; bytes: number };
  rolePolicyRevision: number | null;
  archiveBytes: number | null; metadataBytes: number;
  warnings: string[]; complete: boolean;
  capabilities: { dataPackage: ResearchCapability; report: ResearchCapability };
  dependencies: Array<{ targetType: string; id: string; outcome: "included" | "excluded" | "not_found" | "inconsistent" | "tombstoned" | "unavailable";
    reason: string | null; label?: string | null }>;
  source: { installationId: string; packageId: string; payloadSha256: string } | null;
  naming: { suffix: string; conflicts: Array<{ kind: "sample" | "template" | "project"; sourceId: string; sourceName: string; destinationName: string }> } | null;
  targets: Array<{ purpose: FilePurpose; role: "internal" | "originals"; profileId: string; configurationRevision: number; available: boolean }>;
  existingImportJobId: string | null;
}
export interface ResearchExecutorStatus {
  supported: boolean; enabled: boolean; stale: boolean; canManage: boolean;
  lastHeartbeatAt: string | null; cadenceSeconds: 120; maxStepMs: 60000; reason: string | null;
}
export type ResearchJobControl = "pause" | "resume" | "cancel" | "retry" | "cleanup";

export class ResearchPackageInputError extends Error {
  constructor() { super("Invalid research package input or response."); this.name = "ResearchPackageInputError"; }
}
function invalid(): never { throw new ResearchPackageInputError(); }
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || value.length > maximum || !empty && !value.length || /[\u0000-\u001f\u007f]/.test(value)
    || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value) invalid();
  return value;
}
function identity(value: unknown): string { const result = text(value, 256); if (/\s/.test(result)) invalid(); return result; }
function operationIdentity(value: unknown): string {
  const result = identity(value); if (result.length > 128 || result === "." || result === ".." || /[/\\]/.test(result)) invalid(); return result;
}
function contextLabel(value: unknown): string {
  const label = text(value, 2000, true); if ([...label].length > 1000) invalid(); return label;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function integer(value: unknown, maximum: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid(); return value as number;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) invalid(); return value as T; }
function sha(value: unknown): string { const result = text(value, 64); if (!/^[0-9a-f]{64}$/.test(result)) invalid(); return result; }
function timestamp(value: unknown): string {
  const result = text(value, 32); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) invalid(); return result;
}
function reason(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 128); if (!/^[a-z][a-z0-9_]*$/.test(result)) invalid(); return result;
}
function reasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > RESEARCH_PACKAGE_MAX_RECORDS) invalid();
  return value.map(entry => reason(entry) ?? invalid());
}
export function checkedResearchRoot(value: unknown): ResearchRoot {
  const row = object(value, ["kind", "id"]); return { kind: oneOf(row.kind, ["sample", "project"]), id: identity(row.id) };
}
function roots(value: unknown, allowEmpty = false): ResearchRoot[] {
  if (!Array.isArray(value) || value.length > RESEARCH_PACKAGE_MAX_ROOTS || !allowEmpty && value.length < 1) invalid();
  const checked = value.map(checkedResearchRoot);
  if (new Set(checked.map(root => `${root.kind}:${root.id}`)).size !== checked.length) invalid(); return checked;
}
export function checkedResearchExportPlanInput(value: unknown): ResearchExportPlanInput {
  const row = object(value, ["kind", "roots"]); return { kind: oneOf(row.kind, ["data_package", "report"]), roots: roots(row.roots) };
}
export function checkedResearchExportInput(value: unknown): ResearchExportInput {
  const row = object(value, ["kind", "roots", "requestId"]);
  return { requestId: operationIdentity(row.requestId), ...checkedResearchExportPlanInput({ kind: row.kind, roots: row.roots }) };
}
export function checkedResearchUploadInput(value: unknown): ResearchUploadInput {
  const row = object(value, ["requestId", "byteSize", "sha256"]);
  return { requestId: operationIdentity(row.requestId), byteSize: integer(row.byteSize, RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, 1), sha256: sha(row.sha256) };
}
export function checkedResearchImportInput(value: unknown): ResearchImportInput {
  const row = object(value, ["requestId", "uploadJobId", "anotherCopy", "expectedRolePolicyRevision"], ["naming"]);
  return { requestId: operationIdentity(row.requestId), uploadJobId: operationIdentity(row.uploadJobId), anotherCopy: bool(row.anotherCopy),
    expectedRolePolicyRevision: row.expectedRolePolicyRevision === null ? null : integer(row.expectedRolePolicyRevision, Number.MAX_SAFE_INTEGER, 1),
    ...(Object.hasOwn(row, "naming") ? { naming: { suffix: text(object(row.naming, ["suffix"]).suffix, 32, true) } } : {}) };
}
export function checkedResearchJobStatus(value: unknown): ResearchJobStatus {
  const row = object(value, ["id", "requestId", "kind", "state", "phase", "acceptedAt", "updatedAt", "reason", "progress", "output", "result"]);
  const progress = object(row.progress, ["completedFiles", "totalFiles", "bytesDone", "bytesTotal"]);
  const checkedProgress = { completedFiles: integer(progress.completedFiles, RESEARCH_PACKAGE_MAX_FILES), totalFiles: integer(progress.totalFiles, RESEARCH_PACKAGE_MAX_FILES),
    bytesDone: integer(progress.bytesDone, RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES), bytesTotal: integer(progress.bytesTotal, RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES) };
  if (checkedProgress.completedFiles > checkedProgress.totalFiles || checkedProgress.bytesDone > checkedProgress.bytesTotal) invalid();
  let output: ResearchJobStatus["output"] = null, result: ResearchJobStatus["result"] = null;
  if (row.output !== null) { const entry = object(row.output, ["available", "byteSize", "sha256", "expiresAt"]);
    output = { available: bool(entry.available), byteSize: integer(entry.byteSize, RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, 1), sha256: sha(entry.sha256), expiresAt: timestamp(entry.expiresAt) }; }
  if (row.result !== null) { const entry = object(row.result, ["roots", "reused"]); result = { roots: roots(entry.roots), reused: bool(entry.reused) }; }
  return { id: operationIdentity(row.id), requestId: operationIdentity(row.requestId), kind: oneOf(row.kind, ["data_package", "report", "upload", "import"]),
    state: oneOf(row.state, ["awaiting_upload", "queued", "running", "preview", "paused", "cancel_requested", "completed", "cancelled"]),
    phase: oneOf(row.phase, ["snapshot", "measure", "write", "validate", "preview", "copy", "publish", "done"]),
    acceptedAt: timestamp(row.acceptedAt), updatedAt: timestamp(row.updatedAt), reason: reason(row.reason), progress: checkedProgress, output, result };
}
export function checkedResearchRequestReceipt(value: unknown): ResearchRequestReceipt {
  const row = object(value, ["requestId", "job", "reused"]);
  const job = checkedResearchJobStatus(row.job), reused = bool(row.reused);
  if (reused && job.kind !== "import") invalid();
  return { requestId: operationIdentity(row.requestId), job, reused };
}
export function checkedResearchPackagePreview(value: unknown): ResearchPackagePreview {
  const row = object(value, ["schema", "kind", "roots", "counts", "rolePolicyRevision", "archiveBytes", "metadataBytes", "warnings", "complete", "capabilities", "dependencies", "source", "naming", "targets", "existingImportJobId"]);
  if (row.schema !== "research-package-preview/1") invalid();
  const counts = object(row.counts, ["records", "files", "bytes"]), capabilities = object(row.capabilities, ["dataPackage", "report"]);
  const capability = (value: unknown): ResearchCapability => { const item = object(value, ["available", "reasons"]);
    const checked = { available: bool(item.available), reasons: reasons(item.reasons) }; if (checked.available && checked.reasons.length) invalid(); return checked; };
  const checkedCapabilities = { dataPackage: capability(capabilities.dataPackage), report: capability(capabilities.report) };
  const overBudgetSource = row.source === null && !checkedCapabilities.dataPackage.available && !checkedCapabilities.report.available
    && checkedCapabilities.dataPackage.reasons.includes("package_budget_exceeded") && checkedCapabilities.report.reasons.includes("package_budget_exceeded");
  if (!Array.isArray(row.dependencies) || row.dependencies.length > RESEARCH_PACKAGE_MAX_RECORDS || !Array.isArray(row.targets) || row.targets.length > 5) invalid();
  let source: ResearchPackagePreview["source"] = null, naming: ResearchPackagePreview["naming"] = null;
  if (row.source !== null) { const item = object(row.source, ["installationId", "packageId", "payloadSha256"]);
    source = { installationId: identity(item.installationId), packageId: identity(item.packageId), payloadSha256: sha(item.payloadSha256) }; }
  if (row.naming !== null) { const item = object(row.naming, ["suffix", "conflicts"]); if (!Array.isArray(item.conflicts) || item.conflicts.length > RESEARCH_PACKAGE_MAX_RECORDS) invalid();
    naming = { suffix: text(item.suffix, 32, true), conflicts: item.conflicts.map(value => { const entry = object(value, ["kind", "sourceId", "sourceName", "destinationName"]);
      return { kind: oneOf(entry.kind, ["sample", "template", "project"]), sourceId: identity(entry.sourceId), sourceName: text(entry.sourceName, 1000, true), destinationName: text(entry.destinationName, 1000) }; }) }; }
  const targets = row.targets.map(value => { const item = object(value, ["purpose", "role", "profileId", "configurationRevision", "available"]);
    return { purpose: oneOf<FilePurpose>(item.purpose, ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"]),
      role: oneOf(item.role, ["internal", "originals"]), profileId: identity(item.profileId), configurationRevision: integer(item.configurationRevision, Number.MAX_SAFE_INTEGER, 1), available: bool(item.available) }; });
  if (new Set(targets.map(target => target.purpose)).size !== targets.length) invalid();
  if (targets.some(target => target.role !== (["research_source", "provenance"].includes(target.purpose) ? "originals" : "internal"))) invalid();
  return { schema: "research-package-preview/1", kind: oneOf(row.kind, ["data_package", "report"]), roots: roots(row.roots),
    counts: { records: integer(counts.records, overBudgetSource ? Number.MAX_SAFE_INTEGER : RESEARCH_PACKAGE_MAX_RECORDS),
      files: integer(counts.files, overBudgetSource ? Number.MAX_SAFE_INTEGER : RESEARCH_PACKAGE_MAX_FILES),
      bytes: integer(counts.bytes, overBudgetSource ? Number.MAX_SAFE_INTEGER : RESEARCH_PACKAGE_MAX_FILE_BYTES) },
    rolePolicyRevision: row.rolePolicyRevision === null ? null : integer(row.rolePolicyRevision, Number.MAX_SAFE_INTEGER, 1),
    archiveBytes: row.archiveBytes === null ? null : integer(row.archiveBytes, RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES), metadataBytes: integer(row.metadataBytes, RESEARCH_PACKAGE_MAX_METADATA_BYTES),
    warnings: reasons(row.warnings), complete: bool(row.complete), capabilities: checkedCapabilities,
    dependencies: row.dependencies.map(value => { const item = object(value, ["targetType", "id", "outcome", "reason"], ["label"]);
      return { targetType: text(item.targetType, 64), id: identity(item.id), outcome: oneOf(item.outcome, ["included", "excluded", "not_found", "inconsistent", "tombstoned", "unavailable"]), reason: reason(item.reason),
        ...(Object.hasOwn(item, "label") ? { label: item.label === null ? null : contextLabel(item.label) } : {}) }; }),
    source, naming, targets, existingImportJobId: row.existingImportJobId === null ? null : operationIdentity(row.existingImportJobId) };
}
export function checkedResearchExecutorStatus(value: unknown): ResearchExecutorStatus {
  const row = object(value, ["supported", "enabled", "stale", "canManage", "lastHeartbeatAt", "cadenceSeconds", "maxStepMs", "reason"]);
  if (row.cadenceSeconds !== 120 || row.maxStepMs !== 60000) invalid();
  return { supported: bool(row.supported), enabled: bool(row.enabled), stale: bool(row.stale), canManage: bool(row.canManage),
    lastHeartbeatAt: row.lastHeartbeatAt === null ? null : timestamp(row.lastHeartbeatAt), cadenceSeconds: 120, maxStepMs: 60000, reason: reason(row.reason) };
}
export function checkedResearchJobControl(value: unknown): { action: ResearchJobControl } {
  const row = object(value, ["action"]); return { action: oneOf(row.action, ["pause", "resume", "cancel", "retry", "cleanup"]) };
}
export function checkedResearchPreflightError(value: unknown): { error: typeof RESEARCH_PACKAGE_PREFLIGHT_ERROR; reason: ResearchPackagePreflightReason } {
  const row = object(value, ["error", "reason"]);
  if (row.error !== RESEARCH_PACKAGE_PREFLIGHT_ERROR) invalid();
  return { error: RESEARCH_PACKAGE_PREFLIGHT_ERROR, reason: oneOf(row.reason, RESEARCH_PACKAGE_PREFLIGHT_REASONS) };
}

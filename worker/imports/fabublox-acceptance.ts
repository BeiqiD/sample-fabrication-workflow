import {
  MAX_FABUBLOX_REQUEST_INPUT_BYTES,
  normalizeFabubloxImportRequestId,
  type FabubloxImportRequestState,
  type FabubloxImportResult,
} from "../../shared/contracts/fabublox-import";
import { primaryD1 } from "../d1-primary";

export interface AcceptedFabubloxImportRow {
  id: string;
  actor_email: string;
  operation_id: string;
  client_request_id: string;
  request_sha256: string;
  request_input_json: string;
  request_scope: "system";
  storage_profile_id: string;
  storage_profile_revision: 1;
  storage_policy_revision: 1;
  status: "pending" | "ready" | "failed";
  lease_expires_at: string | null;
  accepted_result_json: string | null;
}

export interface AcceptFabubloxImportInput {
  importId: string;
  operationId: string;
  requestId: string;
  requestSha256: string;
  requestInputJson: string;
  actorEmail: string;
  profileId: string;
  profileRevision: 1;
  policyRevision: 1;
  sourceFilename: string;
  sourceSha256: string;
  sheetName: string;
  templateType: "process" | "module" | "recipe";
  recipeFamilyId: string;
  warningCount: number;
  createdAt: string;
  leaseExpiresAt: string;
}

export class FabubloxImportRequestConflictError extends Error {
  constructor() {
    super("This import request was already accepted with different content.");
    this.name = "FabubloxImportRequestConflictError";
  }
}

export class FabubloxImportAcceptanceUnavailableError extends Error {
  constructor() {
    super("The import request outcome could not be determined. Check the same request again.");
    this.name = "FabubloxImportAcceptanceUnavailableError";
  }
}

export async function readAcceptedImport(
  db: D1Database,
  actorEmail: string,
  requestId: string,
): Promise<AcceptedFabubloxImportRow | null> {
  const normalized = normalizeFabubloxImportRequestId(requestId);
  if (!normalized || !actorEmail) throw new Error("Invalid import request identity");
  try {
    return await primaryD1(db).prepare(`
      SELECT id, actor_email, operation_id, client_request_id, request_sha256,
             request_input_json, request_scope, storage_profile_id,
             storage_profile_revision, storage_policy_revision, status,
             lease_expires_at, accepted_result_json
      FROM imports WHERE actor_email = ? AND client_request_id = ?
    `).bind(actorEmail, normalized).first<AcceptedFabubloxImportRow>();
  } catch {
    throw new FabubloxImportAcceptanceUnavailableError();
  }
}

export function acceptedImportState(row: AcceptedFabubloxImportRow): FabubloxImportRequestState {
  const identity = { requestId: row.client_request_id, importId: row.id };
  if (row.status === "pending") return { ...identity, status: "pending", leaseExpiresAt: row.lease_expires_at };
  if (row.status === "failed") return { ...identity, status: "failed" };
  let result: FabubloxImportResult;
  try {
    result = JSON.parse(row.accepted_result_json ?? "null") as FabubloxImportResult;
    if (!result || typeof result !== "object" || Array.isArray(result)
      || Object.keys(result).sort().join(",") !== "id,templateVersionId,version"
      || result.id !== row.id || typeof result.templateVersionId !== "string" || !result.templateVersionId
      || !Number.isSafeInteger(result.version) || result.version < 1) throw new Error("Invalid result");
  } catch {
    throw new FabubloxImportAcceptanceUnavailableError();
  }
  return { ...identity, status: "ready", result };
}

function validateInput(input: AcceptFabubloxImportInput) {
  if (normalizeFabubloxImportRequestId(input.requestId) !== input.requestId
    || !/^[0-9a-f]{64}$/.test(input.requestSha256)
    || !input.actorEmail || !input.operationId || !input.importId || !input.profileId
    || input.profileRevision !== 1 || input.policyRevision !== 1
    || new TextEncoder().encode(input.requestInputJson).byteLength > MAX_FABUBLOX_REQUEST_INPUT_BYTES) {
    throw new Error("Invalid import acceptance input");
  }
  const metadata: unknown = JSON.parse(input.requestInputJson);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid import acceptance metadata");
}

/**
 * The imports row is the single acceptance and execution authority. A fresh
 * execution owns a random operation ID; HTTP retries never reuse that owner ID.
 * Even a lost INSERT acknowledgement is reconciled on the primary before any
 * caller may perform provider I/O. A competing request can only observe it.
 */
export async function acceptFabubloxImport(
  db: D1Database,
  input: AcceptFabubloxImportInput,
): Promise<{ row: AcceptedFabubloxImportRow; owned: boolean }> {
  validateInput(input);
  try {
    await primaryD1(db).prepare(`
      INSERT INTO imports (
        id, status, source_filename, source_sha256, sheet_name, template_type,
        recipe_family_id, warning_count, actor_email, created_at, operation_id,
        lease_expires_at, client_request_id, request_sha256, request_input_json,
        request_scope, storage_profile_id, storage_profile_revision, storage_policy_revision
      ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?, ?)
    `).bind(
      input.importId, input.sourceFilename, input.sourceSha256, input.sheetName,
      input.templateType, input.recipeFamilyId, input.warningCount, input.actorEmail,
      input.createdAt, input.operationId, input.leaseExpiresAt, input.requestId,
      input.requestSha256, input.requestInputJson, input.profileId,
      input.profileRevision, input.policyRevision,
    ).run();
  } catch {
    // Constraint races and acknowledgement loss have the same reconciliation
    // path. Error text may contain deployment details and is never returned.
  }
  const row = await readAcceptedImport(db, input.actorEmail, input.requestId);
  if (!row) throw new FabubloxImportAcceptanceUnavailableError();
  if (row.request_sha256 !== input.requestSha256 || row.request_input_json !== input.requestInputJson) {
    throw new FabubloxImportRequestConflictError();
  }
  const owned = row.id === input.importId && row.operation_id === input.operationId && row.status === "pending";
  if (owned && (row.storage_profile_id !== input.profileId
    || row.storage_profile_revision !== input.profileRevision
    || row.storage_policy_revision !== input.policyRevision)) {
    throw new FabubloxImportAcceptanceUnavailableError();
  }
  return { row, owned };
}

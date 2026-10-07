import type { ExportTables } from "./export";
import { MAX_R2_UPLOAD_REQUEST_INPUT_BYTES, normalizeR2UploadRequestId, R2_UPLOAD_RECEIPT_LIFETIME_MS,
  validateR2UploadInput, validateFileUploadResult } from "./r2-upload";
import { validateRecordedRoleTarget } from "./export-file-native-role-policy";
import { sha256Hex, stableJson } from "../domain/content-addressing";

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid R2 upload acceptance ${message}`);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && [...value].length > 0 && [...value].length <= maximum && !value.includes("\0");
}
function jsonObject(value: unknown, maximum: number) {
  ensure(typeof value === "string" && new TextEncoder().encode(value).byteLength <= maximum, "JSON size");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { /* rejected below */ }
  ensure(parsed && typeof parsed === "object" && !Array.isArray(parsed), "JSON object");
  return parsed as Record<string, unknown>;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export async function validateFileUploadAcceptanceV21(tables: ExportTables) {
  const profiles = new Map(tables.storage_profiles.map((row) => [row.id, row]));
  const uniqueColumns = ["id", "operation_id", "candidate_asset_id", "candidate_object_key"] as const;
  const seen = Object.fromEntries(uniqueColumns.map((column) => [column, new Set<unknown>()]));
  const actorRequests = new Set<string>();
  for (const row of tables.r2_upload_requests) {
    for (const column of uniqueColumns) {
      ensure(!seen[column].has(row[column]), "duplicate operation or candidate identity");
      seen[column].add(row[column]);
    }
    for (const column of ["id", "client_request_id", "operation_id", "candidate_asset_id"]) {
      ensure(typeof row[column] === "string" && normalizeR2UploadRequestId(row[column]) === row[column], "request identity");
    }
    ensure(text(row.actor_email, 256) && text(row.candidate_object_key, 4096), "actor or candidate identity");
    const actorRequest = JSON.stringify([row.actor_email, row.client_request_id]);
    ensure(!actorRequests.has(actorRequest), "duplicate actor request identity");
    actorRequests.add(actorRequest);
    ensure(row.request_scope === "system" && row.storage_profile_revision === 1 && row.storage_policy_revision === 1,
      "scope or policy revision");
    const profile = profiles.get(row.storage_profile_id);
    ensure(profile && ["r2", "s3"].includes(String(profile.adapter_type)) && profile.configuration_revision === row.storage_profile_revision
      && profile.configuration_source === (profile.adapter_type === "s3" ? "system" : "bootstrap") && profile.credential_reference === null && profile.state === "historical",
    "profile identity or revision");
    if (row.role_policy_revision === null) ensure(profile.adapter_type === "r2", "historical R2 target");
    else {
      ensure(typeof row.role_policy_revision === "number" && row.role_policy_revision >= 3, "successor selection revision");
      validateRecordedRoleTarget(tables, row.role_policy_revision, row.purpose, row.storage_profile_id, row.storage_profile_revision, row.created_at);
    }
    const input = jsonObject(row.request_input_json, MAX_R2_UPLOAD_REQUEST_INPUT_BYTES);
    try { validateR2UploadInput(input); } catch { ensure(false, "request input schema"); }
    ensure(stableJson(input) === row.request_input_json && input.ingress === row.ingress && input.purpose === row.purpose
      && input.scope === row.request_scope, "noncanonical or conflicting request input");
    ensure(typeof row.request_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.request_sha256)
      && row.request_sha256 === await sha256Hex(row.request_input_json as string), "request hash");
    ensure(timestamp(row.created_at) && timestamp(row.expires_at)
      && Date.parse(row.expires_at) - Date.parse(row.created_at) === R2_UPLOAD_RECEIPT_LIFETIME_MS, "receipt lifetime");
    ensure(["pending", "ready", "failed"].includes(String(row.status)), "publication state");
    if (row.status === "pending") {
      ensure(row.completed_at === null && row.accepted_result_json === null, "pending result");
      continue;
    }
    ensure(timestamp(row.completed_at) && row.completed_at >= row.created_at, "completion evidence");
    if (row.status === "failed") {
      ensure(row.accepted_result_json === null, "failed result");
      continue;
    }
    ensure(row.completed_at < row.expires_at, "publication after expiry");
    const decoded = jsonObject(row.accepted_result_json, 8192);
    let result: ReturnType<typeof validateFileUploadResult>;
    try { result = validateFileUploadResult(decoded); } catch { ensure(false, "published result schema"); }
    const members = (String(row.accepted_result_json).replace(/"(?:\\.|[^"\\])*"/g, '""').match(/:/g) ?? []).length;
    const native = profile.adapter_type === "s3";
    ensure(members === (native ? 6 : 3) && (native ? result.key === null && "fileId" in result : typeof result.key === "string"), "published result provider");
    ensure(result.deduplicated || result.id === row.candidate_asset_id && (native || result.key === row.candidate_object_key), "candidate publication identity");
    // The target may have been collected after publication. Never require a
    // current asset row, infer a target by hash, or relabel it usable here.
  }
}

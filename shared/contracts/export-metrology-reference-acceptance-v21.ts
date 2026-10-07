import type { ExportTables } from "./export";
import { normalizeR2UploadRequestId, R2_UPLOAD_RECEIPT_LIFETIME_MS } from "./r2-upload";
import { MAX_METROLOGY_REFERENCE_REQUEST_INPUT_BYTES, validateMetrologyReferenceUploadInput,
  validateMetrologyReferencePublicationPlan, validateMetrologyReferenceUploadResultV21 } from "./metrology-reference-upload";
import { validateRecordedRoleTarget } from "./export-file-native-role-policy";
import { sha256Hex, stableJson } from "../domain/content-addressing";

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid metrology reference acceptance ${message}`);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && [...value].length > 0 && [...value].length <= maximum && !value.includes("\0");
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function parse(value: unknown): unknown {
  ensure(typeof value === "string" && new TextEncoder().encode(value).byteLength <= MAX_METROLOGY_REFERENCE_REQUEST_INPUT_BYTES, "JSON size");
  try { return JSON.parse(value); } catch { ensure(false, "JSON syntax"); }
}
function shape<T>(validate: (value: unknown) => T, value: unknown): T {
  try { return validate(parse(value)); } catch { ensure(false, "input, plan or result schema"); }
}

export async function validateMetrologyReferenceAcceptanceV21(tables: ExportTables) {
  const profiles = new Map(tables.storage_profiles.map((row) => [row.id, row]));
  const uniqueColumns = ["id", "operation_id", "candidate_asset_id", "candidate_object_key", "candidate_reference_id"] as const;
  const seen = Object.fromEntries(uniqueColumns.map((column) => [column, new Set<unknown>()]));
  const actorRequests = new Set<string>();
  for (const row of tables.metrology_reference_upload_requests) {
    for (const column of uniqueColumns) {
      ensure(!seen[column].has(row[column]), "duplicate operation or candidate identity");
      seen[column].add(row[column]);
    }
    for (const column of ["id", "client_request_id", "operation_id", "candidate_asset_id", "candidate_reference_id"]) {
      ensure(typeof row[column] === "string" && normalizeR2UploadRequestId(row[column]) === row[column], "request identity");
    }
    ensure(text(row.actor_email, 256) && text(row.candidate_object_key, 4096) && text(row.template_version_id, 256), "actor, Template or candidate identity");
    const actorRequest = JSON.stringify([row.actor_email, row.client_request_id]);
    ensure(!actorRequests.has(actorRequest), "duplicate actor request identity");
    actorRequests.add(actorRequest);
    ensure(row.ingress === "metrology_reference" && row.purpose === "research_source" && row.request_scope === "system"
      && row.storage_profile_revision === 1 && row.storage_policy_revision === 1, "scope, purpose or policy revision");
    const profile = profiles.get(row.storage_profile_id);
    ensure(profile && ["r2", "s3"].includes(String(profile.adapter_type)) && profile.configuration_revision === row.storage_profile_revision
      && profile.configuration_source === (profile.adapter_type === "s3" ? "system" : "bootstrap") && profile.credential_reference === null && profile.state === "historical", "profile identity or revision");
    if (row.role_policy_revision === null) ensure(profile.adapter_type === "r2", "historical R2 target");
    else {
      ensure(typeof row.role_policy_revision === "number" && row.role_policy_revision >= 3, "successor selection revision");
      validateRecordedRoleTarget(tables, row.role_policy_revision, row.purpose, row.storage_profile_id, row.storage_profile_revision, row.created_at);
    }
    const input = shape(validateMetrologyReferenceUploadInput, row.request_input_json);
    ensure(stableJson(input) === row.request_input_json && input.templateId === row.template_version_id, "noncanonical or conflicting request input");
    ensure(typeof row.request_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.request_sha256)
      && row.request_sha256 === await sha256Hex(row.request_input_json as string), "request hash");
    const plan = shape(validateMetrologyReferencePublicationPlan, row.publication_plan_json);
    ensure(stableJson(plan) === row.publication_plan_json, "noncanonical publication plan");
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
    const result = shape(validateMetrologyReferenceUploadResultV21, row.accepted_result_json);
    // Count syntax members after removing string tokens so a duplicate member
    // cannot disappear in JSON.parse, including inside the nested occurrence.
    const members = (String(row.accepted_result_json).replace(/"(?:\\.|[^"\\])*"/g, '""').match(/:/g) ?? []).length;
    const native = profile.adapter_type === "s3";
    ensure(members === (native ? 11 : 9) && result.reference.byteSize === input.file.byteSize
      && (native ? result.reference.assetKey === null : typeof result.reference.assetKey === "string"), "published result metadata");
    ensure(result.deduplicated || result.assetId === row.candidate_asset_id && (native || result.reference.assetKey === row.candidate_object_key),
      "candidate publication identity");
    if (plan.action !== "create") {
      ensure(result.reference.id === plan.reference.id
        && result.reference.filename === (plan.action === "restore" ? input.file.originalName : plan.reference.filename)
        && result.reference.createdAt === plan.reference.createdAt, "frozen occurrence publication identity");
    }
    if (result.reference.id === row.candidate_reference_id) {
      ensure(result.reference.filename === input.file.originalName && result.reference.createdAt === row.created_at, "new occurrence publication identity");
    }
  }
}

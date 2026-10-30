import type { ExportTables } from "./export";
import { MAX_FABUBLOX_REQUEST_INPUT_BYTES, normalizeFabubloxImportRequestId } from "./fabublox-import";
import { IMPORT_ACCEPTANCE_EXPORT_COLUMNS, validateImportRequestInput } from "./export-import-acceptance";
import { validateRecordedRoleTarget } from "./export-file-native-role-policy";
import { FILE_NATIVE_RUNTIME_TABLE_COLUMNS } from "./file-native-runtime";
import { sha256Hex, stableJson } from "../domain/content-addressing";

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid import acceptance ${message}`);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && [...value].length > 0 && [...value].length <= maximum && !value.includes("\0");
}
function jsonObject(value: unknown, maximum: number) {
  ensure(typeof value === "string" && new TextEncoder().encode(value).byteLength <= maximum, "JSON size");
  let result: unknown;
  try { result = JSON.parse(value); } catch { /* rejected below */ }
  ensure(result && typeof result === "object" && !Array.isArray(result), "JSON object");
  return result as Record<string, unknown>;
}

export async function validateImportAcceptanceV21(tables: ExportTables) {
  const identities = new Set<string>();
  const profiles = new Map(tables.storage_profiles.map((row) => [row.id, row]));
  for (const row of tables.imports) {
    if (IMPORT_ACCEPTANCE_EXPORT_COLUMNS.every((column) => row[column] === null)) {
      ensure(row.file_targets_protocol === null && row.role_policy_revision === null, "unaccepted import cannot own successor targets"); continue;
    }
    const perFile = row.file_targets_protocol === 1;
    ensure(IMPORT_ACCEPTANCE_EXPORT_COLUMNS.slice(0, -1).filter(column => !perFile || !["storage_profile_id", "storage_profile_revision", "storage_policy_revision"].includes(column)).every(column => row[column] !== null), "incomplete decision");
    ensure(typeof row.client_request_id === "string" && normalizeFabubloxImportRequestId(row.client_request_id) === row.client_request_id,
      "request identity");
    ensure(text(row.id, 256) && text(row.actor_email, 256) && text(row.operation_id, 256), "operation identity");
    const identity = JSON.stringify([row.actor_email, row.client_request_id]);
    ensure(!identities.has(identity), "duplicate request identity");
    identities.add(identity);
    ensure(row.request_scope === "system" && row.storage_policy_revision === (perFile ? null : 1), "scope or policy revision");
    if (perFile) ensure(row.storage_profile_id === null && row.storage_profile_revision === null
      && typeof row.role_policy_revision === "number" && Number.isSafeInteger(row.role_policy_revision) && row.role_policy_revision >= 3,
      "per-file target protocol");
    else {
      const profile = profiles.get(row.storage_profile_id);
      ensure(row.file_targets_protocol === null && row.role_policy_revision === null && row.storage_profile_revision === 1
        && profile?.adapter_type === "r2" && profile.configuration_revision === row.storage_profile_revision, "historical whole-import target");
    }
    const input = jsonObject(row.request_input_json, MAX_FABUBLOX_REQUEST_INPUT_BYTES);
    const { workbook } = validateImportRequestInput(input);
    ensure(stableJson(input) === row.request_input_json, "noncanonical request input");
    ensure(row.source_filename === workbook.originalName && row.source_sha256 === workbook.sha256, "source metadata");
    ensure(typeof row.request_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.request_sha256)
      && row.request_sha256 === await sha256Hex(row.request_input_json as string), "request hash");
    ensure(["pending", "ready", "failed"].includes(String(row.status)), "publication state");
    if (perFile) {
      const inputs = new Map<string, Record<string, unknown>>([["workbook", input.workbook as Record<string, unknown>], ["manifest", input.manifest as Record<string, unknown>],
        ...(input.images as Record<string, unknown>[]).map((image): [string, Record<string, unknown>] => [`image:${image.localId}`, image])]);
      const receipts = tables.import_file_acceptances.filter(receipt => receipt.import_id === row.id);
      ensure(receipts.length === inputs.size && new Set(receipts.map(receipt => receipt.item_id)).size === inputs.size, "complete per-file target inventory");
      for (const receipt of receipts) {
        ensure(stableJson(Object.keys(receipt).sort()) === stableJson([...FILE_NATIVE_RUNTIME_TABLE_COLUMNS.import_file_acceptances].sort()), "per-file target columns");
        const expected = inputs.get(String(receipt.item_id));
        ensure(expected && receipt.purpose === expected.purpose && receipt.expected_sha256 === expected.sha256
          && receipt.expected_byte_size === expected.byteSize && receipt.role_policy_revision === row.role_policy_revision
          && receipt.created_at === row.created_at && text(receipt.candidate_asset_id, 256) && text(receipt.candidate_object_key, 4096), "frozen per-file expectation");
        validateRecordedRoleTarget(tables, receipt.role_policy_revision, receipt.purpose, receipt.storage_profile_id, receipt.storage_profile_revision, receipt.created_at);
        ensure(["pending", "ready", "cancelled"].includes(String(receipt.status)), "per-file state");
        if (receipt.status === "pending") ensure(receipt.completed_at === null && receipt.result_file_id === null && receipt.result_location_id === null, "pending per-file result");
        else {
          ensure(typeof receipt.completed_at === "string" && Number.isFinite(Date.parse(receipt.completed_at))
            && receipt.completed_at >= String(receipt.created_at), "per-file completion");
          ensure(receipt.status === "ready" ? text(receipt.result_file_id, 256) && text(receipt.result_location_id, 256)
            : receipt.result_file_id === null && receipt.result_location_id === null, "per-file result identity");
        }
        if (row.status === "ready") ensure(receipt.status === "ready", "published import requires accepted item bytes");
      }
    }

    if (row.status !== "ready") {
      ensure(row.accepted_result_json === null, "unpublished result");
      continue;
    }
    const result = jsonObject(row.accepted_result_json, 4096);
    // Publication SQL counts json_each members, including duplicate keys.
    // Strip complete string tokens before counting this flat receipt's colons
    // so escaped quotes/colons inside an opaque ID cannot imitate a member.
    const resultMembers = (String(row.accepted_result_json).replace(/"(?:\\.|[^"\\])*"/g, '""').match(/:/g) ?? []).length;
    ensure(resultMembers === 3 && Object.keys(result).sort().join(",") === "id,templateVersionId,version" && result.id === row.id
      && text(result.templateVersionId, 256) && result.templateVersionId === row.template_version_id
      && Number.isSafeInteger(result.version) && Number(result.version) >= 1,
      "published result");
    // A durable result is an historical receipt. Its Template may subsequently
    // be deleted; validating it must not depend on a live Template foreign row.
    ensure(text(row.finalization_id, 256) && typeof row.completed_at === "string" && row.lease_expires_at === null,
      "publication evidence");
  }
  const parents = new Map(tables.imports.map(row => [row.id, row]));
  const candidates = new Set<string>();
  for (const receipt of tables.import_file_acceptances) {
    ensure(parents.get(receipt.import_id)?.file_targets_protocol === 1, "per-file parent owner");
    const identity = stableJson([receipt.storage_profile_id, receipt.candidate_object_key]);
    ensure(!candidates.has(identity), "per-file physical candidate identity"); candidates.add(identity);
  }
}

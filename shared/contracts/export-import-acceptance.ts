import type { ExportTables } from "./export";
import { MAX_FABUBLOX_REQUEST_INPUT_BYTES, normalizeFabubloxImportRequestId } from "./fabublox-import";
import { sha256Hex, stableJson } from "../domain/content-addressing";

// Frozen schema-10 additions. This profile keeps the File registry dormant and
// records the accepted import decision on its existing execution authority.
export const IMPORT_ACCEPTANCE_EXPORT_COLUMNS = [
  "client_request_id", "request_sha256", "request_input_json", "request_scope", "storage_profile_id",
  "storage_profile_revision", "storage_policy_revision", "accepted_result_json",
] as const;

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

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}
function byteInput(value: unknown, purpose: "provenance" | "embedded_content", image: boolean) {
  ensure(value && typeof value === "object" && !Array.isArray(value), "byte input object");
  const entry = value as Record<string, unknown>;
  ensure(exactKeys(entry, ["sha256", "byteSize", "mimeType", "originalName", "purpose", ...(image ? ["localId"] : [])]),
    "byte input columns");
  ensure(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256)
    && typeof entry.byteSize === "number" && Number.isSafeInteger(entry.byteSize) && entry.byteSize >= 0
    && typeof entry.mimeType === "string" && typeof entry.originalName === "string" && entry.purpose === purpose,
    "byte input metadata");
  if (image) ensure(typeof entry.localId === "string" && entry.localId.length > 0, "image identity");
  return entry;
}

export function validateImportRequestInput(input: Record<string, unknown>) {
  ensure(exactKeys(input, ["schema", "workbook", "manifest", "images"])
    && input.schema === "fabublox-import-request/1" && Array.isArray(input.images), "request input schema");
  const workbook = byteInput(input.workbook, "provenance", false);
  const manifest = byteInput(input.manifest, "provenance", false);
  ensure(manifest.mimeType === "application/json" && manifest.originalName === "manifest.json", "manifest metadata");
  const ids = new Set<string>();
  for (const image of input.images) {
    const entry = byteInput(image, "embedded_content", true);
    ensure(!ids.has(entry.localId as string), "duplicate image identity");
    ids.add(entry.localId as string);
  }
  return { workbook, manifest };
}

export async function validateImportAcceptance(tables: ExportTables) {
  const identities = new Set<string>();
  const profiles = new Map(tables.storage_profiles.map((row) => [row.id, row]));
  for (const row of tables.imports) {
    if (IMPORT_ACCEPTANCE_EXPORT_COLUMNS.every((column) => row[column] === null)) continue;
    ensure(IMPORT_ACCEPTANCE_EXPORT_COLUMNS.slice(0, -1).every((column) => row[column] !== null), "incomplete decision");
    ensure(typeof row.client_request_id === "string" && normalizeFabubloxImportRequestId(row.client_request_id) === row.client_request_id,
      "request identity");
    ensure(text(row.id, 256) && text(row.actor_email, 256) && text(row.operation_id, 256), "operation identity");
    const identity = JSON.stringify([row.actor_email, row.client_request_id]);
    ensure(!identities.has(identity), "duplicate request identity");
    identities.add(identity);
    ensure(row.request_scope === "system" && row.storage_profile_revision === 1 && row.storage_policy_revision === 1,
      "scope or policy revision");
    const profile = profiles.get(row.storage_profile_id);
    ensure(profile && profile.adapter_type === "r2" && profile.configuration_revision === row.storage_profile_revision,
      "profile identity or revision");
    const input = jsonObject(row.request_input_json, MAX_FABUBLOX_REQUEST_INPUT_BYTES);
    const { workbook } = validateImportRequestInput(input);
    ensure(stableJson(input) === row.request_input_json, "noncanonical request input");
    ensure(row.source_filename === workbook.originalName && row.source_sha256 === workbook.sha256, "source metadata");
    ensure(typeof row.request_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.request_sha256)
      && row.request_sha256 === await sha256Hex(row.request_input_json as string), "request hash");
    ensure(["pending", "ready", "failed"].includes(String(row.status)), "publication state");
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
}

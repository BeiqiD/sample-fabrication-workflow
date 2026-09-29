import type { ExportRow, ExportSchemaObject, ExportTables, FileShadowSourceRowids } from "./export";
import { stableJson } from "../domain/content-addressing";
import { FILE_AUTHORITY_CONSUMER_COLUMNS } from "./export-file-authority";
import { fileShadowSchemaFingerprint, validateFileShadowRows } from "./export-file-shadow";
import { validateFileShadowWithdrawalRows } from "./export-file-shadow-withdrawals";
import { validateFileShadowAdjudicationRows } from "./export-file-shadow-adjudications";

/** Independent V18 checkpoint; older generation fingerprints remain frozen. */
export const FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 = "118ecb102a7eca186f64c0ca8e66128e3842e29b75237a1c39f71e503e56415c";
/** Installation-local execution admission is rebuilt disabled, never portable. */
export const FILE_AUTHORITY_RUNTIME_LOCAL_TABLE_NAMES = ["file_authority_runtime_guard"] as const;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid File runtime ${reason}`);
}
function parsed(value: unknown): Record<string, any> {
  let result: unknown;
  try { result = typeof value === "string" ? JSON.parse(value) : null; } catch { /* rejected below */ }
  ensure(result && typeof result === "object" && !Array.isArray(result), "receipt JSON");
  return result as Record<string, any>;
}
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const index = (tables: ExportTables, name: string, key = "id") => new Map(tables[name].map(row => [row[key], row]));
const candidateKey = (row: ExportRow) => stableJson([row.acceptance_kind, row.acceptance_id, row.item_id]);

/** Validate retained provenance, not today's lease, profile availability or
 * business-row liveness. None of these archive records authorize provider I/O. */
export function validateFileRuntimeRows(tables: ExportTables): ReadonlySet<string> {
  const mode = tables.file_authority_control[0]?.mode;
  const profiles = index(tables, "storage_profiles"), files = index(tables, "files"), locations = index(tables, "file_locations");
  const publications = index(tables, "file_location_publications", "location_id"), filePublications = index(tables, "file_publications", "file_id");
  const r2 = index(tables, "r2_upload_requests"), metrology = index(tables, "metrology_reference_upload_requests"), imports = index(tables, "imports");
  const comments = index(tables, "comment_item_acceptances", "item_id"), parents = index(tables, "comment_submission_acceptances", "submission_id");
  const candidates = new Map<string, ExportRow>(), ownedFiles = new Set<unknown>(), ownedLocations = new Set<unknown>();
  const acceptedLocations = new Set<string>();
  for (const candidate of tables.file_acceptance_candidates) {
    const key = candidateKey(candidate), profile = profiles.get(candidate.storage_profile_id);
    ensure(mode !== "legacy" && !candidates.has(key) && profile && text(candidate.acceptance_id)
      && ["candidate", "ready", "cancelled"].includes(String(candidate.state)) && time(candidate.created_at)
      && !ownedFiles.has(candidate.candidate_file_id) && !ownedLocations.has(candidate.candidate_location_id), "candidate identity/state");
    candidates.set(key, candidate); ownedFiles.add(candidate.candidate_file_id); ownedLocations.add(candidate.candidate_location_id);
    let receipt: ExportRow | undefined, parent: ExportRow | undefined, input: Record<string, any> | undefined;
    if (candidate.acceptance_kind === "import_file") {
      receipt = imports.get(candidate.acceptance_id);
      ensure(receipt?.client_request_id !== null && receipt, "accepted import owner");
      const request = parsed(receipt.request_input_json);
      input = candidate.item_id === "workbook" ? request.workbook : candidate.item_id === "manifest" ? request.manifest
        : typeof candidate.item_id === "string" && candidate.item_id.startsWith("image:")
          ? request.images?.find((item: Record<string, any>) => `image:${item.localId}` === candidate.item_id) : undefined;
    } else {
      ensure(candidate.item_id === "", "single receipt item");
      receipt = candidate.acceptance_kind === "r2_upload" ? r2.get(candidate.acceptance_id)
        : candidate.acceptance_kind === "metrology_reference" ? metrology.get(candidate.acceptance_id)
          : candidate.acceptance_kind === "comment_item" ? comments.get(candidate.acceptance_id) : undefined;
      ensure(receipt, "accepted receipt owner");
      if (candidate.acceptance_kind === "comment_item") {
        parent = parents.get(receipt.submission_id);
        ensure(parent && parent.actor_email === receipt.actor_email, "Comment parent owner");
        input = { purpose: receipt.purpose, byteSize: receipt.expected_byte_size, sha256: receipt.expected_sha256 };
      } else input = { ...parsed(receipt.request_input_json).file, purpose: receipt.purpose };
      ensure(receipt.candidate_object_key === candidate.candidate_object_key, "receipt candidate locator");
    }
    ensure(receipt && input && profile.configuration_revision === receipt.storage_profile_revision
      && candidate.storage_profile_id === receipt.storage_profile_id && candidate.purpose === input.purpose
      && candidate.access_scope === (parent ?? receipt).request_scope
      && candidate.expected_byte_size === input.byteSize && candidate.expected_sha256 === input.sha256
      && Date.parse(String(receipt.created_at)) <= Date.parse(candidate.created_at), "frozen receipt expectation");
    const file = files.get(candidate.candidate_file_id), location = locations.get(candidate.candidate_location_id);
    ensure(file && location && file.id === location.file_id && location.storage_profile_id === candidate.storage_profile_id
      && location.object_key === candidate.candidate_object_key && file.purpose === candidate.purpose && file.access_scope === candidate.access_scope
      && file.expected_sha256 === candidate.expected_sha256 && file.expected_byte_size === candidate.expected_byte_size,
    "candidate File/location expectation");
    const publication = publications.get(candidate.candidate_location_id);
    if (publication) {
      ensure(mode === "active" && publication.verification_operation_id === (parent ?? receipt).operation_id
        && publication.file_id === candidate.candidate_file_id && publication.storage_profile_id === candidate.storage_profile_id
        && publication.object_key === candidate.candidate_object_key && publication.verified_sha256 === candidate.expected_sha256
        && publication.verified_byte_size === candidate.expected_byte_size
        && Date.parse(String(publication.verified_at)) >= Date.parse(candidate.created_at), "accepted publication provenance");
      acceptedLocations.add(String(publication.location_id));
    }
    if (candidate.state === "candidate") ensure(candidate.result_file_id === null && candidate.result_location_id === null && candidate.completed_at === null, "pending candidate result");
    else {
      ensure(time(candidate.completed_at) && Date.parse(candidate.completed_at) >= Date.parse(candidate.created_at), "candidate completion");
      if (candidate.state === "cancelled") ensure(candidate.result_file_id === null && candidate.result_location_id === null
        && !filePublications.has(candidate.candidate_file_id), "cancelled candidate result");
      else {
        const result = filePublications.get(candidate.result_file_id), resultLocation = publications.get(candidate.result_location_id);
        ensure(mode === "active" && publication && result && resultLocation && resultLocation.file_id === result.file_id
          && resultLocation.storage_profile_id === candidate.storage_profile_id && result.purpose === candidate.purpose
          && result.access_scope === candidate.access_scope && result.verified_byte_size === candidate.expected_byte_size
          && result.verified_sha256 === candidate.expected_sha256
          && (result.state === "retired" || result.active_location_id === candidate.result_location_id)
          && (candidate.result_file_id === candidate.candidate_file_id || !filePublications.has(candidate.candidate_file_id)), "ready candidate result provenance");
        if (candidate.purpose === "derived_preview") ensure(candidate.result_file_id === candidate.candidate_file_id
          && candidate.result_location_id === candidate.candidate_location_id, "client preview cannot claim reusable derivation");
        if (receipt.status === "ready") {
          const accepted = parsed(receipt.accepted_result_json);
          const objectKey = candidate.acceptance_kind === "r2_upload" ? accepted.key
            : candidate.acceptance_kind === "metrology_reference" ? accepted.reference?.assetKey
              : candidate.acceptance_kind === "comment_item" ? accepted.objectKey
                : candidate.item_id === "workbook" ? receipt.workbook_asset_key : candidate.item_id === "manifest" ? receipt.manifest_asset_key : resultLocation.object_key;
          ensure(objectKey === resultLocation.object_key, "immutable accepted result locator");
          const aliasId = candidate.acceptance_kind === "r2_upload" ? accepted.id
            : candidate.acceptance_kind === "metrology_reference" ? accepted.assetId : null;
          const alias = tables.assets.find(row => row.id === aliasId);
          if (alias) ensure(alias.r2_key === resultLocation.object_key && alias.sha256 === candidate.expected_sha256
            && alias.byte_size === candidate.expected_byte_size, "accepted asset alias");
          if (candidate.acceptance_kind === "metrology_reference") {
            const binding = tables.metrology_template_references.find(row => row.id === accepted.reference?.id);
            if (binding) ensure(binding.file_id === candidate.result_file_id && binding.asset_id === accepted.assetId
              && binding.template_version_id === receipt.template_version_id, "accepted metrology binding");
          }
          if (candidate.acceptance_kind === "comment_item") {
            const binding = tables.comment_submission_items.find(row => row.id === candidate.acceptance_id);
            if (binding) ensure(binding.file_id === candidate.result_file_id && binding.submission_id === receipt.submission_id, "accepted Comment binding");
          }
          if (candidate.acceptance_kind === "import_file" && ["workbook", "manifest"].includes(String(candidate.item_id))) {
            ensure(receipt[`${candidate.item_id}_file_id`] === candidate.result_file_id, "accepted import binding");
            if (candidate.item_id === "workbook") {
              const template = tables.template_versions.find(row => row.id === receipt.template_version_id);
              if (template) ensure(template.source_file_id === candidate.result_file_id, "accepted template source binding");
            }
          }
        }
      }
    }
  }
  // Validate all typed slots, including direct-key slots omitted by diagnostic
  // legacy views when their compatibility key is absent.
  const purposes: Record<string, string> = { state_representation_assets: "embedded_content", run_step_assets: "embedded_content",
    metrology_template_references: "research_source", run_step_comments: "embedded_content", state_verifications: "embedded_content",
    project_content_attachments: "research_source", attachment_derivatives: "derived_preview", imports: "provenance", template_versions: "provenance" };
  const hasDerivation = (derived: unknown, predicate: (row: ExportRow) => boolean) => tables.file_derivations.some(row =>
    row.derived_file_id === derived && row.trust_state === "verified" && filePublications.has(row.source_file_id) && predicate(row));
  for (const [name, columns] of Object.entries(FILE_AUTHORITY_CONSUMER_COLUMNS)) for (const row of tables[name]) for (const column of columns) {
    if (row[column] === null) continue;
    const publication = filePublications.get(row[column]);
    const purpose = name === "events" ? column === "thumbnail_file_id" ? "derived_preview" : "embedded_content"
      : name === "comment_submission_items" ? row.kind === "attachment" ? "research_source" : row.related_item_id === null ? "embedded_content" : "derived_preview" : purposes[name];
    ensure(mode === "active" && publication && publication.purpose === purpose, "typed binding publication/purpose");
    if (name === "attachment_derivatives") ensure(hasDerivation(row[column], d => d.generator === row.derivative_kind
      && d.generator_version === row.generator_version && d.source_verified_sha256 === row.source_sha256
      && filePublications.get(d.source_file_id)?.verified_byte_size === row.source_byte_size), "trusted attachment derivation");
    if (name === "events" && column === "thumbnail_file_id") ensure(hasDerivation(row[column], d => d.source_file_id === row.asset_file_id), "trusted event thumbnail derivation");
    if (name === "comment_submission_items" && purpose === "derived_preview") {
      const source = tables.comment_submission_items.find(item => item.id === row.related_item_id);
      const candidate = candidates.get(stableJson(["comment_item", row.id, ""])), receipt = comments.get(row.id);
      const acceptedPreview = candidate?.state === "ready" && candidate.result_file_id === row.file_id
        && candidate.candidate_file_id === row.file_id && receipt?.status === "ready" && receipt.submission_id === row.submission_id
        && source?.submission_id === row.submission_id && source.kind === "attachment";
      ensure(acceptedPreview || hasDerivation(row.file_id, d => d.source_file_id === source?.file_id), "Comment preview provenance");
    }
  }
  return acceptedLocations;
}

export async function validateFileRuntimeExport(tables: ExportTables, schemaObjects: ExportSchemaObject[], sourceRowids?: FileShadowSourceRowids) {
  ensure(await fileShadowSchemaFingerprint(schemaObjects) === FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256, "schema fingerprint");
  const acceptedPublicationLocations = validateFileRuntimeRows(tables);
  await validateFileShadowRows(tables, schemaObjects, sourceRowids, { acceptedPublicationLocations });
  await validateFileShadowWithdrawalRows(tables, schemaObjects);
  await validateFileShadowAdjudicationRows(tables, schemaObjects, { allowActive: true, schemaSha256: FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 });
}

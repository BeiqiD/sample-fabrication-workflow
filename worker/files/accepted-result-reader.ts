import type { FilePurpose } from "../../shared/contracts/files";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { FileAuthorityUnavailableError, readPublishedFile } from "./authority-reader";
import { ByteVerificationError, verifyByteStream } from "./byte-verification";
import { cloudflareSha256 } from "./storage-adapters/cloudflare-sha256";

/** The caller preserves receipt ownership, expiry and business visibility. Its
 * resolver must return only a currently usable publication bound to that exact
 * result. Neither receipt replay nor verification allocates or repairs a File. */
export async function verifyAcceptedResultFile(env: Env, input: {
  purpose: FilePurpose;
  expectedBytes: { byteSize: number; sha256: string };
  resolveFileId: () => Promise<string | null>;
}): Promise<boolean> {
  try {
    const fileId = await input.resolveFileId();
    if (!fileId) return false;
    const opened = await readPublishedFile(env, { fileId, purpose: input.purpose });
    if (opened.outcome === "missing") return false;
    if (opened.outcome !== "available") throw new FileAuthorityUnavailableError();
    await verifyByteStream(opened.body, input.expectedBytes, cloudflareSha256, "destination");
    return await input.resolveFileId() === fileId;
  } catch (error) {
    if (error instanceof ByteVerificationError && (error.reason === "size_mismatch" || error.reason === "hash_mismatch")) return false;
    throw new FileAuthorityUnavailableError();
  }
}

/** Ready receipts predating File candidates remain readable through an exact
 * typed consumer binding. Legacy keys here identify rows; they are never read.
 * A present but unfinished candidate is not permission to choose another File. */
export async function resolveAcceptedUploadResultFile(db: D1Database, input: {
  kind: "r2_upload" | "metrology_reference";
  receipt: { id: string; actor_email: string; operation_id: string; request_input_json: string; accepted_result_json: string | null };
}): Promise<string | null> {
  const table = input.kind === "r2_upload" ? "r2_upload_requests" : "metrology_reference_upload_requests";
  const bindings = input.kind === "r2_upload" ? `
    SELECT c.result_file_id file_id FROM receipt r JOIN file_acceptance_candidates c
      ON c.acceptance_kind='r2_upload' AND c.acceptance_id=r.id AND c.item_id=''
    WHERE c.state='ready' AND c.purpose=r.purpose AND c.access_scope=r.request_scope
      AND c.storage_profile_id=r.storage_profile_id
      AND c.expected_byte_size=json_extract(r.request_input_json,'$.file.byteSize')
      AND c.expected_sha256=json_extract(r.request_input_json,'$.file.sha256')
    UNION ALL
    SELECT consumer.file_id FROM receipt r JOIN assets a
      ON a.id=json_extract(r.accepted_result_json,'$.id') AND a.r2_key=json_extract(r.accepted_result_json,'$.key')
    JOIN file_consumer_projection consumer ON consumer.legacy_r2_object_key=a.r2_key
    WHERE (consumer.expected_purpose IS NULL OR consumer.expected_purpose=r.purpose)
      AND a.byte_size=json_extract(r.request_input_json,'$.file.byteSize')
      AND a.sha256=json_extract(r.request_input_json,'$.file.sha256')
      AND NOT EXISTS (SELECT 1 FROM file_acceptance_candidates c
        WHERE c.acceptance_kind='r2_upload' AND c.acceptance_id=r.id AND c.item_id='')
  ` : `
    SELECT mtr.file_id FROM receipt r JOIN metrology_template_references mtr
      ON mtr.id=json_extract(r.accepted_result_json,'$.reference.id') AND mtr.template_version_id=r.template_version_id
        AND mtr.asset_id=json_extract(r.accepted_result_json,'$.assetId')
    LEFT JOIN file_acceptance_candidates c
      ON c.acceptance_kind='metrology_reference' AND c.acceptance_id=r.id AND c.item_id=''
    WHERE mtr.deleted_at IS NULL AND mtr.superseded_by_occurrence_id IS NULL
      AND (c.acceptance_id IS NULL OR (c.state='ready' AND c.result_file_id=mtr.file_id
        AND c.purpose=r.purpose AND c.access_scope=r.request_scope AND c.storage_profile_id=r.storage_profile_id
        AND c.expected_byte_size=json_extract(r.request_input_json,'$.file.byteSize')
        AND c.expected_sha256=json_extract(r.request_input_json,'$.file.sha256')))
  `;
  try {
    const row = await primaryD1(db).prepare(`WITH receipt AS (
      SELECT r.* FROM ${table} r JOIN file_authority_control a ON a.singleton=1 AND a.mode='active'
      WHERE r.id=? AND r.actor_email=? AND r.operation_id=? AND r.status='ready' AND r.expires_at>?
        AND r.request_input_json=? AND r.accepted_result_json=?
    ), bindings AS (${bindings})
    SELECT f.file_id FROM bindings b JOIN file_usable_publications f ON f.file_id=b.file_id JOIN receipt r
      ON f.purpose=r.purpose AND f.access_scope=r.request_scope AND f.access_scope='system'
        AND f.verified_byte_size=json_extract(r.request_input_json,'$.file.byteSize')
        AND f.verified_sha256=json_extract(r.request_input_json,'$.file.sha256')
    ORDER BY f.file_id LIMIT 1`).bind(input.receipt.id, input.receipt.actor_email, input.receipt.operation_id,
      new Date().toISOString(), input.receipt.request_input_json, input.receipt.accepted_result_json)
      .first<{ file_id: string }>();
    return row?.file_id ?? null;
  } catch { throw new FileAuthorityUnavailableError(); }
}

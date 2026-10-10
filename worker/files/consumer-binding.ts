import { HTTPException } from "hono/http-exception";
import type { FilePurpose } from "../../shared/contracts/files";
import { primaryD1 } from "../d1-primary";
import { readFileAuthorityMode } from "./authority-reader";

export interface ConsumerFileInput {
  assetId?: string;
  assetKey?: string;
  storageObjectId?: string;
  /** Set only after the caller resolves an exact ready asset row with a NULL
   * legacy R2 key. External request values never choose this branch. */
  nativeAsset?: boolean;
  purpose: FilePurpose;
  /** A preview must already have verified derivation from this exact source. */
  sourceFileId?: string | null;
}

function selection(input: ConsumerFileInput) {
  if ([input.assetId, input.assetKey, input.storageObjectId].filter(value => value !== undefined).length !== 1) {
    throw new HTTPException(400, { message: "One exact file attachment is required" });
  }
  if (input.nativeAsset) {
    if (input.assetId === undefined || input.assetKey !== undefined || input.storageObjectId !== undefined) {
      throw new HTTPException(400, { message: "A native File requires its exact asset identifier" });
    }
    return nativeSelection(input);
  }
  const managed = input.storageObjectId !== undefined;
  const source = managed
    ? "SELECT id,provider,object_key,byte_size,sha256 FROM managed_storage_objects WHERE id=? AND status IN('ready','orphaned')"
    : `SELECT a.id,'r2' provider,a.r2_key object_key,a.byte_size,a.sha256 FROM assets a
       WHERE ${input.assetId !== undefined ? "a.id" : "a.r2_key"}=? AND a.status='ready'
         AND (a.import_id IS NULL OR EXISTS(SELECT 1 FROM imports i WHERE i.id=a.import_id AND i.status='ready'))`;
  const historicalKey = managed
    ? "p.legacy_managed_provider=s.provider AND p.legacy_managed_object_key=s.object_key"
    : "p.legacy_r2_object_key=s.object_key";
  return {
    sql: `WITH source AS (${source}), bindings AS (
      SELECT p.file_id FROM source s JOIN file_consumer_projection p ON ${historicalKey}
      WHERE p.expected_purpose IS NULL OR p.expected_purpose=?
      UNION
      SELECT c.result_file_id FROM source s JOIN file_authority_ready_candidate_aliases c
        ON c.result_object_key=s.object_key AND c.adapter_type=s.provider
      WHERE c.purpose=? AND (
        (c.acceptance_kind='r2_upload' AND EXISTS(SELECT 1 FROM r2_upload_requests r
          WHERE r.id=c.acceptance_id AND r.status='ready' AND json_extract(r.accepted_result_json,'$.id')=s.id))
        OR (c.acceptance_kind='metrology_reference' AND EXISTS(SELECT 1 FROM metrology_reference_upload_requests r
          WHERE r.id=c.acceptance_id AND r.status='ready' AND json_extract(r.accepted_result_json,'$.assetId')=s.id))
        OR (c.acceptance_kind='comment_item' AND EXISTS(SELECT 1 FROM comment_item_acceptances r
          JOIN comment_submission_acceptances parent ON parent.submission_id=r.submission_id
          WHERE r.item_id=c.acceptance_id AND r.status='ready' AND parent.status='ready' AND json_extract(r.accepted_result_json,'$.blobRecordId')=s.id))
        OR (c.acceptance_kind='import_file' AND EXISTS(SELECT 1 FROM imports r WHERE r.id=c.acceptance_id AND r.status='ready'))
      )
    ) SELECT f.file_id FROM bindings b JOIN file_usable_publications f ON f.file_id=b.file_id JOIN source s
      ON f.verified_byte_size=s.byte_size AND f.verified_sha256=s.sha256
      JOIN file_authority_control authority ON authority.singleton=1 AND authority.mode='active'
      WHERE f.purpose=? AND f.access_scope='system'
        AND (?<>'derived_preview' OR EXISTS(SELECT 1 FROM file_derivations d
          JOIN file_usable_publications original ON original.file_id=d.source_file_id
          WHERE d.derived_file_id=f.file_id AND d.source_file_id=? AND d.trust_state='verified'))
      ORDER BY f.file_id LIMIT 1`,
    bindings: [input.assetId ?? input.assetKey ?? input.storageObjectId!, input.purpose, input.purpose,
      input.purpose, input.purpose, input.sourceFileId ?? null],
  };
}

function nativeSelection(input: ConsumerFileInput) {
  return {
    sql: `WITH source AS (
      SELECT a.id,a.file_id,a.storage_profile_id,a.storage_profile_revision,a.object_key,a.byte_size,a.sha256
      FROM assets a JOIN storage_profiles profile ON profile.id=a.storage_profile_id
        AND profile.configuration_revision=a.storage_profile_revision AND profile.adapter_type='s3'
      WHERE a.id=? AND a.r2_key IS NULL AND a.status='ready'
        AND (a.import_id IS NULL OR EXISTS(SELECT 1 FROM imports i WHERE i.id=a.import_id AND i.status='ready'))
        AND EXISTS(SELECT 1 FROM file_location_publications recorded WHERE recorded.file_id=a.file_id
          AND recorded.storage_profile_id=a.storage_profile_id AND recorded.object_key=a.object_key
          AND recorded.verified_byte_size=a.byte_size AND recorded.verified_sha256=a.sha256)
    ), admitted AS (
      SELECT p.file_id FROM source s JOIN file_consumer_projection p ON p.file_id=s.file_id
      WHERE p.expected_purpose IS NULL OR p.expected_purpose=?
      UNION
      SELECT c.result_file_id FROM source s JOIN file_acceptance_candidates c ON c.result_file_id=s.file_id
      JOIN file_location_publications recorded ON recorded.location_id=c.result_location_id AND recorded.file_id=c.result_file_id
        AND recorded.storage_profile_id=s.storage_profile_id AND recorded.object_key=s.object_key
      WHERE c.state='ready' AND c.purpose=? AND c.storage_profile_id=s.storage_profile_id
        AND c.expected_byte_size=s.byte_size AND c.expected_sha256=s.sha256 AND (
          (c.acceptance_kind='r2_upload' AND EXISTS(SELECT 1 FROM r2_upload_requests r WHERE r.id=c.acceptance_id
            AND r.status='ready' AND json_extract(r.accepted_result_json,'$.id')=s.id))
          OR (c.acceptance_kind='metrology_reference' AND EXISTS(SELECT 1 FROM metrology_reference_upload_requests r
            WHERE r.id=c.acceptance_id AND r.status='ready' AND json_extract(r.accepted_result_json,'$.assetId')=s.id))
          OR (c.acceptance_kind='comment_item' AND EXISTS(SELECT 1 FROM comment_item_acceptances r
            JOIN comment_submission_acceptances parent ON parent.submission_id=r.submission_id
            WHERE r.item_id=c.acceptance_id AND r.status='ready' AND parent.status='ready'
              AND json_extract(r.accepted_result_json,'$.blobRecordId')=s.id))
          OR (c.acceptance_kind='import_file' AND EXISTS(SELECT 1 FROM imports r
            JOIN import_file_acceptances item ON item.import_id=r.id AND item.item_id=c.item_id
            WHERE r.id=c.acceptance_id AND r.status='ready' AND item.status='ready'
              AND item.result_file_id=s.file_id)))
    ) SELECT f.file_id FROM admitted binding JOIN source s ON s.file_id=binding.file_id
      JOIN file_usable_publications f ON f.file_id=binding.file_id
        AND f.verified_byte_size=s.byte_size AND f.verified_sha256=s.sha256
      JOIN file_authority_control authority ON authority.singleton=1 AND authority.mode='active'
      WHERE f.purpose=? AND f.access_scope='system'
        AND (?<>'derived_preview' OR EXISTS(SELECT 1 FROM file_derivations d
          JOIN file_usable_publications original ON original.file_id=d.source_file_id
          WHERE d.derived_file_id=f.file_id AND d.source_file_id=? AND d.trust_state='verified'))
      ORDER BY f.file_id LIMIT 1`,
    bindings: [input.assetId!, input.purpose, input.purpose, input.purpose, input.purpose, input.sourceFileId ?? null],
  };
}

/** Metadata-only admission through an existing typed occurrence or completed
 * acceptance. Matching content hashes alone never establish a binding. */
export async function resolveConsumerFileId(db: D1Database, input: ConsumerFileInput): Promise<string | null> {
  let mode;
  try { mode = await readFileAuthorityMode(db); }
  catch { throw new HTTPException(503, { message: "File storage is unavailable" }); }
  if (mode !== "active") return null;
  const query = selection(input);
  let row;
  try { row = await primaryD1(db).prepare(query.sql).bind(...query.bindings).first<{ file_id: string }>(); }
  catch { throw new HTTPException(503, { message: "File storage is unavailable" }); }
  if (!row) throw new HTTPException(409, { message: "The attachment has no available File for this purpose" });
  return row.file_id;
}

/** Execute before business writes in the same batch. Recheck the exact alias
 * and existing binding before a newly inserted consumer could attest to itself. */
export function consumerFileBindingFence(db: D1Database, input: ConsumerFileInput, fileId: string | null): D1PreparedStatement {
  if (fileId === null) return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control
    WHERE singleton=1 AND mode IN('legacy','overlap')) THEN 1 ELSE json('File authority changed') END`);
  const query = selection(input);
  return db.prepare(`SELECT CASE WHEN (SELECT file_id FROM (${query.sql}))=? THEN 1
    ELSE json('File attachment binding changed') END`).bind(...query.bindings, fileId);
}

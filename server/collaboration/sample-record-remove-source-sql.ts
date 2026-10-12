/** Pure observations and explicit text-only eligibility. These expressions
 * issue no grant and do not change the historical detail projection policy. */
export const SAMPLE_RECORD_REMOVE_SCHEMA_SQL = `
    SELECT
      (SELECT COUNT(*) FROM sqlite_schema
       WHERE type = 'table' AND name = 'file_authority_control') AS authority_tables,
      (SELECT COUNT(*) FROM pragma_table_info('run_step_assets') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('state_representation_assets') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('run_step_comments') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('events') WHERE name IN ('asset_file_id', 'thumbnail_file_id')) AS file_columns
  `;

const canonicalEvent = `EXISTS (
  SELECT 1 FROM comment_submission_acceptances acceptance,
    json_each(CASE WHEN json_valid(acceptance.publication_plan_json)
      THEN acceptance.publication_plan_json ELSE '{}' END,'$.events') planned
  WHERE CASE WHEN planned.type='object' THEN json_extract(planned.value,'$.id') ELSE NULL END=event.id
) OR EXISTS (
  SELECT 1 FROM comment_submission_acceptances acceptance,
    json_each(CASE WHEN json_valid(acceptance.accepted_result_json)
      THEN acceptance.accepted_result_json ELSE '{}' END,'$.eventIds') accepted
  WHERE accepted.type='text' AND accepted.value=event.id
)`;

/** Before the original private event SELECT, only the exact media-free
 * legacy createRecord shape is eligible. Missing records still reach the
 * original 404. After original COMMIT its exact owned deletion metadata is
 * compared separately; no generic deleted/unknown shape is enabled. */
export function sampleRecordRemoveTextEligibilitySql(accepted: boolean) {
  return `SELECT 1 admitted WHERE NOT EXISTS (
    SELECT 1 FROM events event WHERE event.id=? AND event.sample_id=? AND (
      event.kind<>'comment' OR event.asset_key IS NOT NULL
      OR event.asset_file_id IS NOT NULL OR event.thumbnail_file_id IS NOT NULL
      ${accepted ? "" : `OR CASE WHEN json_valid(event.metadata_json) THEN
        CASE WHEN json_type(event.metadata_json)='object'
          AND json_type(event.metadata_json,'$.action')='text'
          AND json_extract(event.metadata_json,'$.action') IS 'sample_record'
          AND (SELECT count(*) FROM json_each(event.metadata_json))=1
          AND (SELECT count(DISTINCT key) FROM json_each(event.metadata_json))=1
          THEN 0 ELSE 1 END ELSE 1 END`}
      OR (${canonicalEvent})
    )
  )`;
}

export const SAMPLE_RECORD_REMOVE_SOURCE_CAPTURE_SQL = `SELECT json_array(sample.updated_at,
  json((SELECT json_array(event.id,event.sample_id,event.kind,event.body,event.asset_key,
    event.asset_file_id,event.thumbnail_file_id,event.metadata_json,event.actor_email,event.created_at)
   FROM events event WHERE event.id=? AND event.sample_id=sample.id))) state
  FROM samples sample WHERE sample.id=?`;
export const SAMPLE_RECORD_REMOVE_SOURCE_CHECK_SQL = `SELECT 1 admitted WHERE
  (${SAMPLE_RECORD_REMOVE_SOURCE_CAPTURE_SQL}) IS ?`;
/** Derive the expected changed cell with the original SQLite JSON encoding,
 * from the original owned mutation bind. Preserve every source event cell
 * and its actual Sample owner; never infer provenance from a deletion label. */
export const SAMPLE_RECORD_REMOVE_ACCEPTED_CHECK_SQL = `SELECT 1 admitted WHERE
  (SELECT json_array(event.id,event.sample_id,event.kind,event.body,event.asset_key,
    event.asset_file_id,event.thumbnail_file_id,event.metadata_json,event.actor_email,event.created_at)
   FROM events event WHERE event.id=? AND event.sample_id=?)
  IS json_extract(json_set(?, '$[1][7]', ?), '$[1]')`;

PRAGMA foreign_keys = ON;

-- Explicitly deleting one direct Run-step attachment is different from moving
-- the whole Run to Trash and from FabuBlox recovery supersession. Active
-- occurrences, including occurrences under a recoverably deleted Run, remain
-- durable. Recovery-superseded occurrence identities remain excluded because
-- their byte-retention edge was transferred to the canonical survivor in
-- migration 0028. Only an ordinary deleted, non-superseded occurrence
-- transitions to a bounded 24-hour edge.
DROP VIEW blob_retention_edges;
DROP VIEW blob_retention_edges_r2_occurrences;

CREATE VIEW blob_retention_edges_r2_occurrences AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'state_representation' AS source_type,
  sra.state_hash AS source_id,
  'state_representation_asset' AS occurrence_type,
  sra.state_hash || ':' || sra.asset_id AS occurrence_id,
  'state_representation' AS retention_reason,
  NULL AS retain_until
FROM state_representation_assets sra
JOIN assets a ON a.id = sra.asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'run_step', rsa.run_step_id,
  'run_step_asset', rsa.id,
  CASE WHEN rsa.deleted_at IS NULL
    THEN 'run_step_asset'
    ELSE 'deleted_run_step_asset_grace'
  END,
  CASE WHEN rsa.deleted_at IS NULL
    THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', rsa.deleted_at, '+1 day')
  END
FROM run_step_assets rsa
JOIN assets a ON a.id = rsa.asset_id
WHERE rsa.superseded_by_occurrence_id IS NULL
  AND (
    rsa.deleted_at IS NULL
    OR datetime(rsa.deleted_at, '+1 day') > datetime('now')
  )

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'template_version', mtr.template_version_id,
  'metrology_template_reference', mtr.id,
  'metrology_template_reference', NULL
FROM metrology_template_references mtr
JOIN assets a ON a.id = mtr.asset_id
WHERE mtr.superseded_by_occurrence_id IS NULL

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'run_step_comment', rsc.id,
  'run_step_comment_asset', rsc.id,
  'legacy_comment_asset', NULL
FROM run_step_comments rsc
JOIN assets a ON a.id = rsc.asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'state_verification', sv.id,
  'state_verification_evidence', sv.id,
  'verification_evidence', NULL
FROM state_verifications sv
JOIN assets a ON a.id = sv.evidence_asset_id;

CREATE VIEW blob_retention_edges AS
SELECT * FROM blob_retention_edges_r2_occurrences
UNION ALL
SELECT * FROM blob_retention_edges_comment_items
UNION ALL
SELECT * FROM blob_retention_edges_direct_keys
UNION ALL
SELECT * FROM blob_retention_edges_project_attachments;

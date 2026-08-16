PRAGMA foreign_keys = ON;

-- Physical retention and public availability are intentionally different
-- questions. blob_retention_edges remains the sole GC surface. These views are
-- narrower recovery-only projections that identify consumers allowed to make a
-- failed-import asset public, and unresolved imports that can inherit private
-- ownership without publishing it.
CREATE VIEW fabublox_recovery_public_asset_edges_external AS
SELECT
  bre.blob_record_id AS asset_id,
  bre.source_type AS consumer_type,
  bre.source_id AS consumer_id
FROM blob_retention_edges bre
WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
  AND bre.blob_record_id IS NOT NULL
  AND bre.source_type NOT IN ('state_representation', 'template_version', 'import');

CREATE VIEW fabublox_recovery_public_asset_edges_state AS
SELECT
  sra.asset_id,
  'template_version_initial_state' AS consumer_type,
  tv.id AS consumer_id
FROM state_representation_assets sra
JOIN template_versions tv ON tv.initial_state_hash = sra.state_hash
WHERE NOT EXISTS (
  SELECT 1 FROM imports owner
  WHERE owner.template_version_id = tv.id AND owner.status <> 'ready'
)

UNION ALL
SELECT
  sra.asset_id,
  'template_step_expected_state',
  ts.id
FROM state_representation_assets sra
JOIN template_steps ts ON ts.expected_state_hash = sra.state_hash
JOIN template_versions tv ON tv.id = ts.template_version_id
WHERE NOT EXISTS (
  SELECT 1 FROM imports owner
  WHERE owner.template_version_id = tv.id AND owner.status <> 'ready'
)

UNION ALL
SELECT
  sra.asset_id,
  'run_step_expected_state',
  rs.id
FROM state_representation_assets sra
JOIN run_steps rs ON rs.expected_state_hash = sra.state_hash

UNION ALL
SELECT
  sra.asset_id,
  'run_initial_state',
  r.id
FROM state_representation_assets sra
JOIN runs r ON r.initial_state_hash = sra.state_hash

UNION ALL
SELECT
  sra.asset_id,
  'sample_inherited_state',
  s.id
FROM state_representation_assets sra
JOIN samples s ON s.inherited_state_hash = sra.state_hash;

CREATE VIEW fabublox_recovery_public_asset_edges_template AS
SELECT
  sra.asset_id,
  'state_verification_expected_state' AS consumer_type,
  sv.id AS consumer_id
FROM state_representation_assets sra
JOIN state_verifications sv ON sv.expected_state_hash = sra.state_hash

UNION ALL
SELECT
  mtr.asset_id,
  'published_metrology_template_reference',
  mtr.id
FROM metrology_template_references mtr
WHERE NOT EXISTS (
  SELECT 1 FROM imports owner
  WHERE owner.template_version_id = mtr.template_version_id
    AND owner.status <> 'ready'
)

UNION ALL
SELECT
  a.id,
  'published_template_source',
  tv.id
FROM template_versions tv
JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE tv.source_asset_key IS NOT NULL AND tv.source_asset_key <> ''
  AND NOT EXISTS (
    SELECT 1 FROM imports owner
    WHERE owner.template_version_id = tv.id AND owner.status <> 'ready'
  )

UNION ALL
SELECT
  a.id,
  'ready_import_provenance',
  i.id
FROM imports i
JOIN assets a
  ON a.r2_key = i.workbook_asset_key OR a.r2_key = i.manifest_asset_key
WHERE i.status = 'ready';

CREATE VIEW fabublox_recovery_public_asset_edges AS
SELECT * FROM fabublox_recovery_public_asset_edges_external
UNION ALL
SELECT * FROM fabublox_recovery_public_asset_edges_state
UNION ALL
SELECT * FROM fabublox_recovery_public_asset_edges_template;

CREATE VIEW fabublox_recovery_import_asset_edges AS
SELECT
  sra.asset_id,
  i.id AS import_id,
  i.status AS import_status,
  i.created_at AS import_created_at
FROM state_representation_assets sra
JOIN template_versions tv ON tv.initial_state_hash = sra.state_hash
JOIN imports i ON i.template_version_id = tv.id
WHERE i.status IN ('pending', 'failed') AND i.finalization_id IS NULL
  AND (i.status = 'pending' OR i.recovery_operation_id IS NULL)

UNION ALL
SELECT
  sra.asset_id,
  i.id,
  i.status,
  i.created_at
FROM state_representation_assets sra
JOIN template_steps ts ON ts.expected_state_hash = sra.state_hash
JOIN imports i ON i.template_version_id = ts.template_version_id
WHERE i.status IN ('pending', 'failed') AND i.finalization_id IS NULL
  AND (i.status = 'pending' OR i.recovery_operation_id IS NULL)

UNION ALL
SELECT
  mtr.asset_id,
  i.id,
  i.status,
  i.created_at
FROM metrology_template_references mtr
JOIN imports i ON i.template_version_id = mtr.template_version_id
WHERE i.status IN ('pending', 'failed') AND i.finalization_id IS NULL
  AND (i.status = 'pending' OR i.recovery_operation_id IS NULL)

UNION ALL
SELECT
  a.id,
  i.id,
  i.status,
  i.created_at
FROM imports i
JOIN template_versions tv ON tv.id = i.template_version_id
JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE i.status IN ('pending', 'failed') AND i.finalization_id IS NULL
  AND (i.status = 'pending' OR i.recovery_operation_id IS NULL)

UNION ALL
SELECT
  a.id,
  i.id,
  i.status,
  i.created_at
FROM imports i
JOIN assets a
  ON a.r2_key = i.workbook_asset_key OR a.r2_key = i.manifest_asset_key
WHERE i.status IN ('pending', 'failed') AND i.finalization_id IS NULL
  AND (i.status = 'pending' OR i.recovery_operation_id IS NULL);

-- A pending import may inherit a private shared locator from another failed
-- import. It may finalize only after every inherited asset is again physically
-- publishable. The ordinary finalization trigger will then activate pending
-- assets atomically with the import.
CREATE TRIGGER imports_require_publishable_assets
BEFORE UPDATE OF status ON imports
WHEN OLD.status = 'pending' AND NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE EXISTS (
    SELECT 1
    FROM assets a
    WHERE a.import_id = NEW.id
      AND (
        a.status NOT IN ('pending', 'ready')
        OR a.sha256 IS NULL
        OR EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        OR EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
      )
  );
END;

CREATE INDEX imports_recovery_successor_idx
ON imports(status, recovery_operation_id, created_at, id)
WHERE finalization_id IS NULL AND status IN ('pending', 'failed');

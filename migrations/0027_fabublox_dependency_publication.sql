PRAGMA foreign_keys = ON;

-- Final publication must validate the complete asset dependency graph, not only
-- rows currently owned through assets.import_id. Recovery and finalization use
-- the same dependency surface so ownership transfer cannot hide a quarantined
-- or otherwise unpublished state image from the import that still requires it.
--
-- Keep every compound-select leaf at five terms or fewer for workerd/D1.

CREATE VIEW fabublox_import_asset_dependencies_template AS
SELECT
  i.id AS import_id,
  sra.asset_id,
  'template_initial_state' AS dependency_type,
  tv.id AS dependency_id
FROM imports i
JOIN template_versions tv ON tv.id = i.template_version_id
JOIN state_representation_assets sra
  ON sra.state_hash = tv.initial_state_hash
WHERE i.template_version_id IS NOT NULL
  AND tv.initial_state_hash IS NOT NULL

UNION ALL
SELECT
  i.id,
  sra.asset_id,
  'template_step_expected_state',
  ts.id
FROM imports i
JOIN template_steps ts ON ts.template_version_id = i.template_version_id
JOIN state_representation_assets sra
  ON sra.state_hash = ts.expected_state_hash
WHERE i.template_version_id IS NOT NULL
  AND ts.expected_state_hash IS NOT NULL

UNION ALL
SELECT
  i.id,
  mtr.asset_id,
  'metrology_template_reference',
  mtr.id
FROM imports i
JOIN metrology_template_references mtr
  ON mtr.template_version_id = i.template_version_id
WHERE i.template_version_id IS NOT NULL

UNION ALL
SELECT
  i.id,
  a.id,
  'template_source',
  tv.id
FROM imports i
JOIN template_versions tv ON tv.id = i.template_version_id
LEFT JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE i.template_version_id IS NOT NULL
  AND NULLIF(TRIM(tv.source_asset_key), '') IS NOT NULL;

CREATE VIEW fabublox_import_asset_dependencies_provenance AS
SELECT
  i.id AS import_id,
  a.id AS asset_id,
  'owned_asset' AS dependency_type,
  a.id AS dependency_id
FROM imports i
JOIN assets a ON a.import_id = i.id

UNION ALL
SELECT
  i.id,
  a.id,
  'import_workbook',
  i.id || ':workbook'
FROM imports i
JOIN assets a ON a.r2_key = i.workbook_asset_key
WHERE i.workbook_asset_key IS NOT NULL
  AND i.workbook_asset_key <> ''

UNION ALL
SELECT
  i.id,
  a.id,
  'import_manifest',
  i.id || ':manifest'
FROM imports i
JOIN assets a ON a.r2_key = i.manifest_asset_key
WHERE i.manifest_asset_key IS NOT NULL
  AND i.manifest_asset_key <> '';

CREATE VIEW fabublox_import_asset_dependencies AS
SELECT * FROM fabublox_import_asset_dependencies_template
UNION ALL
SELECT * FROM fabublox_import_asset_dependencies_provenance;

-- Recovery successor selection is now a filtered projection of the same graph
-- used by publication. This prevents the two state machines from silently
-- diverging as new FabuBlox asset relationships are added.
DROP VIEW fabublox_recovery_import_asset_edges;

CREATE VIEW fabublox_recovery_import_asset_edges AS
SELECT DISTINCT
  dependency.asset_id,
  i.id AS import_id,
  i.status AS import_status,
  i.created_at AS import_created_at
FROM fabublox_import_asset_dependencies dependency
JOIN imports i ON i.id = dependency.import_id
WHERE dependency.asset_id IS NOT NULL
  AND i.status IN ('pending', 'failed')
  AND i.finalization_id IS NULL
  AND (i.status = 'pending' OR i.recovery_operation_id IS NULL);

DROP TRIGGER imports_require_publishable_assets;

CREATE TRIGGER imports_require_publishable_assets
BEFORE UPDATE OF status ON imports
WHEN OLD.status = 'pending' AND NEW.status = 'ready'
BEGIN
  -- Publication must resolve the staged template identity before validating
  -- any asset edge. imports.template_version_id is intentionally nullable and
  -- has no foreign key in the legacy schema.
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.template_version_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM template_versions tv
      WHERE tv.id = NEW.template_version_id
    );

  -- The final UPDATE supplies workbook/manifest keys through NEW, so validate
  -- them explicitly; a view over imports still observes the OLD pending row.
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.workbook_asset_key IS NULL
    OR NULLIF(TRIM(NEW.workbook_asset_key), '') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM assets a
      WHERE a.r2_key = NEW.workbook_asset_key
        AND a.sha256 IS NOT NULL
        AND (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );

  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.manifest_asset_key IS NULL
    OR NULLIF(TRIM(NEW.manifest_asset_key), '') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM assets a
      WHERE a.r2_key = NEW.manifest_asset_key
        AND a.sha256 IS NOT NULL
        AND (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );

  -- Every dependency of the staged template must either be a healthy pending
  -- asset owned by this exact import or an already-published healthy asset.
  -- In particular, a standalone failed/quarantined asset retained by a Sample
  -- or Run can preserve bytes/history but cannot make this import publishable.
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE EXISTS (
    SELECT 1
    FROM fabublox_import_asset_dependencies dependency
    LEFT JOIN assets a ON a.id = dependency.asset_id
    WHERE dependency.import_id = NEW.id
      AND (
        a.id IS NULL
        OR a.sha256 IS NULL
        OR NOT (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
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

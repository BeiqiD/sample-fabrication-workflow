PRAGMA foreign_keys = ON;

-- Timeline rows are a mutable projection of the currently actionable
-- execution-image occurrence. Stable legacy occurrence IDs remain in the
-- occurrence table and Reference registry, while Timeline actions follow the
-- one-hop immutable supersession survivor in the same D1 transaction.
CREATE TRIGGER run_step_assets_sync_supersession_timeline
AFTER UPDATE OF superseded_by_occurrence_id ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND NEW.superseded_by_occurrence_id IS NOT NULL
BEGIN
  UPDATE events
  SET asset_key = CASE
        WHEN asset_key = (
          SELECT legacy_asset.r2_key
          FROM assets legacy_asset
          WHERE legacy_asset.id = OLD.asset_id
        )
        THEN (
          SELECT survivor_asset.r2_key
          FROM run_step_assets survivor
          JOIN assets survivor_asset ON survivor_asset.id = survivor.asset_id
          WHERE survivor.id = NEW.superseded_by_occurrence_id
        )
        ELSE asset_key
      END,
      metadata_json = json_set(
        metadata_json,
        '$.supersededRunStepAssetId',
        COALESCE(
          json_extract(metadata_json, '$.supersededRunStepAssetId'),
          NEW.id
        ),
        '$.runStepAssetId',
        NEW.superseded_by_occurrence_id
      )
  WHERE json_valid(metadata_json)
    AND json_type(metadata_json, '$.runStepAssetId') = 'text'
    AND CAST(json_extract(metadata_json, '$.runStepAssetId') AS TEXT) = NEW.id;

  UPDATE events
  SET metadata_json = json_set(
        metadata_json,
        '$.thumbnailKey',
        (
          SELECT survivor_asset.r2_key
          FROM run_step_assets survivor
          JOIN assets survivor_asset ON survivor_asset.id = survivor.asset_id
          WHERE survivor.id = NEW.superseded_by_occurrence_id
        )
      )
  WHERE json_valid(metadata_json)
    AND json_type(metadata_json, '$.thumbnailKey') = 'text'
    AND CAST(json_extract(metadata_json, '$.thumbnailKey') AS TEXT) = (
      SELECT legacy_asset.r2_key
      FROM assets legacy_asset
      WHERE legacy_asset.id = OLD.asset_id
    );
END;

PRAGMA foreign_keys = ON;

ALTER TABLE run_step_comments
ADD COLUMN asset_id TEXT REFERENCES assets(id);

CREATE INDEX run_step_comments_asset_idx
ON run_step_comments(asset_id)
WHERE asset_id IS NOT NULL;

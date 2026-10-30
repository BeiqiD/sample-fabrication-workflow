CREATE INDEX IF NOT EXISTS runs_family_kind_status_sample_idx
ON runs(recipe_family_id, run_kind, status, sample_id);

CREATE INDEX IF NOT EXISTS samples_directory_idx
ON samples(pinned DESC, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS runs_sample_kind_sequence_idx
ON runs(sample_id, run_kind, sequence_no DESC);

CREATE INDEX IF NOT EXISTS run_steps_directory_state_idx
ON run_steps(run_id, entry_kind, plan_status, status, position);

CREATE INDEX IF NOT EXISTS template_versions_kind_family_version_idx
ON template_versions(template_kind, archived_at, recipe_family_id, version DESC);

CREATE INDEX IF NOT EXISTS template_versions_kind_name_idx
ON template_versions(template_kind, archived_at, name, template_type, version DESC);

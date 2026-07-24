ALTER TABLE template_versions
ADD COLUMN template_kind TEXT NOT NULL DEFAULT 'process'
CHECK (template_kind IN ('process', 'metrology'));

ALTER TABLE template_versions
ADD COLUMN metrology_notes TEXT;

ALTER TABLE runs
ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'process'
CHECK (run_kind IN ('process', 'metrology'));

ALTER TABLE run_steps
ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'fabrication'
CHECK (entry_kind IN ('fabrication', 'metrology'));

CREATE TABLE metrology_template_references (
  id TEXT PRIMARY KEY,
  template_version_id TEXT NOT NULL REFERENCES template_versions(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  display_name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(template_version_id, asset_id)
);

CREATE INDEX metrology_template_references_template_idx
ON metrology_template_references(template_version_id, position, created_at);

DROP INDEX runs_one_active_per_sample_idx;

CREATE UNIQUE INDEX runs_one_active_process_per_sample_idx
ON runs(sample_id)
WHERE status = 'active' AND run_kind = 'process';

DROP TRIGGER runs_activate_sample_after_insert;
DROP TRIGGER runs_activate_sample_after_reopen;
DROP TRIGGER runs_store_sample_after_completion;
DROP TRIGGER run_step_status_rollup;

CREATE TRIGGER runs_activate_sample_after_insert
AFTER INSERT ON runs
WHEN NEW.status = 'active' AND NEW.run_kind = 'process'
BEGIN
  UPDATE samples
  SET status = 'active',
      updated_by = COALESCE(NEW.created_by, updated_by),
      updated_at = CASE
        WHEN NEW.created_at > updated_at THEN NEW.created_at
        ELSE updated_at
      END
  WHERE id = NEW.sample_id AND status != 'active';
END;

CREATE TRIGGER runs_activate_sample_after_reopen
AFTER UPDATE OF status ON runs
WHEN OLD.status != 'active' AND NEW.status = 'active' AND NEW.run_kind = 'process'
BEGIN
  UPDATE samples
  SET status = 'active',
      updated_by = COALESCE(
        (
          SELECT actor_email
          FROM run_plan_revisions
          WHERE run_id = NEW.id
          ORDER BY revision_no DESC
          LIMIT 1
        ),
        NEW.created_by,
        updated_by
      ),
      updated_at = CASE
        WHEN COALESCE(
          (
            SELECT created_at
            FROM run_plan_revisions
            WHERE run_id = NEW.id
            ORDER BY revision_no DESC
            LIMIT 1
          ),
          NEW.created_at
        ) > updated_at
        THEN COALESCE(
          (
            SELECT created_at
            FROM run_plan_revisions
            WHERE run_id = NEW.id
            ORDER BY revision_no DESC
            LIMIT 1
          ),
          NEW.created_at
        )
        ELSE updated_at
      END
  WHERE id = NEW.sample_id AND status != 'active';
END;

CREATE TRIGGER runs_store_sample_after_completion
AFTER UPDATE OF status ON runs
WHEN OLD.status = 'active' AND NEW.status = 'complete' AND NEW.run_kind = 'process'
BEGIN
  UPDATE samples
  SET status = 'stored',
      updated_by = COALESCE(
        (
          SELECT updated_by
          FROM run_steps
          WHERE run_id = NEW.id
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        ),
        updated_by
      ),
      updated_at = CASE
        WHEN NEW.completed_at IS NOT NULL AND NEW.completed_at > updated_at
        THEN NEW.completed_at
        ELSE updated_at
      END
  WHERE id = NEW.sample_id
    AND status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM runs active
      WHERE active.sample_id = NEW.sample_id
        AND active.status = 'active'
        AND active.run_kind = 'process'
    );
END;

CREATE TRIGGER run_step_status_rollup
AFTER UPDATE OF status ON run_steps
WHEN OLD.status IS NOT NEW.status
BEGIN
  UPDATE runs
  SET status = CASE
        WHEN NOT EXISTS (
          SELECT 1
          FROM run_steps pending
          WHERE pending.run_id = NEW.run_id
            AND pending.plan_status = 'current'
            AND pending.status NOT IN ('done', 'skipped')
            AND pending.entry_kind = CASE
              WHEN runs.run_kind = 'metrology' THEN 'metrology'
              ELSE 'fabrication'
            END
        ) THEN 'complete'
        ELSE 'active'
      END,
      completed_at = CASE
        WHEN NOT EXISTS (
          SELECT 1
          FROM run_steps pending
          WHERE pending.run_id = NEW.run_id
            AND pending.plan_status = 'current'
            AND pending.status NOT IN ('done', 'skipped')
            AND pending.entry_kind = CASE
              WHEN runs.run_kind = 'metrology' THEN 'metrology'
              ELSE 'fabrication'
            END
        ) THEN NEW.updated_at
        ELSE NULL
      END
  WHERE id = NEW.run_id AND status NOT IN ('cancelled', 'superseded');
END;

INSERT OR IGNORE INTO step_definitions
  (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
VALUES
  ('b340e57f0b53f1d1f657f99ef1bd25c8b9b54dd442a1d50ae7ea7a936af409b5', 'step-definition/v1', 'SEM', NULL, NULL, NULL, '{"commentsText":null,"name":"SEM","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z'),
  ('f139b09ba3ea4362d62a582621083ab0f3cb2d7abdf7524867ec59deab52014f', 'step-definition/v1', 'TEM', NULL, NULL, NULL, '{"commentsText":null,"name":"TEM","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z'),
  ('9025873f845664d95a057cf912841db6ef58e9c56045422151cdf4bfe1aed953', 'step-definition/v1', 'AFM', NULL, NULL, NULL, '{"commentsText":null,"name":"AFM","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z'),
  ('5f9d9a7b109c964d38b31409327aa4679e66770f6ea806db913e506b80c3c23c', 'step-definition/v1', 'Optical microscope', NULL, NULL, NULL, '{"commentsText":null,"name":"Optical microscope","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z'),
  ('d17dc56cbd17d7edbd2290926580871834b226e6823c52bfe18af125dddecdae', 'step-definition/v1', 'XRD', NULL, NULL, NULL, '{"commentsText":null,"name":"XRD","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z');

INSERT OR IGNORE INTO recipe_families
  (id, name, template_type, created_at)
VALUES
  ('builtin-metrology-family-sem', 'Metrology template · builtin · SEM', 'module', '2026-07-24T00:00:00.000Z'),
  ('builtin-metrology-family-tem', 'Metrology template · builtin · TEM', 'module', '2026-07-24T00:00:00.000Z'),
  ('builtin-metrology-family-afm', 'Metrology template · builtin · AFM', 'module', '2026-07-24T00:00:00.000Z'),
  ('builtin-metrology-family-optical-microscope', 'Metrology template · builtin · Optical microscope', 'module', '2026-07-24T00:00:00.000Z'),
  ('builtin-metrology-family-xrd', 'Metrology template · builtin · XRD', 'module', '2026-07-24T00:00:00.000Z');

INSERT OR IGNORE INTO template_versions
  (id, recipe_family_id, name, template_type, version, manifest_hash, content_json,
   created_at, template_kind)
VALUES
  ('builtin-metrology-template-sem', 'builtin-metrology-family-sem', 'SEM', 'module', 1, 'af42e07d129a1478738a48faad869e4400e6b0c505d1d5689902a0f85bb0c574', '{}', '2026-07-24T00:00:00.000Z', 'metrology'),
  ('builtin-metrology-template-tem', 'builtin-metrology-family-tem', 'TEM', 'module', 1, 'a41a8b2554607eb7af6db4f6d5fb1fd0829ca913103ad4ec1243fffc7fb2bc6c', '{}', '2026-07-24T00:00:00.000Z', 'metrology'),
  ('builtin-metrology-template-afm', 'builtin-metrology-family-afm', 'AFM', 'module', 1, 'd18ae053070cf942a85aa7e484924ce9c9b1efc2f5ec906732712a193178ae82', '{}', '2026-07-24T00:00:00.000Z', 'metrology'),
  ('builtin-metrology-template-optical-microscope', 'builtin-metrology-family-optical-microscope', 'Optical microscope', 'module', 1, '73dac1d691d2d9da2b90820a4d9f9a17c75587936bb675f56181ed72dbdcbc19', '{}', '2026-07-24T00:00:00.000Z', 'metrology'),
  ('builtin-metrology-template-xrd', 'builtin-metrology-family-xrd', 'XRD', 'module', 1, 'd0b71ed04db386da4146074977e798f63f6253b58faba585040be4b61a47d02f', '{}', '2026-07-24T00:00:00.000Z', 'metrology');

INSERT OR IGNORE INTO template_steps
  (id, template_version_id, logical_step_key, position, definition_hash, raw_json)
VALUES
  ('builtin-metrology-step-sem', 'builtin-metrology-template-sem', 'metrology:sem', 0, 'b340e57f0b53f1d1f657f99ef1bd25c8b9b54dd442a1d50ae7ea7a936af409b5', '{}'),
  ('builtin-metrology-step-tem', 'builtin-metrology-template-tem', 'metrology:tem', 0, 'f139b09ba3ea4362d62a582621083ab0f3cb2d7abdf7524867ec59deab52014f', '{}'),
  ('builtin-metrology-step-afm', 'builtin-metrology-template-afm', 'metrology:afm', 0, '9025873f845664d95a057cf912841db6ef58e9c56045422151cdf4bfe1aed953', '{}'),
  ('builtin-metrology-step-optical-microscope', 'builtin-metrology-template-optical-microscope', 'metrology:optical-microscope', 0, '5f9d9a7b109c964d38b31409327aa4679e66770f6ea806db913e506b80c3c23c', '{}'),
  ('builtin-metrology-step-xrd', 'builtin-metrology-template-xrd', 'metrology:xrd', 0, 'd17dc56cbd17d7edbd2290926580871834b226e6823c52bfe18af125dddecdae', '{}');

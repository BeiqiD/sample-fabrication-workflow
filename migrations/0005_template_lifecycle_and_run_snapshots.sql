PRAGMA foreign_keys = ON;

ALTER TABLE template_versions ADD COLUMN locked_at TEXT;
ALTER TABLE template_versions ADD COLUMN locked_by TEXT;
ALTER TABLE template_versions ADD COLUMN archived_at TEXT;
ALTER TABLE template_versions ADD COLUMN archived_by TEXT;

ALTER TABLE assets ADD COLUMN sha256 TEXT;

ALTER TABLE runs ADD COLUMN template_name_snapshot TEXT;
ALTER TABLE runs ADD COLUMN template_type_snapshot TEXT;
ALTER TABLE runs ADD COLUMN template_version_snapshot INTEGER;

UPDATE runs
SET template_name_snapshot = (SELECT name FROM template_versions WHERE id = runs.template_version_id),
    template_type_snapshot = (SELECT template_type FROM template_versions WHERE id = runs.template_version_id),
    template_version_snapshot = (SELECT version FROM template_versions WHERE id = runs.template_version_id);

UPDATE template_versions
SET locked_at = COALESCE((SELECT MIN(created_at) FROM runs WHERE template_version_id = template_versions.id), locked_at),
    locked_by = COALESCE((SELECT created_by FROM runs WHERE template_version_id = template_versions.id ORDER BY created_at LIMIT 1), locked_by)
WHERE EXISTS (SELECT 1 FROM runs WHERE template_version_id = template_versions.id);

ALTER TABLE run_steps ADD COLUMN origin TEXT NOT NULL DEFAULT 'template' CHECK (origin IN ('template', 'ad_hoc'));
ALTER TABLE run_steps ADD COLUMN planned_title TEXT;
ALTER TABLE run_steps ADD COLUMN planned_tool_name TEXT;
ALTER TABLE run_steps ADD COLUMN planned_parameters_text TEXT;
ALTER TABLE run_steps ADD COLUMN planned_comments_text TEXT;
ALTER TABLE run_steps ADD COLUMN tool_name TEXT;
ALTER TABLE run_steps ADD COLUMN parameters_text TEXT;
ALTER TABLE run_steps ADD COLUMN comments_text TEXT;
ALTER TABLE run_steps ADD COLUMN deviation_note TEXT;
ALTER TABLE run_steps ADD COLUMN created_at TEXT;

UPDATE run_steps
SET origin = CASE WHEN template_step_id IS NULL THEN 'ad_hoc' ELSE 'template' END,
    planned_title = CASE WHEN template_step_id IS NULL THEN NULL ELSE title END,
    planned_tool_name = (SELECT tool_name FROM template_steps WHERE id = run_steps.template_step_id),
    planned_parameters_text = (SELECT parameters_text FROM template_steps WHERE id = run_steps.template_step_id),
    planned_comments_text = (SELECT comments_text FROM template_steps WHERE id = run_steps.template_step_id),
    tool_name = (SELECT tool_name FROM template_steps WHERE id = run_steps.template_step_id),
    parameters_text = (SELECT parameters_text FROM template_steps WHERE id = run_steps.template_step_id),
    comments_text = (SELECT comments_text FROM template_steps WHERE id = run_steps.template_step_id),
    created_at = updated_at,
    position = (position + 1) * 1000;

CREATE TABLE run_step_assets (
  id TEXT PRIMARY KEY,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  role TEXT NOT NULL CHECK (role IN ('planned', 'execution')),
  position INTEGER NOT NULL DEFAULT 0,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_step_id, asset_id, role)
);

INSERT INTO run_step_assets (id, run_step_id, asset_id, role, position, actor_email, created_at)
SELECT lower(hex(randomblob(16))), rs.id, tsa.asset_id, 'planned',
       ROW_NUMBER() OVER (PARTITION BY rs.id ORDER BY a.created_at, a.id) - 1,
       r.created_by, r.created_at
FROM run_steps rs
JOIN runs r ON r.id = rs.run_id
JOIN template_step_assets tsa ON tsa.template_step_id = rs.template_step_id
JOIN assets a ON a.id = tsa.asset_id;

CREATE INDEX run_step_assets_step_idx ON run_step_assets(run_step_id, role, position);
CREATE INDEX template_versions_active_idx ON template_versions(archived_at, template_type, name, version);
CREATE UNIQUE INDEX assets_sha256_unique_idx ON assets(sha256) WHERE sha256 IS NOT NULL;

CREATE TRIGGER runs_reject_archived_template
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'template version archived');
END;

CREATE TRIGGER runs_lock_template_after_insert
AFTER INSERT ON runs
BEGIN
  UPDATE template_versions
  SET locked_at = COALESCE(locked_at, NEW.created_at),
      locked_by = COALESCE(locked_by, NEW.created_by)
  WHERE id = NEW.template_version_id;
END;

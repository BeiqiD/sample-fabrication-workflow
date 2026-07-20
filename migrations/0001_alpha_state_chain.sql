PRAGMA foreign_keys = ON;

-- Alpha-v2 starts from a clean database. Recipe plans describe what should
-- happen; run steps and verification intervals preserve what actually did.

CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stored', 'consumed', 'lost')),
  location TEXT,
  parent_id TEXT REFERENCES samples(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  process_revision INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  last_mutation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX samples_updated_idx ON samples(updated_at DESC);
CREATE INDEX samples_parent_idx ON samples(parent_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'image', 'location', 'status', 'created', 'step', 'run', 'plan', 'verification')),
  body TEXT,
  asset_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  actor_email TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX events_sample_created_idx ON events(sample_id, created_at DESC);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  source_filename TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('process', 'module', 'recipe')),
  recipe_family_id TEXT,
  template_version_id TEXT,
  workbook_asset_key TEXT,
  manifest_asset_key TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  sha256 TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX assets_import_idx ON assets(import_id);
CREATE UNIQUE INDEX assets_sha256_unique_idx ON assets(sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE recipe_families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('process', 'module', 'recipe')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  archived_by TEXT,
  UNIQUE(name, template_type)
);

CREATE TABLE state_representations (
  hash TEXT PRIMARY KEY,
  hash_scheme TEXT NOT NULL DEFAULT 'state-diagram/v1',
  representation_type TEXT NOT NULL DEFAULT 'diagram',
  logical_state_key TEXT,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE state_representation_assets (
  state_hash TEXT NOT NULL REFERENCES state_representations(hash) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (state_hash, asset_id)
);

CREATE INDEX state_representation_assets_order_idx
ON state_representation_assets(state_hash, position);

CREATE TABLE step_definitions (
  hash TEXT PRIMARY KEY,
  hash_scheme TEXT NOT NULL DEFAULT 'step-definition/v1',
  name TEXT NOT NULL,
  tool_name TEXT,
  parameters_text TEXT,
  comments_text TEXT,
  canonical_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE template_versions (
  id TEXT PRIMARY KEY,
  recipe_family_id TEXT NOT NULL REFERENCES recipe_families(id),
  name TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('process', 'module', 'recipe')),
  version INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  initial_state_hash TEXT REFERENCES state_representations(hash),
  source_filename TEXT,
  source_asset_key TEXT,
  content_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  locked_at TEXT,
  locked_by TEXT,
  archived_at TEXT,
  archived_by TEXT,
  UNIQUE(recipe_family_id, version),
  UNIQUE(name, template_type, version)
);

CREATE INDEX template_versions_active_idx
ON template_versions(archived_at, template_type, name, version);

CREATE TABLE template_steps (
  id TEXT PRIMARY KEY,
  template_version_id TEXT NOT NULL REFERENCES template_versions(id) ON DELETE CASCADE,
  logical_step_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  source_row INTEGER,
  step_number TEXT,
  section_name TEXT,
  definition_hash TEXT NOT NULL REFERENCES step_definitions(hash),
  expected_state_hash TEXT REFERENCES state_representations(hash),
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(template_version_id, position),
  UNIQUE(template_version_id, logical_step_key)
);

CREATE INDEX template_steps_version_idx ON template_steps(template_version_id, position);
CREATE INDEX template_steps_definition_idx ON template_steps(definition_hash);
CREATE INDEX template_steps_expected_state_idx ON template_steps(expected_state_hash);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  recipe_family_id TEXT NOT NULL REFERENCES recipe_families(id),
  template_version_id TEXT NOT NULL REFERENCES template_versions(id),
  current_plan_revision_id TEXT,
  predecessor_run_id TEXT REFERENCES runs(id),
  anchor_step_id TEXT,
  sequence_no INTEGER NOT NULL,
  run_group_id TEXT NOT NULL,
  template_name_snapshot TEXT NOT NULL,
  template_type_snapshot TEXT NOT NULL,
  template_version_snapshot INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete', 'cancelled', 'superseded')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(sample_id, sequence_no)
);

CREATE UNIQUE INDEX runs_one_active_per_sample_idx
ON runs(sample_id) WHERE status = 'active';
CREATE INDEX runs_sample_sequence_idx ON runs(sample_id, sequence_no DESC);
CREATE INDEX runs_group_idx ON runs(run_group_id);
CREATE UNIQUE INDEX runs_single_successor_idx
ON runs(predecessor_run_id) WHERE predecessor_run_id IS NOT NULL;

CREATE TABLE run_plan_revisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  template_version_id TEXT NOT NULL REFERENCES template_versions(id),
  effective_after_step_id TEXT,
  reason TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, revision_no)
);

CREATE INDEX run_plan_revisions_run_idx ON run_plan_revisions(run_id, revision_no DESC);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  previous_step_id TEXT REFERENCES run_steps(id),
  position INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'template' CHECK (origin IN ('template', 'ad_hoc')),
  plan_status TEXT NOT NULL DEFAULT 'current' CHECK (plan_status IN ('current', 'superseded')),
  template_step_id TEXT REFERENCES template_steps(id),
  logical_step_key TEXT,
  definition_hash TEXT REFERENCES step_definitions(hash),
  expected_state_hash TEXT REFERENCES state_representations(hash),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'skipped', 'blocked')),
  notes TEXT,
  tool_name TEXT,
  parameters_text TEXT,
  comments_text TEXT,
  deviation_note TEXT,
  actualized_at TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  last_mutation_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, position)
);

CREATE INDEX run_steps_run_position_idx ON run_steps(run_id, position);
CREATE INDEX run_steps_definition_idx ON run_steps(definition_hash);
CREATE INDEX run_steps_state_idx ON run_steps(expected_state_hash);

CREATE TABLE run_step_plan_links (
  run_plan_revision_id TEXT NOT NULL REFERENCES run_plan_revisions(id) ON DELETE CASCADE,
  template_step_id TEXT NOT NULL REFERENCES template_steps(id),
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'planned' CHECK (relation IN ('planned', 'fulfilled', 'skipped', 'deviated', 'substituted', 'retry', 'manual_anchor', 'historical')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_plan_revision_id, template_step_id, run_step_id)
);

CREATE INDEX run_step_plan_links_step_idx ON run_step_plan_links(run_step_id);

CREATE TABLE run_step_assets (
  id TEXT PRIMARY KEY,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  role TEXT NOT NULL CHECK (role IN ('execution', 'state_observation')),
  position INTEGER NOT NULL DEFAULT 0,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_step_id, asset_id, role)
);

CREATE INDEX run_step_assets_step_idx ON run_step_assets(run_step_id, role, position);

CREATE TABLE run_step_comments (
  id TEXT PRIMARY KEY,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('common', 'individual')),
  operation_group_id TEXT,
  body TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id),
  actor_email TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX run_step_comments_step_created_idx
ON run_step_comments(run_step_id, created_at, id);
CREATE INDEX run_step_comments_operation_group_idx
ON run_step_comments(operation_group_id) WHERE operation_group_id IS NOT NULL;
CREATE INDEX run_step_comments_asset_idx
ON run_step_comments(asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE state_verifications (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  after_run_step_id TEXT NOT NULL REFERENCES run_steps(id),
  previous_verification_id TEXT REFERENCES state_verifications(id),
  run_plan_revision_id TEXT REFERENCES run_plan_revisions(id),
  expected_state_hash TEXT REFERENCES state_representations(hash),
  result TEXT NOT NULL CHECK (result IN ('matched', 'mismatched')),
  evidence_asset_id TEXT REFERENCES assets(id),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'stale')),
  actor_email TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX state_verifications_sample_created_idx
ON state_verifications(sample_id, created_at, id);

CREATE TABLE state_verification_steps (
  verification_id TEXT NOT NULL REFERENCES state_verifications(id) ON DELETE CASCADE,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (verification_id, run_step_id)
);

CREATE INDEX state_verification_steps_step_idx ON state_verification_steps(run_step_id);

CREATE TABLE recipe_change_proposals (
  id TEXT PRIMARY KEY,
  recipe_family_id TEXT NOT NULL REFERENCES recipe_families(id),
  source_template_version_id TEXT NOT NULL REFERENCES template_versions(id),
  source_verification_id TEXT REFERENCES state_verifications(id),
  change_type TEXT NOT NULL CHECK (change_type IN ('expected_state', 'process', 'applicability')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  actor_email TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER samples_location_history
AFTER UPDATE OF location ON samples
WHEN OLD.location IS NOT NEW.location
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'location',
    'Location changed from ' || COALESCE(OLD.location, '—') || ' to ' || COALESCE(NEW.location, '—'),
    json_object('field', 'location', 'previous', OLD.location, 'current', NEW.location),
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER samples_status_history
AFTER UPDATE OF status ON samples
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'status',
    'Status changed from ' || OLD.status || ' to ' || NEW.status,
    json_object('field', 'status', 'previous', OLD.status, 'current', NEW.status),
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER samples_pinned_history
AFTER UPDATE OF pinned ON samples
WHEN OLD.pinned IS NOT NEW.pinned
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'status',
    CASE WHEN NEW.pinned = 1 THEN 'Sample pinned' ELSE 'Sample unpinned' END,
    json_object('field', 'pinned', 'previous', OLD.pinned = 1, 'current', NEW.pinned = 1),
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER runs_reject_archived_template
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'template version archived');
END;

CREATE TRIGGER run_plan_revisions_reject_archived_template
BEFORE INSERT ON run_plan_revisions
WHEN EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id AND archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'template version archived');
END;

CREATE TRIGGER run_plan_revisions_lock_template
AFTER INSERT ON run_plan_revisions
BEGIN
  UPDATE template_versions
  SET locked_at = COALESCE(locked_at, NEW.created_at),
      locked_by = COALESCE(locked_by, NEW.actor_email)
  WHERE id = NEW.template_version_id;
END;

CREATE TRIGGER run_step_status_rollup
AFTER UPDATE OF status ON run_steps
WHEN OLD.status IS NOT NEW.status
BEGIN
  UPDATE runs
  SET status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM run_steps
          WHERE run_id = NEW.run_id AND plan_status = 'current'
            AND status NOT IN ('done', 'skipped')
        ) THEN 'complete'
        ELSE 'active'
      END,
      completed_at = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM run_steps
          WHERE run_id = NEW.run_id AND plan_status = 'current'
            AND status NOT IN ('done', 'skipped')
        ) THEN NEW.updated_at
        ELSE NULL
      END
  WHERE id = NEW.run_id AND status NOT IN ('cancelled', 'superseded');
END;

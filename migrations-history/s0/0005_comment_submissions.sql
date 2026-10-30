PRAGMA foreign_keys = ON;

-- Comment files are staged as a durable submission before any final comment is
-- exposed. Processed inline images remain R2 assets. Original files live behind
-- a separately configurable managed-storage adapter.
CREATE TABLE managed_storage_objects (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  object_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'orphaned', 'deleted', 'failed')),
  actor_email TEXT,
  created_at TEXT NOT NULL,
  orphaned_at TEXT,
  UNIQUE(provider, object_key)
);

CREATE UNIQUE INDEX managed_storage_objects_content_idx
ON managed_storage_objects(provider, sha256, byte_size)
WHERE status = 'ready';

CREATE TABLE comment_submissions (
  id TEXT PRIMARY KEY,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('sample', 'run_steps')),
  sample_id TEXT REFERENCES samples(id) ON DELETE CASCADE,
  scope TEXT CHECK (scope IN ('common', 'individual')),
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'uploading', 'ready', 'failed', 'cancelled')),
  error_message TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  CHECK (
    (context_kind = 'sample' AND sample_id IS NOT NULL AND scope IS NULL)
    OR (context_kind = 'run_steps' AND sample_id IS NULL AND scope IS NOT NULL)
  )
);

CREATE INDEX comment_submissions_sample_idx
ON comment_submissions(sample_id, created_at DESC);
CREATE INDEX comment_submissions_status_idx
ON comment_submissions(status, updated_at);

CREATE TABLE comment_submission_targets (
  submission_id TEXT NOT NULL REFERENCES comment_submissions(id) ON DELETE CASCADE,
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  expected_updated_at TEXT NOT NULL,
  PRIMARY KEY (submission_id, run_step_id)
);

CREATE INDEX comment_submission_targets_sample_idx
ON comment_submission_targets(sample_id, submission_id);

CREATE TABLE comment_submission_items (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES comment_submissions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('comment_image', 'attachment', 'link')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploading', 'ready', 'failed', 'cancelled')),
  position INTEGER NOT NULL,
  filename TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  original_filename TEXT,
  original_mime_type TEXT,
  original_byte_size INTEGER,
  title TEXT,
  description TEXT,
  external_url TEXT,
  asset_id TEXT REFERENCES assets(id),
  storage_object_id TEXT REFERENCES managed_storage_objects(id),
  sha256 TEXT,
  related_item_id TEXT REFERENCES comment_submission_items(id),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(submission_id, position)
);

CREATE INDEX comment_submission_items_submission_idx
ON comment_submission_items(submission_id, position);
CREATE INDEX comment_submission_items_asset_idx
ON comment_submission_items(asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX comment_submission_items_storage_idx
ON comment_submission_items(storage_object_id) WHERE storage_object_id IS NOT NULL;

ALTER TABLE run_step_comments ADD COLUMN submission_id TEXT REFERENCES comment_submissions(id);
CREATE INDEX run_step_comments_submission_idx
ON run_step_comments(submission_id) WHERE submission_id IS NOT NULL;

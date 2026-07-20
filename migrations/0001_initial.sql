PRAGMA foreign_keys = ON;

CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stored', 'consumed', 'lost')),
  location TEXT,
  parent_id TEXT REFERENCES samples(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX samples_updated_idx ON samples(updated_at DESC);
CREATE INDEX samples_parent_idx ON samples(parent_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'image', 'location', 'status', 'created', 'step')),
  body TEXT,
  asset_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX events_sample_created_idx ON events(sample_id, created_at DESC);

CREATE TABLE template_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('process', 'module', 'recipe')),
  version INTEGER NOT NULL,
  source_filename TEXT,
  source_asset_key TEXT,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(name, template_type, version)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  template_version_id TEXT NOT NULL REFERENCES template_versions(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete', 'cancelled')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'skipped', 'blocked')),
  notes TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, position)
);

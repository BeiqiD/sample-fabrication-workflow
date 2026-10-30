CREATE INDEX IF NOT EXISTS samples_status_updated_idx
ON samples(status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS samples_status_created_idx
ON samples(status, created_at DESC, id);

CREATE INDEX IF NOT EXISTS samples_created_idx
ON samples(created_at DESC, id);

CREATE INDEX IF NOT EXISTS samples_location_updated_idx
ON samples(location COLLATE NOCASE, updated_at DESC, id);

-- Installation-local queue preference. Execution enablement, trigger configuration
-- and historical jobs are unchanged; the cursor grants no execution authority.
ALTER TABLE file_job_runtime_guard ADD COLUMN next_queue TEXT NOT NULL DEFAULT 'package'
  CHECK(next_queue IN('package','migration'));

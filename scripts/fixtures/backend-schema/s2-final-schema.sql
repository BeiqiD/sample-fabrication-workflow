-- INACTIVE QUALIFICATION CANDIDATE: requires accepted C-compatible serving code.
-- Use one transaction only, after immutable precleanup S1 recovery evidence.
CREATE TABLE compatibility_stage_d_assertion (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO compatibility_stage_d_assertion
SELECT CASE WHEN (SELECT COUNT(*) FROM pragma_table_xinfo('run_step_comments')) = 19
  AND EXISTS (SELECT 1 FROM pragma_table_xinfo('run_step_comments') WHERE name = 'body')
  AND EXISTS (SELECT 1 FROM pragma_table_xinfo('samples') WHERE name = 'process_revision')
  AND NOT EXISTS (SELECT 1 FROM run_step_comments WHERE
    (submission_id IS NULL AND legacy_body IS NULL)
    OR (submission_id IS NOT NULL AND legacy_body IS NOT NULL))
THEN 1 ELSE 0 END;
DROP TRIGGER run_step_comments_bridge_legacy_insert;
ALTER TABLE run_step_comments DROP COLUMN body;
-- qualification checkpoint: after-occurrence-contraction
ALTER TABLE samples DROP COLUMN process_revision;
-- qualification checkpoint: after-sample-contraction
CREATE TRIGGER run_step_comments_guard_text_owner_insert
BEFORE INSERT ON run_step_comments
WHEN (NEW.submission_id IS NULL AND NEW.legacy_body IS NULL)
  OR (NEW.submission_id IS NOT NULL AND NEW.legacy_body IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'run_step_comments text ownership is invalid');
END;
CREATE TRIGGER run_step_comments_guard_text_owner_update
BEFORE UPDATE OF submission_id, legacy_body ON run_step_comments
WHEN (NEW.submission_id IS NULL AND NEW.legacy_body IS NULL)
  OR (NEW.submission_id IS NOT NULL AND NEW.legacy_body IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'run_step_comments text ownership is invalid');
END;
DROP TABLE compatibility_stage_d_assertion;

-- Apply after worker/fixtures/reference-graph.sql on S0. Deliberately retained
-- business data: text ownership, independent deletion, pending retry, shared
-- quarantined bytes, unchanged identities, and actual nonzero retired counters.
-- Make the two fixture-generated status event IDs deterministic before any
-- rehearsal snapshot; migrations must preserve these exact IDs unchanged.
UPDATE events SET id = 'retained-initial-status-' || sample_id
  WHERE kind = 'status' AND created_at = '2026-08-01T01:00:00.000Z'
    AND sample_id IN ('reference-sample-a', 'reference-sample-b');
UPDATE samples SET process_revision = 37, last_mutation_id = 'retained-sample-a' WHERE id = 'reference-sample-a';
UPDATE samples SET process_revision = 9007199254740000, deleted_at = '2026-08-05T00:00:00.000Z',
  deleted_by = 'retained@example.test', last_mutation_id = 'retained-sample-b' WHERE id = 'reference-sample-b';
UPDATE runs SET deleted_at = '2026-08-05T00:00:00.000Z', deleted_by = 'retained@example.test'
  WHERE id = 'reference-run-b';
UPDATE run_step_comments SET deleted_at = '2026-08-04T00:00:00.000Z', deleted_by = 'retained@example.test',
  deletion_operation_id = 'retained-partial-common-delete', last_mutation_id = 'retained-occurrence-delete'
  WHERE id = 'reference-comment-occurrence-b';
INSERT INTO run_step_comments (id, run_step_id, scope, body, actor_email, created_at, updated_at, last_mutation_id)
VALUES ('retained-legacy-individual', 'reference-step-a', 'individual', 'Legacy text: 中文, ''quoted'', empty lines

kept exactly.', 'retained@example.test', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'retained-legacy-create');
INSERT INTO run_step_comments (id, run_step_id, scope, operation_group_id, body, asset_id, actor_email, created_at,
  asset_deleted_at, asset_deleted_by, asset_deletion_operation_id)
VALUES ('retained-legacy-common-a', 'reference-step-a', 'common', 'retained-legacy-group', '', 'reference-comment-asset',
  'retained@example.test', '2026-08-02T01:00:00.000Z', '2026-08-03T00:00:00.000Z', 'retained@example.test', 'retained-image-delete'),
 ('retained-legacy-common-b', 'reference-step-b', 'common', 'retained-legacy-group', '', 'reference-comment-asset',
  'retained@example.test', '2026-08-02T01:00:00.000Z', NULL, NULL, NULL);
INSERT INTO comment_submissions (id, context_kind, sample_id, body, status, actor_email, created_at, updated_at, retry_until)
VALUES ('retained-pending', 'sample', 'reference-sample-a', 'Upload still pending', 'uploading', 'retained@example.test',
  '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
INSERT INTO comment_submission_items (id, submission_id, kind, status, position, filename, mime_type, byte_size, created_at, updated_at)
VALUES ('retained-pending-item', 'retained-pending', 'attachment', 'pending', 0, 'pending.txt', 'text/plain', 24,
  '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z');
INSERT INTO blob_integrity_quarantine (store_kind, provider, object_key, blob_record_id, reason, expected_byte_size,
  operation_id, detected_at, last_checked_at)
VALUES ('r2', 'r2', 'reference/private/comment.png', 'reference-comment-asset', 'missing', 10,
  'retained-shared-quarantine', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z');

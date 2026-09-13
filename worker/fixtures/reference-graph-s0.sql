INSERT INTO step_definitions
  (hash, name, canonical_json, created_at)
VALUES
  ('reference-step-definition', 'Reference etch', '{}', '2026-08-01T00:00:00.000Z'),
  ('reference-metrology-definition', 'Reference SEM', '{}', '2026-08-01T00:00:00.000Z');

INSERT INTO recipe_families (id, name, template_type, created_at)
VALUES
  ('reference-process-family', 'Reference process family', 'process', '2026-08-01T00:00:00.000Z'),
  ('reference-metrology-family', 'Reference metrology family', 'module', '2026-08-01T00:00:00.000Z');

INSERT INTO template_versions
  (id, recipe_family_id, name, template_type, version, manifest_hash,
   content_json, created_at, template_kind)
VALUES
  ('reference-process-template', 'reference-process-family', 'Reference process', 'process', 3,
   'reference-process-manifest', '{}', '2026-08-01T00:00:00.000Z', 'process'),
  ('reference-metrology-template', 'reference-metrology-family', 'Reference SEM', 'module', 2,
   'reference-metrology-manifest', '{}', '2026-08-01T00:00:00.000Z', 'metrology');

INSERT INTO template_steps
  (id, template_version_id, logical_step_key, position, definition_hash, raw_json)
VALUES
  ('reference-process-template-step', 'reference-process-template', 'reference:etch', 0,
   'reference-step-definition', '{}'),
  ('reference-metrology-template-step', 'reference-metrology-template', 'reference:sem', 0,
   'reference-metrology-definition', '{}');

INSERT INTO samples
  (id, code, title, description, status, location, pinned, created_at, updated_at)
VALUES
  ('reference-sample-a', 'REF-A', 'Reference sample A', 'First reference fixture', 'stored', 'Box A', 0,
   '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
  ('reference-sample-b', 'REF-B', 'Reference sample B', 'Second reference fixture', 'stored', 'Box B', 0,
   '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');

INSERT INTO runs
  (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id,
   template_name_snapshot, template_type_snapshot, template_version_snapshot,
   status, created_at, run_kind)
VALUES
  ('reference-run-a', 'reference-sample-a', 'reference-process-family', 'reference-process-template', 1,
   'reference-run-group-a', 'Reference process', 'process', 3, 'active',
   '2026-08-01T01:00:00.000Z', 'process'),
  ('reference-run-b', 'reference-sample-b', 'reference-process-family', 'reference-process-template', 1,
   'reference-run-group-b', 'Reference process', 'process', 3, 'active',
   '2026-08-01T01:00:00.000Z', 'process');

INSERT INTO run_steps
  (id, run_id, position, origin, plan_status, definition_hash, title, status,
   entry_kind, created_at, updated_at)
VALUES
  ('reference-step-a', 'reference-run-a', 0, 'template', 'current', 'reference-step-definition',
   'Reference etch A', 'pending', 'fabrication',
   '2026-08-01T02:00:00.000Z', '2026-08-01T02:00:00.000Z'),
  ('reference-step-b', 'reference-run-b', 0, 'template', 'current', 'reference-step-definition',
   'Reference etch B', 'pending', 'fabrication',
   '2026-08-01T02:00:00.000Z', '2026-08-01T02:00:00.000Z');

INSERT INTO assets
  (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
VALUES
  ('reference-comment-asset', 'reference/private/comment.png', 'comment.png', 'image/png', 10,
   'ready', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   '2026-08-01T03:00:00.000Z'),
  ('reference-execution-asset', 'reference/private/execution.png', 'execution.png', 'image/png', 11,
   'ready', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   '2026-08-01T03:00:00.000Z'),
  ('reference-metrology-asset', 'reference/private/manual.pdf', 'manual.pdf', 'application/pdf', 12,
   'ready', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
   '2026-08-01T03:00:00.000Z');

INSERT INTO comment_submissions
  (id, context_kind, scope, body, status, actor_email, created_at, updated_at, completed_at)
VALUES
  ('reference-comment', 'run_steps', 'common', 'Shared reference Comment body', 'ready',
   'reference@example.com', '2026-08-01T04:00:00.000Z',
   '2026-08-01T04:00:00.000Z', '2026-08-01T04:00:00.000Z');

INSERT INTO comment_submission_targets
  (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
VALUES
  ('reference-comment', 'reference-sample-a', 'reference-run-a', 'reference-step-a', '2026-08-01T02:00:00.000Z'),
  ('reference-comment', 'reference-sample-b', 'reference-run-b', 'reference-step-b', '2026-08-01T02:00:00.000Z');

INSERT INTO run_step_comments
  (id, run_step_id, scope, operation_group_id, body, submission_id, actor_email,
   created_at, updated_at)
VALUES
  ('reference-comment-occurrence-a', 'reference-step-a', 'common', 'reference-comment-group',
   'Shared reference Comment body', 'reference-comment', 'reference@example.com',
   '2026-08-01T04:00:00.000Z', '2026-08-01T04:00:00.000Z'),
  ('reference-comment-occurrence-b', 'reference-step-b', 'common', 'reference-comment-group',
   'Shared reference Comment body', 'reference-comment', 'reference@example.com',
   '2026-08-01T04:00:00.000Z', '2026-08-01T04:00:00.000Z');

INSERT INTO comment_submission_items
  (id, submission_id, kind, status, position, filename, mime_type, byte_size,
   original_filename, original_mime_type, original_byte_size, title, asset_id,
   created_at, updated_at)
VALUES
  ('reference-comment-attachment', 'reference-comment', 'comment_image', 'ready', 0,
   'comment.png', 'image/png', 10, 'comment.png', 'image/png', 10,
   'Reference comment image', 'reference-comment-asset',
   '2026-08-01T04:00:00.000Z', '2026-08-01T04:00:00.000Z');

INSERT INTO run_step_assets
  (id, run_step_id, asset_id, role, position, actor_email, created_at)
VALUES
  ('reference-execution-image', 'reference-step-a', 'reference-execution-asset', 'execution', 0,
   'reference@example.com', '2026-08-01T05:00:00.000Z');

INSERT INTO metrology_template_references
  (id, template_version_id, asset_id, display_name, position, actor_email, created_at)
VALUES
  ('reference-metrology-reference', 'reference-metrology-template', 'reference-metrology-asset',
   'Reference SEM manual', 0, 'reference@example.com', '2026-08-01T05:00:00.000Z');

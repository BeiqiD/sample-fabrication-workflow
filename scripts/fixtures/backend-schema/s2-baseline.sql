-- INACTIVE S2 baseline candidate: new EMPTY databases only.
-- Generated from the historical chain plus inactive S1/S2 rehearsals.
-- Not selected by Wrangler. No migration ledger is created or rewritten.
-- Remote activation remains subject to the deployment/retirement gates.
-- Normalized application schema SHA-256: 71e082ee9bbf00f8844c5580bbc81c8dec3894025fc0d17b88584a8ce984c4b2
-- Source migrations/0001_alpha_state_chain.sql sha256=6001a9df2f6b244ee4b499927d9deee9daffcf3110703850663f17df6ef4e294
-- Source migrations/0002_run_initial_state.sql sha256=cb0b502555489418d78087c5a63e024498699c79dbc10509cf275952127d46dc
-- Source migrations/0003_release_unreferenced_templates.sql sha256=ee5fac2bf527d7358d0854ba11015f16e3e67d72b788ce32e2ec394a55b48114
-- Source migrations/0004_sync_sample_run_status.sql sha256=7fdf1a5011f34187b575b4705773bfb1057439fb3b51664bd0aed8b5973b97d3
-- Source migrations/0005_comment_submissions.sql sha256=72b257ce3c05be741ec818f25378465c963871980adb95207e3df2027dbbd527
-- Source migrations/0006_metrology_templates.sql sha256=3a06c15e94f11ed8313402838f6de5d6491d9890326e82c6beaa0ecacb373850
-- Source migrations/0007_directory_performance.sql sha256=2e645aab334b2da875b0a0453f58fb4432ca3a10f6b38082bfaf8b64de0393fd
-- Source migrations/0008_sync_metrology_sample_status.sql sha256=492cb7aa148f622e85a98be49d0900e6e1877b3a11ea892104041f1bc5d4901b
-- Source migrations/0009_sample_directory_filters.sql sha256=44c27fada01145b6e3a989fe718b106a655e2efbb3aa16ec3f04b2f9e588136a
-- Source migrations/0010_matching_run_picker.sql sha256=c7b890c694a56d3a0a33befb1be5ed86f6aa95d90bd96c5a0679310c5688128e
-- Source migrations/0011_reference_lifecycle_foundation.sql sha256=35c594a13f6c4db6211bf4f433ddc6709763c70c1802edb87f52cffb42be0e6c
-- Source migrations/0012_run_soft_delete.sql sha256=5e9cd39d492d7f82fc203b2c2cb75482351d0570c4da8fa120b7aaa0747c2cab
-- Source migrations/0013_remove_builtin_metrology_templates.sql sha256=7a640b7f5db903049727bb0f574b3b2a499dd301ceab86e0c57bb1758fea8621
-- Source migrations/0014_source_lifecycle_conversion.sql sha256=0b2e854cd9af52030a34c64f642557779a8f690ff8083cd8e2d39c4968944421
-- Source migrations/0015_atomic_mutation_identity.sql sha256=202ebf7466601d1ea51f6fedf1c9d8cab7d4d0263f66e8040f470a183a4cbbdb
-- Source migrations/0015_managed_orphan_dedupe_repair.sql sha256=852f2cfbe0b2b65aea12c2428bd15eb81739de4d4326b3d5d34bef2642a1e76c
-- Source migrations/0016_blob_lifecycle_control.sql sha256=7adc52f38e4920c8eba7d92952b437a1fe672cd81f3141c1c51538524261a8bd
-- Source migrations/0017_blob_lifecycle_review_fixes.sql sha256=7a24e6b81ddab527f400e3deed4742ee96f9133fa46bdc45da96a38d516dae35
-- Source migrations/0018_reference_registry.sql sha256=eb9e27c646fa69eb4afae1d186fcd79b594055cb0aec45614cdd74a152ae5937
-- Source migrations/0019_project_core.sql sha256=0b8815347a7051ad1a133e7e875981e8753cddfbc0e7c01ecbc4be44c35c83de
-- Source migrations/0020_project_persistence_guards.sql sha256=cbe0af08dc5e798d28bb084b044bc013d6f648bc8f79e91b4a2f3f10ed55fc6a
-- Source migrations/0021_project_identifier_byte_guards.sql sha256=27db84a3a50529a56dc75573c353e4b103eb008147d72b8835cba3be4c45bb5b
-- Source migrations/0022_project_payload_and_external_identity_guards.sql sha256=3c75bd6d1c4e239348e067ed0925ed61bbd869dc7d086c92d42264ad6e449a2c
-- Source migrations/0023_project_unicode_payload_contract.sql sha256=87cb020c3774b2bd3ced2d649be778f89e2edf5de06de744572f8bcee55062dc
-- Source migrations/0024_blob_integrity_quarantine.sql sha256=1f9244f80d0a787ef2ccf548cd01a6b186105520e2d2dbe675fc2bf79d29342e
-- Source migrations/0025_fabublox_publication_boundaries.sql sha256=ab13c500826157741ceecc42d1caf4bc2f9a3c95fd15cfea83f6ea4824ab9e3c
-- Source migrations/0026_fabublox_recovery_ownership.sql sha256=64e2d392f2b7cc29074bc2259560412ebbc2ebf9c8de11e8a9c39e0af4e45afc
-- Source migrations/0027_fabublox_dependency_publication.sql sha256=7ffc737b6ed57d9b1f23dde40b3ac7aa290f50e2d4258cf597ef2622441081e3
-- Source migrations/0028_blob_registration_and_recovery_reconciliation.sql sha256=bb6a6fd8adb02eeeb60f22666d92ee832d49e9881001589f91b6c737abfd4fa6
-- Source migrations/0029_supersession_timeline_projection.sql sha256=741794ad7a5a8c8cde877957a186bac141679301416fe1657c1e707e08ab9f80
-- Source migrations/0030_run_attachment_retention.sql sha256=87fe1912470f878bdd622bd2eac7054ccec896e763dddb3f46e9abd5399ffe2e
-- Source migrations/0031_comment_attachment_retention.sql sha256=37c945d03779383385959b3c9a71172fe0a3a41054dd66951cef2b70f1f10907
-- Source migrations/0032_attachment_occurrence_metadata.sql sha256=9f6759f931f5fd17e4c11e83024e98943d96120822f3641dd2c064f156dc51c8
-- Source migrations/0033_attachment_derivatives.sql sha256=6601695384b0e484b79a21f2e1ed9f6a8ba3424e76f9625b19006d3946bc8e50
-- Source migrations/0034_attachment_derivative_generator_parity.sql sha256=548fe576d2ce838ccb343e658c43a19391d3e820411b6f4a24109d8cf71ac960
-- Source migrations/0035_attachment_derivative_trust_boundary.sql sha256=5ba67d1069a82d47045734010cd4071d9d2eea6a488e5232aed4e4800f8a827d
-- Source migrations/0036_project_edge_reconnection.sql sha256=76dabffa6fb3263c64e8353855572d81c575d4c14baee90cecf8fc31fab5340e
-- Source scripts/fixtures/backend-schema/s1-compatibility-bridge.sql sha256=5722f7dda0174c8fb150441f5fa08a673ad2d9104fbac484e6152a29b17c9a29
-- Source scripts/fixtures/backend-schema/s2-final-schema.sql sha256=f0b1047d2b98d64a07e81fbdc98580df44dc728d93f47f2e0cd2b5d9e45eab1a

PRAGMA foreign_keys = ON;

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

CREATE TABLE attachment_derivatives (
  id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  source_byte_size INTEGER NOT NULL,
  derivative_kind TEXT NOT NULL CHECK (derivative_kind = 'browser_preview'),
  generator_version TEXT NOT NULL,
  derived_asset_id TEXT REFERENCES assets(id),
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  error_code TEXT,
  retain_until TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(source_sha256) = 64
    AND instr(source_sha256, char(0)) = 0
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(source_byte_size) = 'integer'
    AND source_byte_size > 0
    AND source_byte_size <= 9007199254740991
  ),
  CHECK (
    length(generator_version) BETWEEN 1 AND 128
    AND instr(generator_version, char(0)) = 0
  ),
  CHECK (
    (status = 'ready'
      AND derived_asset_id IS NOT NULL
      AND error_code IS NULL
      AND retain_until IS NOT NULL
      AND datetime(retain_until) IS NOT NULL)
    OR
    (status = 'failed'
      AND derived_asset_id IS NULL
      AND error_code IS NOT NULL
      AND length(error_code) BETWEEN 1 AND 500
      AND instr(error_code, char(0)) = 0
      AND retain_until IS NULL)
  )
);

CREATE TABLE blob_gc_ledger (
  store_kind TEXT NOT NULL CHECK (store_kind IN ('r2', 'managed')),
  provider TEXT NOT NULL,
  object_key TEXT NOT NULL,
  blob_record_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('orphaned', 'deleting', 'deleted')),
  operation_id TEXT,
  orphaned_at TEXT,
  deletion_started_at TEXT,
  deleted_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_kind, provider, object_key)
);

CREATE TABLE blob_integrity_quarantine (
  store_kind TEXT NOT NULL CHECK (store_kind IN ('r2', 'managed')),
  provider TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 100),
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  blob_record_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('missing', 'size_mismatch')),
  expected_byte_size INTEGER NOT NULL CHECK (
    typeof(expected_byte_size) = 'integer'
    AND expected_byte_size BETWEEN 0 AND 9007199254740991
  ),
  observed_byte_size INTEGER CHECK (
    observed_byte_size IS NULL OR (
      typeof(observed_byte_size) = 'integer'
      AND observed_byte_size BETWEEN 0 AND 9007199254740991
    )
  ),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  detected_at TEXT NOT NULL CHECK (length(detected_at) > 0),
  last_checked_at TEXT NOT NULL CHECK (length(last_checked_at) > 0),
  PRIMARY KEY (store_kind, provider, object_key)
);

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
  updated_at TEXT NOT NULL, deleted_at TEXT, deleted_by TEXT,
  UNIQUE(submission_id, position)
);

CREATE TABLE comment_submission_targets (
  submission_id TEXT NOT NULL REFERENCES comment_submissions(id) ON DELETE CASCADE,
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  expected_updated_at TEXT NOT NULL,
  PRIMARY KEY (submission_id, run_step_id)
);

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
  cancelled_at TEXT, deleted_at TEXT, deleted_by TEXT, last_mutation_id TEXT, deletion_operation_id TEXT, retry_until TEXT, retry_closed_at TEXT, retry_closed_by TEXT,
  CHECK (
    (context_kind = 'sample' AND sample_id IS NOT NULL AND scope IS NULL)
    OR (context_kind = 'run_steps' AND sample_id IS NULL AND scope IS NOT NULL)
  )
);

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
, operation_id TEXT, lease_expires_at TEXT, finalization_id TEXT, recovery_operation_id TEXT);

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

CREATE TABLE metrology_template_references (
  id TEXT PRIMARY KEY,
  template_version_id TEXT NOT NULL REFERENCES template_versions(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  display_name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  actor_email TEXT,
  created_at TEXT NOT NULL, deleted_at TEXT, deleted_by TEXT, superseded_by_occurrence_id TEXT
REFERENCES metrology_template_references(id), superseded_at TEXT, superseded_by TEXT, supersession_operation_id TEXT,
  UNIQUE(template_version_id, asset_id)
);

CREATE TABLE project_content_attachments (
  project_content_id TEXT PRIMARY KEY
    REFERENCES project_contents(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  storage_object_id TEXT REFERENCES managed_storage_objects(id) ON DELETE RESTRICT,
  original_name TEXT NOT NULL CHECK (length(trim(original_name)) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 200),
  byte_size INTEGER NOT NULL CHECK (
    typeof(byte_size) = 'integer'
    AND byte_size BETWEEN 0 AND 9007199254740991
  ),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  creation_operation_id TEXT NOT NULL CHECK (length(creation_operation_id) BETWEEN 1 AND 256),
  CHECK ((asset_id IS NOT NULL) <> (storage_object_id IS NOT NULL))
);

CREATE TABLE project_contents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  content_type TEXT NOT NULL CHECK (content_type IN ('markdown', 'attachment')),
  markdown_source TEXT,
  attachment_caption TEXT
    CHECK (attachment_caption IS NULL OR length(attachment_caption) <= 2000),
  attachment_source_url TEXT
    CHECK (
      attachment_source_url IS NULL
      OR length(trim(attachment_source_url)) BETWEEN 1 AND 2048
    ),
  format_version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(format_version) = 'integer'
    AND format_version BETWEEN 1 AND 9007199254740991
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision) = 'integer'
    AND revision BETWEEN 1 AND 9007199254740991
  ),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_operation_id TEXT,
  CHECK (
    (
      content_type = 'markdown'
      AND markdown_source IS NOT NULL
      AND attachment_caption IS NULL
      AND attachment_source_url IS NULL
    )
    OR (content_type = 'attachment' AND markdown_source IS NULL)
  ),
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_operation_id IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND length(deleted_at) > 0
      AND deleted_by IS NOT NULL
      AND length(trim(deleted_by)) BETWEEN 1 AND 320
      AND deletion_operation_id IS NOT NULL
      AND length(deletion_operation_id) BETWEEN 1 AND 256
    )
  )
);

CREATE TABLE project_edges (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_item_id TEXT NOT NULL REFERENCES project_items(id) ON DELETE RESTRICT,
  target_item_id TEXT NOT NULL REFERENCES project_items(id) ON DELETE RESTRICT,
  source_handle TEXT NOT NULL CHECK (source_handle IN ('top', 'right', 'bottom', 'left')),
  target_handle TEXT NOT NULL CHECK (target_handle IN ('top', 'right', 'bottom', 'left')),
  marker_start TEXT NOT NULL DEFAULT 'none' CHECK (marker_start IN ('none', 'arrow')),
  marker_end TEXT NOT NULL DEFAULT 'none' CHECK (marker_end IN ('none', 'arrow')),
  label TEXT CHECK (label IS NULL OR length(label) <= 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision) = 'integer'
    AND revision BETWEEN 1 AND 9007199254740991
  ),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_operation_id TEXT,
  CHECK (source_item_id <> target_item_id),
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_operation_id IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND length(deleted_at) > 0
      AND deleted_by IS NOT NULL
      AND length(trim(deleted_by)) BETWEEN 1 AND 320
      AND deletion_operation_id IS NOT NULL
      AND length(deletion_operation_id) BETWEEN 1 AND 256
    )
  )
);

CREATE TABLE project_items (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  item_type TEXT NOT NULL CHECK (item_type IN ('content', 'reference')),
  project_content_id TEXT UNIQUE REFERENCES project_contents(id) ON DELETE RESTRICT,
  reference_target_id TEXT REFERENCES reference_targets(id) ON DELETE RESTRICT,
  created_sequence INTEGER NOT NULL CHECK (
    typeof(created_sequence) = 'integer'
    AND created_sequence BETWEEN 1 AND 9007199254740991
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision) = 'integer'
    AND revision BETWEEN 1 AND 9007199254740991
  ),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_operation_id TEXT,
  CHECK (
    (item_type = 'content' AND project_content_id IS NOT NULL AND reference_target_id IS NULL)
    OR (item_type = 'reference' AND project_content_id IS NULL AND reference_target_id IS NOT NULL)
  ),
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_operation_id IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND length(deleted_at) > 0
      AND deleted_by IS NOT NULL
      AND length(trim(deleted_by)) BETWEEN 1 AND 320
      AND deletion_operation_id IS NOT NULL
      AND length(deletion_operation_id) BETWEEN 1 AND 256
    )
  ),
  UNIQUE(project_id, created_sequence)
);

CREATE TABLE project_map_placements (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_item_id TEXT NOT NULL UNIQUE REFERENCES project_items(id) ON DELETE RESTRICT,
  -- These bounds must match shared/project-types.ts.
  x REAL NOT NULL CHECK (
    typeof(x) IN ('integer', 'real') AND x BETWEEN -1000000 AND 1000000
  ),
  y REAL NOT NULL CHECK (
    typeof(y) IN ('integer', 'real') AND y BETWEEN -1000000 AND 1000000
  ),
  width REAL NOT NULL CHECK (
    typeof(width) IN ('integer', 'real') AND width > 0 AND width <= 100000
  ),
  height REAL NOT NULL CHECK (
    typeof(height) IN ('integer', 'real') AND height > 0 AND height <= 100000
  ),
  z_index INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(z_index) = 'integer' AND z_index BETWEEN -1000000 AND 1000000
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision) = 'integer'
    AND revision BETWEEN 1 AND 9007199254740991
  ),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(revision) = 'integer'
    AND revision BETWEEN 1 AND 9007199254740991
  ),
  next_created_sequence INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(next_created_sequence) = 'integer'
    AND next_created_sequence BETWEEN 1 AND 9007199254740991
  ),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_operation_id TEXT,
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_operation_id IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND length(deleted_at) > 0
      AND deleted_by IS NOT NULL
      AND length(trim(deleted_by)) BETWEEN 1 AND 320
      AND deletion_operation_id IS NOT NULL
      AND length(deletion_operation_id) BETWEEN 1 AND 256
    )
  )
);

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

CREATE TABLE reference_targets (
  id TEXT PRIMARY KEY,
  registry_version INTEGER NOT NULL DEFAULT 1 CHECK (registry_version = 1),
  target_type TEXT NOT NULL CHECK (target_type IN (
    'sample',
    'run',
    'run_step',
    'comment',
    'comment_occurrence',
    'comment_attachment',
    'execution_image',
    'metrology_reference',
    'recipe_revision'
  )),
  target_id TEXT NOT NULL CHECK (length(target_id) > 0),
  first_registered_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  tombstoned_at TEXT,
  last_known_contexts_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(last_known_contexts_json)
      AND json_type(last_known_contexts_json) = 'array'
    ),
  UNIQUE(target_type, target_id)
);

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

CREATE TABLE run_step_assets (
  id TEXT PRIMARY KEY,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  role TEXT NOT NULL CHECK (role IN ('execution', 'state_observation')),
  position INTEGER NOT NULL DEFAULT 0,
  actor_email TEXT,
  created_at TEXT NOT NULL, deleted_at TEXT, deleted_by TEXT, last_mutation_id TEXT, superseded_by_occurrence_id TEXT REFERENCES run_step_assets(id), superseded_at TEXT, superseded_by TEXT, supersession_operation_id TEXT, filename TEXT, mime_type TEXT, byte_size INTEGER,
  UNIQUE(run_step_id, asset_id, role)
);

CREATE TABLE "run_step_comments" (
  id TEXT PRIMARY KEY,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('common', 'individual')),
  operation_group_id TEXT,
  asset_id TEXT REFERENCES assets(id),
  actor_email TEXT,
  created_at TEXT NOT NULL
, submission_id TEXT REFERENCES comment_submissions(id), updated_at TEXT, updated_by TEXT, deleted_at TEXT, deleted_by TEXT, asset_deleted_at TEXT, asset_deleted_by TEXT, last_mutation_id TEXT, deletion_operation_id TEXT, asset_deletion_operation_id TEXT, legacy_body TEXT
);

CREATE TABLE run_step_plan_links (
  run_plan_revision_id TEXT NOT NULL REFERENCES run_plan_revisions(id) ON DELETE CASCADE,
  template_step_id TEXT NOT NULL REFERENCES template_steps(id),
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'planned' CHECK (relation IN ('planned', 'fulfilled', 'skipped', 'deviated', 'substituted', 'retry', 'manual_anchor', 'historical')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_plan_revision_id, template_step_id, run_step_id)
);

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
  updated_at TEXT NOT NULL, entry_kind TEXT NOT NULL DEFAULT 'fabrication'
CHECK (entry_kind IN ('fabrication', 'metrology')), deleted_at TEXT, deleted_by TEXT,
  UNIQUE(run_id, position)
);

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
  completed_at TEXT, initial_state_hash TEXT REFERENCES state_representations(hash), run_kind TEXT NOT NULL DEFAULT 'process'
CHECK (run_kind IN ('process', 'metrology')), deleted_at TEXT, deleted_by TEXT, last_mutation_id TEXT,
  UNIQUE(sample_id, sequence_no)
);

CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('active', 'stored', 'consumed', 'lost')),
  location TEXT,
  parent_id TEXT REFERENCES samples(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  updated_by TEXT,
  last_mutation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, inherited_state_hash TEXT REFERENCES state_representations(hash), deleted_at TEXT, deleted_by TEXT);

CREATE TABLE state_representation_assets (
  state_hash TEXT NOT NULL REFERENCES state_representations(hash) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (state_hash, asset_id)
);

CREATE TABLE state_representations (
  hash TEXT PRIMARY KEY,
  hash_scheme TEXT NOT NULL DEFAULT 'state-diagram/v1',
  representation_type TEXT NOT NULL DEFAULT 'diagram',
  logical_state_key TEXT,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE state_verification_steps (
  verification_id TEXT NOT NULL REFERENCES state_verifications(id) ON DELETE CASCADE,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (verification_id, run_step_id)
);

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
  archived_by TEXT, template_kind TEXT NOT NULL DEFAULT 'process'
CHECK (template_kind IN ('process', 'metrology')), metrology_notes TEXT, deleted_at TEXT, deleted_by TEXT,
  UNIQUE(recipe_family_id, version),
  UNIQUE(name, template_type, version)
);

-- Exact built-in seed rows, before installing guards (none are disabled).
INSERT INTO "recipe_families" ("id", "name", "template_type", "created_by", "created_at", "archived_at", "archived_by") VALUES ('builtin-metrology-family-afm', 'Retired built-in · AFM · builtin-metrology-family-afm', 'module', NULL, '2026-07-24T00:00:00.000Z', '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology');
INSERT INTO "recipe_families" ("id", "name", "template_type", "created_by", "created_at", "archived_at", "archived_by") VALUES ('builtin-metrology-family-optical-microscope', 'Retired built-in · Optical microscope · builtin-metrology-family-optical-microscope', 'module', NULL, '2026-07-24T00:00:00.000Z', '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology');
INSERT INTO "recipe_families" ("id", "name", "template_type", "created_by", "created_at", "archived_at", "archived_by") VALUES ('builtin-metrology-family-sem', 'Retired built-in · SEM · builtin-metrology-family-sem', 'module', NULL, '2026-07-24T00:00:00.000Z', '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology');
INSERT INTO "recipe_families" ("id", "name", "template_type", "created_by", "created_at", "archived_at", "archived_by") VALUES ('builtin-metrology-family-tem', 'Retired built-in · TEM · builtin-metrology-family-tem', 'module', NULL, '2026-07-24T00:00:00.000Z', '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology');
INSERT INTO "recipe_families" ("id", "name", "template_type", "created_by", "created_at", "archived_at", "archived_by") VALUES ('builtin-metrology-family-xrd', 'Retired built-in · XRD · builtin-metrology-family-xrd', 'module', NULL, '2026-07-24T00:00:00.000Z', '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology');
INSERT INTO "step_definitions" ("hash", "hash_scheme", "name", "tool_name", "parameters_text", "comments_text", "canonical_json", "created_at") VALUES ('5f9d9a7b109c964d38b31409327aa4679e66770f6ea806db913e506b80c3c23c', 'step-definition/v1', 'Optical microscope', NULL, NULL, NULL, '{"commentsText":null,"name":"Optical microscope","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z');
INSERT INTO "step_definitions" ("hash", "hash_scheme", "name", "tool_name", "parameters_text", "comments_text", "canonical_json", "created_at") VALUES ('9025873f845664d95a057cf912841db6ef58e9c56045422151cdf4bfe1aed953', 'step-definition/v1', 'AFM', NULL, NULL, NULL, '{"commentsText":null,"name":"AFM","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z');
INSERT INTO "step_definitions" ("hash", "hash_scheme", "name", "tool_name", "parameters_text", "comments_text", "canonical_json", "created_at") VALUES ('b340e57f0b53f1d1f657f99ef1bd25c8b9b54dd442a1d50ae7ea7a936af409b5', 'step-definition/v1', 'SEM', NULL, NULL, NULL, '{"commentsText":null,"name":"SEM","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z');
INSERT INTO "step_definitions" ("hash", "hash_scheme", "name", "tool_name", "parameters_text", "comments_text", "canonical_json", "created_at") VALUES ('d17dc56cbd17d7edbd2290926580871834b226e6823c52bfe18af125dddecdae', 'step-definition/v1', 'XRD', NULL, NULL, NULL, '{"commentsText":null,"name":"XRD","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z');
INSERT INTO "step_definitions" ("hash", "hash_scheme", "name", "tool_name", "parameters_text", "comments_text", "canonical_json", "created_at") VALUES ('f139b09ba3ea4362d62a582621083ab0f3cb2d7abdf7524867ec59deab52014f', 'step-definition/v1', 'TEM', NULL, NULL, NULL, '{"commentsText":null,"name":"TEM","parametersText":null,"schema":"step-definition/v1","toolName":null}', '2026-07-24T00:00:00.000Z');
INSERT INTO "template_versions" ("id", "recipe_family_id", "name", "template_type", "version", "manifest_hash", "initial_state_hash", "source_filename", "source_asset_key", "content_json", "created_by", "created_at", "locked_at", "locked_by", "archived_at", "archived_by", "template_kind", "metrology_notes", "deleted_at", "deleted_by") VALUES ('builtin-metrology-template-afm', 'builtin-metrology-family-afm', 'Retired built-in · AFM · builtin-metrology-template-afm', 'module', 1, 'd18ae053070cf942a85aa7e484924ce9c9b1efc2f5ec906732712a193178ae82', NULL, NULL, NULL, '{}', NULL, '2026-07-24T00:00:00.000Z', NULL, NULL, '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology', 'metrology', NULL, NULL, NULL);
INSERT INTO "template_versions" ("id", "recipe_family_id", "name", "template_type", "version", "manifest_hash", "initial_state_hash", "source_filename", "source_asset_key", "content_json", "created_by", "created_at", "locked_at", "locked_by", "archived_at", "archived_by", "template_kind", "metrology_notes", "deleted_at", "deleted_by") VALUES ('builtin-metrology-template-optical-microscope', 'builtin-metrology-family-optical-microscope', 'Retired built-in · Optical microscope · builtin-metrology-template-optical-microscope', 'module', 1, '73dac1d691d2d9da2b90820a4d9f9a17c75587936bb675f56181ed72dbdcbc19', NULL, NULL, NULL, '{}', NULL, '2026-07-24T00:00:00.000Z', NULL, NULL, '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology', 'metrology', NULL, NULL, NULL);
INSERT INTO "template_versions" ("id", "recipe_family_id", "name", "template_type", "version", "manifest_hash", "initial_state_hash", "source_filename", "source_asset_key", "content_json", "created_by", "created_at", "locked_at", "locked_by", "archived_at", "archived_by", "template_kind", "metrology_notes", "deleted_at", "deleted_by") VALUES ('builtin-metrology-template-sem', 'builtin-metrology-family-sem', 'Retired built-in · SEM · builtin-metrology-template-sem', 'module', 1, 'af42e07d129a1478738a48faad869e4400e6b0c505d1d5689902a0f85bb0c574', NULL, NULL, NULL, '{}', NULL, '2026-07-24T00:00:00.000Z', NULL, NULL, '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology', 'metrology', NULL, NULL, NULL);
INSERT INTO "template_versions" ("id", "recipe_family_id", "name", "template_type", "version", "manifest_hash", "initial_state_hash", "source_filename", "source_asset_key", "content_json", "created_by", "created_at", "locked_at", "locked_by", "archived_at", "archived_by", "template_kind", "metrology_notes", "deleted_at", "deleted_by") VALUES ('builtin-metrology-template-tem', 'builtin-metrology-family-tem', 'Retired built-in · TEM · builtin-metrology-template-tem', 'module', 1, 'a41a8b2554607eb7af6db4f6d5fb1fd0829ca913103ad4ec1243fffc7fb2bc6c', NULL, NULL, NULL, '{}', NULL, '2026-07-24T00:00:00.000Z', NULL, NULL, '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology', 'metrology', NULL, NULL, NULL);
INSERT INTO "template_versions" ("id", "recipe_family_id", "name", "template_type", "version", "manifest_hash", "initial_state_hash", "source_filename", "source_asset_key", "content_json", "created_by", "created_at", "locked_at", "locked_by", "archived_at", "archived_by", "template_kind", "metrology_notes", "deleted_at", "deleted_by") VALUES ('builtin-metrology-template-xrd', 'builtin-metrology-family-xrd', 'Retired built-in · XRD · builtin-metrology-template-xrd', 'module', 1, 'd0b71ed04db386da4146074977e798f63f6253b58faba585040be4b61a47d02f', NULL, NULL, NULL, '{}', NULL, '2026-07-24T00:00:00.000Z', NULL, NULL, '2026-08-07T00:00:00.000Z', 'system:retire-builtin-metrology', 'metrology', NULL, NULL, NULL);
INSERT INTO "template_steps" ("id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json") VALUES ('builtin-metrology-step-afm', 'builtin-metrology-template-afm', 'metrology:afm', 0, NULL, NULL, NULL, '9025873f845664d95a057cf912841db6ef58e9c56045422151cdf4bfe1aed953', NULL, '{}');
INSERT INTO "template_steps" ("id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json") VALUES ('builtin-metrology-step-optical-microscope', 'builtin-metrology-template-optical-microscope', 'metrology:optical-microscope', 0, NULL, NULL, NULL, '5f9d9a7b109c964d38b31409327aa4679e66770f6ea806db913e506b80c3c23c', NULL, '{}');
INSERT INTO "template_steps" ("id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json") VALUES ('builtin-metrology-step-sem', 'builtin-metrology-template-sem', 'metrology:sem', 0, NULL, NULL, NULL, 'b340e57f0b53f1d1f657f99ef1bd25c8b9b54dd442a1d50ae7ea7a936af409b5', NULL, '{}');
INSERT INTO "template_steps" ("id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json") VALUES ('builtin-metrology-step-tem', 'builtin-metrology-template-tem', 'metrology:tem', 0, NULL, NULL, NULL, 'f139b09ba3ea4362d62a582621083ab0f3cb2d7abdf7524867ec59deab52014f', NULL, '{}');
INSERT INTO "template_steps" ("id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json") VALUES ('builtin-metrology-step-xrd', 'builtin-metrology-template-xrd', 'metrology:xrd', 0, NULL, NULL, NULL, 'd17dc56cbd17d7edbd2290926580871834b226e6823c52bfe18af125dddecdae', NULL, '{}');

-- Final index definitions, retaining creation order and normalized SQL.
CREATE INDEX samples_updated_idx ON samples(updated_at DESC);

CREATE INDEX samples_parent_idx ON samples(parent_id);

CREATE INDEX events_sample_created_idx ON events(sample_id, created_at DESC);

CREATE INDEX assets_import_idx ON assets(import_id);

CREATE INDEX state_representation_assets_order_idx
ON state_representation_assets(state_hash, position);

CREATE INDEX template_versions_active_idx
ON template_versions(archived_at, template_type, name, version);

CREATE INDEX template_steps_version_idx ON template_steps(template_version_id, position);

CREATE INDEX template_steps_definition_idx ON template_steps(definition_hash);

CREATE INDEX template_steps_expected_state_idx ON template_steps(expected_state_hash);

CREATE INDEX runs_sample_sequence_idx ON runs(sample_id, sequence_no DESC);

CREATE INDEX runs_group_idx ON runs(run_group_id);

CREATE INDEX run_plan_revisions_run_idx ON run_plan_revisions(run_id, revision_no DESC);

CREATE INDEX run_steps_run_position_idx ON run_steps(run_id, position);

CREATE INDEX run_steps_definition_idx ON run_steps(definition_hash);

CREATE INDEX run_steps_state_idx ON run_steps(expected_state_hash);

CREATE INDEX run_step_plan_links_step_idx ON run_step_plan_links(run_step_id);

CREATE INDEX run_step_assets_step_idx ON run_step_assets(run_step_id, role, position);

CREATE INDEX state_verifications_sample_created_idx
ON state_verifications(sample_id, created_at, id);

CREATE INDEX state_verification_steps_step_idx ON state_verification_steps(run_step_id);

CREATE INDEX runs_initial_state_idx
ON runs(initial_state_hash);

CREATE INDEX samples_inherited_state_idx
ON samples(inherited_state_hash);

CREATE INDEX comment_submissions_sample_idx
ON comment_submissions(sample_id, created_at DESC);

CREATE INDEX comment_submissions_status_idx
ON comment_submissions(status, updated_at);

CREATE INDEX comment_submission_targets_sample_idx
ON comment_submission_targets(sample_id, submission_id);

CREATE INDEX comment_submission_items_submission_idx
ON comment_submission_items(submission_id, position);

CREATE INDEX comment_submission_items_asset_idx
ON comment_submission_items(asset_id) WHERE asset_id IS NOT NULL;

CREATE INDEX comment_submission_items_storage_idx
ON comment_submission_items(storage_object_id) WHERE storage_object_id IS NOT NULL;

CREATE INDEX metrology_template_references_template_idx
ON metrology_template_references(template_version_id, position, created_at);

CREATE INDEX samples_directory_idx
ON samples(pinned DESC, updated_at DESC, id);

CREATE INDEX runs_sample_kind_sequence_idx
ON runs(sample_id, run_kind, sequence_no DESC);

CREATE INDEX run_steps_directory_state_idx
ON run_steps(run_id, entry_kind, plan_status, status, position);

CREATE INDEX template_versions_kind_family_version_idx
ON template_versions(template_kind, archived_at, recipe_family_id, version DESC);

CREATE INDEX template_versions_kind_name_idx
ON template_versions(template_kind, archived_at, name, template_type, version DESC);

CREATE INDEX samples_status_updated_idx
ON samples(status, updated_at DESC, id);

CREATE INDEX samples_status_created_idx
ON samples(status, created_at DESC, id);

CREATE INDEX samples_created_idx
ON samples(created_at DESC, id);

CREATE INDEX samples_location_updated_idx
ON samples(location COLLATE NOCASE, updated_at DESC, id);

CREATE INDEX runs_family_kind_status_sample_idx
ON runs(recipe_family_id, run_kind, status, sample_id);

CREATE INDEX samples_visible_updated_idx
ON samples(updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX runs_visible_sample_sequence_idx
ON runs(sample_id, sequence_no DESC)
WHERE deleted_at IS NULL;

CREATE INDEX run_steps_visible_run_position_idx
ON run_steps(run_id, position)
WHERE deleted_at IS NULL;

CREATE INDEX comment_submissions_visible_updated_idx
ON comment_submissions(updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX comment_submission_items_visible_submission_idx
ON comment_submission_items(submission_id, position)
WHERE deleted_at IS NULL;

CREATE INDEX run_step_assets_visible_step_idx
ON run_step_assets(run_step_id, role, position)
WHERE deleted_at IS NULL;

CREATE INDEX metrology_template_references_visible_template_idx
ON metrology_template_references(template_version_id, position, created_at)
WHERE deleted_at IS NULL;

CREATE INDEX template_versions_visible_kind_name_idx
ON template_versions(template_kind, name, version)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX runs_one_active_process_per_sample_idx
ON runs(sample_id)
WHERE status = 'active' AND run_kind = 'process' AND deleted_at IS NULL;

CREATE UNIQUE INDEX runs_single_successor_idx
ON runs(predecessor_run_id)
WHERE predecessor_run_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX comment_submissions_retry_idx
ON comment_submissions(retry_closed_at, retry_until, status);

CREATE INDEX blob_gc_ledger_state_idx
ON blob_gc_ledger(state, orphaned_at, updated_at);

CREATE INDEX blob_gc_ledger_record_idx
ON blob_gc_ledger(store_kind, blob_record_id);

CREATE INDEX state_representation_assets_asset_idx
ON state_representation_assets(asset_id);

CREATE INDEX run_step_assets_asset_idx
ON run_step_assets(asset_id);

CREATE INDEX metrology_template_references_asset_idx
ON metrology_template_references(asset_id);

CREATE INDEX state_verifications_evidence_asset_idx
ON state_verifications(evidence_asset_id)
WHERE evidence_asset_id IS NOT NULL;

CREATE INDEX events_asset_key_idx
ON events(asset_key)
WHERE asset_key IS NOT NULL;

CREATE INDEX imports_workbook_asset_key_idx
ON imports(workbook_asset_key)
WHERE workbook_asset_key IS NOT NULL;

CREATE INDEX imports_manifest_asset_key_idx
ON imports(manifest_asset_key)
WHERE manifest_asset_key IS NOT NULL;

CREATE INDEX template_versions_source_asset_key_idx
ON template_versions(source_asset_key)
WHERE source_asset_key IS NOT NULL;

CREATE INDEX assets_sha256_lookup_idx
ON assets(sha256, status)
WHERE sha256 IS NOT NULL;

CREATE INDEX events_thumbnail_asset_key_idx
ON events(
  CASE WHEN json_valid(metadata_json)
       THEN json_extract(metadata_json, '$.thumbnailKey') END
)
WHERE typeof(
    CASE WHEN json_valid(metadata_json)
         THEN json_extract(metadata_json, '$.thumbnailKey') END
  ) = 'text'
  AND NULLIF(TRIM(
    CASE WHEN json_valid(metadata_json)
         THEN json_extract(metadata_json, '$.thumbnailKey') END
  ), '') IS NOT NULL;

CREATE INDEX reference_targets_type_validated_idx
ON reference_targets(target_type, last_validated_at);

CREATE INDEX reference_targets_tombstoned_idx
ON reference_targets(tombstoned_at)
WHERE tombstoned_at IS NOT NULL;

CREATE INDEX projects_visible_updated_idx
ON projects(deleted_at, updated_at DESC, id);

CREATE INDEX project_contents_project_visible_idx
ON project_contents(project_id, deleted_at, created_at, id);

CREATE INDEX project_content_attachments_asset_idx
ON project_content_attachments(asset_id)
WHERE asset_id IS NOT NULL;

CREATE INDEX project_content_attachments_storage_idx
ON project_content_attachments(storage_object_id)
WHERE storage_object_id IS NOT NULL;

CREATE INDEX project_items_project_reading_idx
ON project_items(project_id, created_sequence, id)
WHERE deleted_at IS NULL;

CREATE INDEX project_items_reference_backlink_idx
ON project_items(reference_target_id, project_id, id)
WHERE reference_target_id IS NOT NULL;

CREATE INDEX project_edges_project_visible_idx
ON project_edges(project_id, deleted_at, created_at, id);

CREATE INDEX project_edges_source_visible_idx
ON project_edges(source_item_id, deleted_at, id);

CREATE INDEX project_edges_target_visible_idx
ON project_edges(target_item_id, deleted_at, id);

CREATE UNIQUE INDEX project_edges_active_identity_idx
ON project_edges(
  project_id,
  source_item_id,
  target_item_id,
  source_handle,
  target_handle,
  marker_start,
  marker_end,
  COALESCE(label, '')
)
WHERE deleted_at IS NULL;

CREATE INDEX blob_integrity_quarantine_record_idx
ON blob_integrity_quarantine(store_kind, blob_record_id)
WHERE blob_record_id IS NOT NULL;

CREATE UNIQUE INDEX imports_operation_id_unique_idx
ON imports(operation_id)
WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX imports_finalization_id_unique_idx
ON imports(finalization_id)
WHERE finalization_id IS NOT NULL;

CREATE INDEX imports_pending_lease_idx
ON imports(lease_expires_at, id)
WHERE status = 'pending';

CREATE INDEX managed_storage_objects_content_lookup_idx
ON managed_storage_objects(provider, sha256, byte_size, status);

CREATE INDEX imports_template_publication_idx
ON imports(template_version_id, status)
WHERE template_version_id IS NOT NULL;

CREATE INDEX imports_recovery_successor_idx
ON imports(status, recovery_operation_id, created_at, id)
WHERE finalization_id IS NULL AND status IN ('pending', 'failed');

CREATE INDEX run_step_assets_supersession_idx
ON run_step_assets(superseded_by_occurrence_id)
WHERE superseded_by_occurrence_id IS NOT NULL;

CREATE INDEX metrology_template_references_supersession_idx
ON metrology_template_references(superseded_by_occurrence_id)
WHERE superseded_by_occurrence_id IS NOT NULL;

CREATE UNIQUE INDEX attachment_derivatives_identity_idx
ON attachment_derivatives(
  source_sha256,
  source_byte_size,
  derivative_kind,
  generator_version
);

CREATE INDEX attachment_derivatives_asset_idx
ON attachment_derivatives(derived_asset_id)
WHERE derived_asset_id IS NOT NULL;

CREATE INDEX attachment_derivatives_retention_idx
ON attachment_derivatives(status, retain_until);

CREATE INDEX run_step_comments_step_created_idx
ON run_step_comments(run_step_id, created_at, id);

CREATE INDEX run_step_comments_operation_group_idx
ON run_step_comments(operation_group_id) WHERE operation_group_id IS NOT NULL;

CREATE INDEX run_step_comments_asset_idx
ON run_step_comments(asset_id) WHERE asset_id IS NOT NULL;

CREATE INDEX run_step_comments_submission_idx
ON run_step_comments(submission_id) WHERE submission_id IS NOT NULL;

CREATE INDEX run_step_comments_visible_step_created_idx
ON run_step_comments(run_step_id, created_at, id)
WHERE deleted_at IS NULL;

CREATE INDEX run_step_comments_visible_asset_idx
ON run_step_comments(asset_id)
WHERE asset_id IS NOT NULL AND asset_deleted_at IS NULL;

CREATE INDEX run_step_comments_deletion_operation_idx
ON run_step_comments(submission_id, deletion_operation_id)
WHERE deleted_at IS NOT NULL AND deletion_operation_id IS NOT NULL;

CREATE INDEX run_step_comments_asset_deletion_operation_idx
ON run_step_comments(operation_group_id, asset_deletion_operation_id)
WHERE asset_deleted_at IS NOT NULL AND asset_deletion_operation_id IS NOT NULL;


-- Final view definitions, retaining creation order and normalized SQL.
CREATE VIEW blob_retention_edges_direct_keys AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  e.asset_key AS object_key,
  a.id AS blob_record_id,
  'sample' AS source_type,
  e.sample_id AS source_id,
  'event' AS occurrence_type,
  e.id AS occurrence_id,
  'legacy_event_asset' AS retention_reason,
  NULL AS retain_until
FROM events e
LEFT JOIN assets a ON a.r2_key = e.asset_key
WHERE e.asset_key IS NOT NULL AND e.asset_key <> ''

UNION ALL
SELECT
  'r2', 'r2', thumbnails.thumbnail_key, a.id,
  'sample', thumbnails.sample_id,
  'event_thumbnail', thumbnails.id || ':thumbnail',
  'sample_record_thumbnail', NULL
FROM (
  SELECT e.id, e.sample_id, e.asset_key,
         CASE WHEN json_valid(e.metadata_json)
              THEN json_extract(e.metadata_json, '$.thumbnailKey') END AS thumbnail_key
  FROM events e
) thumbnails
LEFT JOIN assets a ON a.r2_key = thumbnails.thumbnail_key
WHERE typeof(thumbnails.thumbnail_key) = 'text'
  AND NULLIF(TRIM(thumbnails.thumbnail_key), '') IS NOT NULL
  AND thumbnails.thumbnail_key IS NOT thumbnails.asset_key

UNION ALL
SELECT
  'r2', 'r2', i.workbook_asset_key, a.id,
  'import', i.id,
  'import_workbook', i.id || ':workbook',
  'import_provenance', NULL
FROM imports i
LEFT JOIN assets a ON a.r2_key = i.workbook_asset_key
WHERE i.workbook_asset_key IS NOT NULL AND i.workbook_asset_key <> ''

UNION ALL
SELECT
  'r2', 'r2', i.manifest_asset_key, a.id,
  'import', i.id,
  'import_manifest', i.id || ':manifest',
  'import_provenance', NULL
FROM imports i
LEFT JOIN assets a ON a.r2_key = i.manifest_asset_key
WHERE i.manifest_asset_key IS NOT NULL AND i.manifest_asset_key <> ''

UNION ALL
SELECT
  'r2', 'r2', tv.source_asset_key, a.id,
  'template_version', tv.id,
  'template_source', tv.id || ':source',
  'template_provenance', NULL
FROM template_versions tv
LEFT JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE tv.source_asset_key IS NOT NULL AND tv.source_asset_key <> '';

CREATE VIEW blob_retention_edges_project_attachments AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'project_content' AS source_type,
  pca.project_content_id AS source_id,
  'project_content_attachment' AS occurrence_type,
  pca.project_content_id AS occurrence_id,
  'project_attachment' AS retention_reason,
  NULL AS retain_until
FROM project_content_attachments pca
JOIN assets a ON a.id = pca.asset_id

UNION ALL
SELECT
  'managed', mso.provider, mso.object_key, mso.id,
  'project_content', pca.project_content_id,
  'project_content_attachment', pca.project_content_id,
  'project_attachment', NULL
FROM project_content_attachments pca
JOIN managed_storage_objects mso ON mso.id = pca.storage_object_id;

CREATE VIEW fabublox_recovery_public_asset_edges_state AS
SELECT
  sra.asset_id,
  'template_version_initial_state' AS consumer_type,
  tv.id AS consumer_id
FROM state_representation_assets sra
JOIN template_versions tv ON tv.initial_state_hash = sra.state_hash
WHERE NOT EXISTS (
  SELECT 1 FROM imports owner
  WHERE owner.template_version_id = tv.id AND owner.status <> 'ready'
)

UNION ALL
SELECT
  sra.asset_id,
  'template_step_expected_state',
  ts.id
FROM state_representation_assets sra
JOIN template_steps ts ON ts.expected_state_hash = sra.state_hash
JOIN template_versions tv ON tv.id = ts.template_version_id
WHERE NOT EXISTS (
  SELECT 1 FROM imports owner
  WHERE owner.template_version_id = tv.id AND owner.status <> 'ready'
)

UNION ALL
SELECT
  sra.asset_id,
  'run_step_expected_state',
  rs.id
FROM state_representation_assets sra
JOIN run_steps rs ON rs.expected_state_hash = sra.state_hash

UNION ALL
SELECT
  sra.asset_id,
  'run_initial_state',
  r.id
FROM state_representation_assets sra
JOIN runs r ON r.initial_state_hash = sra.state_hash

UNION ALL
SELECT
  sra.asset_id,
  'sample_inherited_state',
  s.id
FROM state_representation_assets sra
JOIN samples s ON s.inherited_state_hash = sra.state_hash;

CREATE VIEW fabublox_import_asset_dependencies_provenance AS
SELECT
  i.id AS import_id,
  a.id AS asset_id,
  'owned_asset' AS dependency_type,
  a.id AS dependency_id
FROM imports i
JOIN assets a ON a.import_id = i.id

UNION ALL
SELECT
  i.id,
  a.id,
  'import_workbook',
  i.id || ':workbook'
FROM imports i
JOIN assets a ON a.r2_key = i.workbook_asset_key
WHERE i.workbook_asset_key IS NOT NULL
  AND i.workbook_asset_key <> ''

UNION ALL
SELECT
  i.id,
  a.id,
  'import_manifest',
  i.id || ':manifest'
FROM imports i
JOIN assets a ON a.r2_key = i.manifest_asset_key
WHERE i.manifest_asset_key IS NOT NULL
  AND i.manifest_asset_key <> '';

CREATE VIEW fabublox_import_asset_dependencies_template AS
SELECT
  i.id AS import_id,
  sra.asset_id,
  'template_initial_state' AS dependency_type,
  tv.id AS dependency_id
FROM imports i
JOIN template_versions tv ON tv.id = i.template_version_id
JOIN state_representation_assets sra
  ON sra.state_hash = tv.initial_state_hash
WHERE i.template_version_id IS NOT NULL
  AND tv.initial_state_hash IS NOT NULL

UNION ALL
SELECT
  i.id,
  sra.asset_id,
  'template_step_expected_state',
  ts.id
FROM imports i
JOIN template_steps ts ON ts.template_version_id = i.template_version_id
JOIN state_representation_assets sra
  ON sra.state_hash = ts.expected_state_hash
WHERE i.template_version_id IS NOT NULL
  AND ts.expected_state_hash IS NOT NULL

UNION ALL
SELECT
  i.id,
  mtr.asset_id,
  'metrology_template_reference',
  mtr.id
FROM imports i
JOIN metrology_template_references mtr
  ON mtr.template_version_id = i.template_version_id
WHERE i.template_version_id IS NOT NULL
  AND mtr.superseded_by_occurrence_id IS NULL

UNION ALL
SELECT
  i.id,
  a.id,
  'template_source',
  tv.id
FROM imports i
JOIN template_versions tv ON tv.id = i.template_version_id
LEFT JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE i.template_version_id IS NOT NULL
  AND NULLIF(TRIM(tv.source_asset_key), '') IS NOT NULL;

CREATE VIEW fabublox_import_asset_dependencies AS
SELECT * FROM fabublox_import_asset_dependencies_template
UNION ALL
SELECT * FROM fabublox_import_asset_dependencies_provenance;

CREATE VIEW fabublox_recovery_import_asset_edges AS
SELECT DISTINCT
  dependency.asset_id,
  i.id AS import_id,
  i.status AS import_status,
  i.created_at AS import_created_at
FROM fabublox_import_asset_dependencies dependency
JOIN imports i ON i.id = dependency.import_id
WHERE dependency.asset_id IS NOT NULL
  AND i.status IN ('pending', 'failed')
  AND i.finalization_id IS NULL
  AND (i.status = 'pending' OR i.recovery_operation_id IS NULL);

CREATE VIEW fabublox_recovery_public_asset_edges_template AS
SELECT
  sra.asset_id,
  'state_verification_expected_state' AS consumer_type,
  sv.id AS consumer_id
FROM state_representation_assets sra
JOIN state_verifications sv ON sv.expected_state_hash = sra.state_hash

UNION ALL
SELECT
  mtr.asset_id,
  'published_metrology_template_reference',
  mtr.id
FROM metrology_template_references mtr
WHERE mtr.superseded_by_occurrence_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM imports owner
    WHERE owner.template_version_id = mtr.template_version_id
      AND owner.status <> 'ready'
  )

UNION ALL
SELECT
  a.id,
  'published_template_source',
  tv.id
FROM template_versions tv
JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE tv.source_asset_key IS NOT NULL AND tv.source_asset_key <> ''
  AND NOT EXISTS (
    SELECT 1 FROM imports owner
    WHERE owner.template_version_id = tv.id AND owner.status <> 'ready'
  )

UNION ALL
SELECT
  a.id,
  'ready_import_provenance',
  i.id
FROM imports i
JOIN assets a
  ON a.r2_key = i.workbook_asset_key OR a.r2_key = i.manifest_asset_key
WHERE i.status = 'ready';

CREATE VIEW blob_retention_edges_comment_items AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'comment_submission' AS source_type,
  cs.id AS source_id,
  'comment_submission_item' AS occurrence_type,
  csi.id AS occurrence_id,
  CASE WHEN csi.deleted_at IS NULL
    THEN 'ready_comment_item'
    ELSE 'deleted_comment_item_grace'
  END AS retention_reason,
  CASE WHEN csi.deleted_at IS NULL
    THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', csi.deleted_at, '+1 day')
  END AS retain_until
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN assets a ON a.id = csi.asset_id
WHERE cs.status = 'ready' AND csi.status = 'ready'
  AND (
    csi.deleted_at IS NULL
    OR datetime(csi.deleted_at, '+1 day') > datetime('now')
  )

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'comment_submission', cs.id,
  'comment_submission_item', csi.id,
  CASE WHEN cs.status = 'failed' THEN 'retryable_comment_item'
       ELSE 'unfinished_comment_item' END ,
  cs.retry_until
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN assets a ON a.id = csi.asset_id
WHERE csi.status <> 'cancelled' AND csi.deleted_at IS NULL
  AND cs.retry_closed_at IS NULL
  AND cs.status IN ('draft', 'uploading', 'failed')

UNION ALL
SELECT
  'managed', mso.provider, mso.object_key, mso.id,
  'comment_submission', cs.id,
  'comment_submission_item', csi.id,
  CASE WHEN csi.deleted_at IS NULL
    THEN 'ready_comment_item'
    ELSE 'deleted_comment_item_grace'
  END ,
  CASE WHEN csi.deleted_at IS NULL
    THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', csi.deleted_at, '+1 day')
  END
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
WHERE cs.status = 'ready' AND csi.status = 'ready'
  AND (
    csi.deleted_at IS NULL
    OR datetime(csi.deleted_at, '+1 day') > datetime('now')
  )

UNION ALL
SELECT
  'managed', mso.provider, mso.object_key, mso.id,
  'comment_submission', cs.id,
  'comment_submission_item', csi.id,
  CASE WHEN cs.status = 'failed' THEN 'retryable_comment_item'
       ELSE 'unfinished_comment_item' END ,
  cs.retry_until
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
WHERE csi.status <> 'cancelled' AND csi.deleted_at IS NULL
  AND cs.retry_closed_at IS NULL
  AND cs.status IN ('draft', 'uploading', 'failed');

CREATE VIEW attachment_derivative_browser_safe_assets AS
WITH classification_whitespace(value) AS (
  SELECT
    char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
    || char(160) || char(5760)
    || char(8192) || char(8193) || char(8194) || char(8195) || char(8196)
    || char(8197) || char(8198) || char(8199) || char(8200) || char(8201)
    || char(8202) || char(8232) || char(8233) || char(8239) || char(8287)
    || char(12288) || char(65279)
),
trimmed_assets AS (
  SELECT
    a.id,
    a.r2_key,
    a.original_name,
    a.mime_type,
    a.byte_size,
    a.sha256,
    trim( CASE
      WHEN instr(a.mime_type, ';') > 0
        THEN substr(a.mime_type, 1, instr(a.mime_type, ';') - 1)
      ELSE a.mime_type
    END , classification_whitespace.value) AS trimmed_mime_type
  FROM assets a
  CROSS JOIN classification_whitespace
  WHERE a.status = 'ready'
    AND instr(a.mime_type, char(0)) = 0
),
normalized_assets AS (
  SELECT
    id,
    r2_key,
    original_name,
    mime_type,
    byte_size,
    sha256,
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(trimmed_mime_type, 'A', 'a'), 'B', 'b'), 'C', 'c'), 'D', 'd'), 'E', 'e'), 'F', 'f'), 'G', 'g'), 'H', 'h'), 'I', 'i'), 'J', 'j'), 'K', 'k'), 'L', 'l'), 'M', 'm'), 'N', 'n'), 'O', 'o'), 'P', 'p'), 'Q', 'q'), 'R', 'r'), 'S', 's'), 'T', 't'), 'U', 'u'), 'V', 'v'), 'W', 'w'), 'X', 'x'), 'Y', 'y'), 'Z', 'z') AS normalized_mime_type
  FROM trimmed_assets
)
SELECT
  id,
  r2_key,
  original_name,
  mime_type,
  byte_size,
  sha256,
  normalized_mime_type
FROM normalized_assets
WHERE normalized_mime_type IN (
  'image/avif', 'image/bmp', 'image/gif',
  'image/jpeg', 'image/png', 'image/webp'
);

CREATE VIEW blob_retention_edges_attachment_derivatives AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'attachment_derivative' AS source_type,
  ad.id AS source_id,
  'attachment_derivative' AS occurrence_type,
  ad.id AS occurrence_id,
  'derivative_cache' AS retention_reason,
  ad.retain_until AS retain_until
FROM attachment_derivatives ad
JOIN attachment_derivative_browser_safe_assets a
  ON a.id = ad.derived_asset_id
WHERE ad.status = 'ready'
  AND ad.retain_until IS NOT NULL
  AND datetime(ad.retain_until) > datetime('now')
  AND NOT EXISTS (
    SELECT 1 FROM blob_gc_ledger bg
    WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
      AND bg.object_key = a.r2_key
      AND bg.state IN ('deleting', 'deleted')
  )
  AND NOT EXISTS (
    SELECT 1 FROM blob_integrity_quarantine biq
    WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
      AND biq.object_key = a.r2_key
  );

CREATE VIEW blob_retention_edges_r2_occurrences AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'state_representation' AS source_type,
  sra.state_hash AS source_id,
  'state_representation_asset' AS occurrence_type,
  sra.state_hash || ':' || sra.asset_id AS occurrence_id,
  'state_representation' AS retention_reason,
  NULL AS retain_until
FROM state_representation_assets sra
JOIN assets a ON a.id = sra.asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'run_step', rsa.run_step_id,
  'run_step_asset', rsa.id,
  CASE WHEN rsa.deleted_at IS NULL
    THEN 'run_step_asset'
    ELSE 'deleted_run_step_asset_grace'
  END ,
  CASE WHEN rsa.deleted_at IS NULL
    THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', rsa.deleted_at, '+1 day')
  END
FROM run_step_assets rsa
JOIN assets a ON a.id = rsa.asset_id
WHERE rsa.superseded_by_occurrence_id IS NULL
  AND (
    rsa.deleted_at IS NULL
    OR datetime(rsa.deleted_at, '+1 day') > datetime('now')
  )

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'template_version', mtr.template_version_id,
  'metrology_template_reference', mtr.id,
  'metrology_template_reference', NULL
FROM metrology_template_references mtr
JOIN assets a ON a.id = mtr.asset_id
WHERE mtr.superseded_by_occurrence_id IS NULL

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'run_step_comment', rsc.id,
  'run_step_comment_asset', rsc.id,
  'legacy_comment_asset', NULL
FROM run_step_comments rsc
JOIN assets a ON a.id = rsc.asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'state_verification', sv.id,
  'state_verification_evidence', sv.id,
  'verification_evidence', NULL
FROM state_verifications sv
JOIN assets a ON a.id = sv.evidence_asset_id;

CREATE VIEW blob_retention_edges AS
SELECT * FROM blob_retention_edges_r2_occurrences
UNION ALL
SELECT * FROM blob_retention_edges_comment_items
UNION ALL
SELECT * FROM blob_retention_edges_direct_keys
UNION ALL
SELECT * FROM blob_retention_edges_project_attachments
UNION ALL
SELECT * FROM blob_retention_edges_attachment_derivatives;

CREATE VIEW fabublox_recovery_public_asset_edges_external AS
SELECT
  bre.blob_record_id AS asset_id,
  bre.source_type AS consumer_type,
  bre.source_id AS consumer_id
FROM blob_retention_edges bre
WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
  AND bre.blob_record_id IS NOT NULL
  AND bre.source_type NOT IN ('state_representation', 'template_version', 'import');

CREATE VIEW fabublox_recovery_public_asset_edges AS
SELECT * FROM fabublox_recovery_public_asset_edges_external
UNION ALL
SELECT * FROM fabublox_recovery_public_asset_edges_state
UNION ALL
SELECT * FROM fabublox_recovery_public_asset_edges_template;


-- Final trigger definitions, retaining creation order and normalized SQL.
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
    CASE WHEN NEW.pinned = 1 THEN 'Sample pinned' ELSE 'Sample unpinned' END ,
    json_object('field', 'pinned', 'previous', OLD.pinned = 1, 'current', NEW.pinned = 1),
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER run_plan_revisions_lock_template
AFTER INSERT ON run_plan_revisions
BEGIN
  UPDATE template_versions
  SET locked_at = COALESCE(locked_at, NEW.created_at),
      locked_by = COALESCE(locked_by, NEW.actor_email)
  WHERE id = NEW.template_version_id;
END;

CREATE TRIGGER runs_release_unreferenced_templates
AFTER DELETE ON runs
BEGIN
  UPDATE template_versions
  SET locked_at = NULL,
      locked_by = NULL
  WHERE archived_at IS NULL
    AND locked_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM runs r
      WHERE r.template_version_id = template_versions.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_plan_revisions rpr
      WHERE rpr.template_version_id = template_versions.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM recipe_change_proposals rcp
      WHERE rcp.source_template_version_id = template_versions.id
    );
END;

CREATE TRIGGER run_plan_revisions_release_unreferenced_template
AFTER DELETE ON run_plan_revisions
BEGIN
  UPDATE template_versions
  SET locked_at = NULL,
      locked_by = NULL
  WHERE id = OLD.template_version_id
    AND archived_at IS NULL
    AND locked_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM runs r
      WHERE r.template_version_id = OLD.template_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_plan_revisions rpr
      WHERE rpr.template_version_id = OLD.template_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM recipe_change_proposals rcp
      WHERE rcp.source_template_version_id = OLD.template_version_id
    );
END;

CREATE TRIGGER recipe_change_proposals_release_unreferenced_template
AFTER DELETE ON recipe_change_proposals
BEGIN
  UPDATE template_versions
  SET locked_at = NULL,
      locked_by = NULL
  WHERE id = OLD.source_template_version_id
    AND archived_at IS NULL
    AND locked_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM runs r
      WHERE r.template_version_id = OLD.source_template_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_plan_revisions rpr
      WHERE rpr.template_version_id = OLD.source_template_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM recipe_change_proposals rcp
      WHERE rcp.source_template_version_id = OLD.source_template_version_id
    );
END;

CREATE TRIGGER runs_activate_sample_after_insert
AFTER INSERT ON runs
WHEN NEW.status = 'active' AND NEW.deleted_at IS NULL
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
AFTER UPDATE OF status, deleted_at ON runs
WHEN NEW.status = 'active' AND NEW.deleted_at IS NULL
  AND (OLD.status != 'active' OR OLD.deleted_at IS NOT NULL)
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
        (
          SELECT updated_by
          FROM run_steps
          WHERE run_id = NEW.id
          ORDER BY updated_at DESC, id DESC
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
          (
            SELECT updated_at
            FROM run_steps
            WHERE run_id = NEW.id
            ORDER BY updated_at DESC, id DESC
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
          (
            SELECT updated_at
            FROM run_steps
            WHERE run_id = NEW.id
            ORDER BY updated_at DESC, id DESC
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
WHEN OLD.status = 'active' AND NEW.status = 'complete' AND NEW.deleted_at IS NULL
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
      SELECT 1
      FROM runs active
      WHERE active.sample_id = NEW.sample_id
        AND active.status = 'active'
        AND active.deleted_at IS NULL
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
            AND pending.deleted_at IS NULL
            AND pending.status NOT IN ('done', 'skipped')
            AND pending.entry_kind = CASE
              WHEN runs.run_kind = 'metrology' THEN 'metrology'
              ELSE 'fabrication'
            END
        ) THEN 'complete'
        ELSE 'active'
      END ,
      completed_at = CASE
        WHEN NOT EXISTS (
          SELECT 1
          FROM run_steps pending
          WHERE pending.run_id = NEW.run_id
            AND pending.plan_status = 'current'
            AND pending.deleted_at IS NULL
            AND pending.status NOT IN ('done', 'skipped')
            AND pending.entry_kind = CASE
              WHEN runs.run_kind = 'metrology' THEN 'metrology'
              ELSE 'fabrication'
            END
        ) THEN NEW.updated_at
        ELSE NULL
      END
  WHERE id = NEW.run_id
    AND deleted_at IS NULL
    AND status NOT IN ('cancelled', 'superseded');
END;

CREATE TRIGGER runs_reject_archived_template
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id
    AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'template version unavailable');
END;

CREATE TRIGGER run_plan_revisions_reject_archived_template
BEFORE INSERT ON run_plan_revisions
WHEN EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id
    AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'template version unavailable');
END;

CREATE TRIGGER state_representation_assets_guard_blob_insert
BEFORE INSERT ON state_representation_assets
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER run_step_assets_guard_blob_insert
BEFORE INSERT ON run_step_assets
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER metrology_template_references_guard_blob_insert
BEFORE INSERT ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER state_verifications_guard_blob_insert
BEFORE INSERT ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.evidence_asset_id);
END;

CREATE TRIGGER comment_submission_items_guard_asset_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER comment_submission_items_guard_asset_update
BEFORE UPDATE OF asset_id ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER comment_submission_items_guard_managed_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.storage_object_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_gc_ledger bg
      ON bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id AND bg.state IN ('deleting', 'deleted')
  );
  UPDATE managed_storage_objects
  SET status = 'ready', orphaned_at = NULL
  WHERE id = NEW.storage_object_id AND status = 'orphaned';
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND (provider, object_key) = (
      SELECT provider, object_key FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;

CREATE TRIGGER comment_submission_items_guard_managed_update
BEFORE UPDATE OF storage_object_id ON comment_submission_items
WHEN NEW.storage_object_id IS NOT NULL
  AND (OLD.storage_object_id IS NULL OR OLD.storage_object_id <> NEW.storage_object_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_gc_ledger bg
      ON bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id AND bg.state IN ('deleting', 'deleted')
  );
  UPDATE managed_storage_objects
  SET status = 'ready', orphaned_at = NULL
  WHERE id = NEW.storage_object_id AND status = 'orphaned';
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND (provider, object_key) = (
      SELECT provider, object_key FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;

CREATE TRIGGER events_guard_asset_key_insert
BEFORE INSERT ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
    AND state = 'orphaned';
END;

CREATE TRIGGER events_guard_asset_key_update
BEFORE UPDATE OF asset_key ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
  AND (OLD.asset_key IS NULL OR OLD.asset_key <> NEW.asset_key)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
    AND state = 'orphaned';
END;

CREATE TRIGGER imports_guard_asset_keys_update
BEFORE UPDATE OF workbook_asset_key, manifest_asset_key ON imports
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key)
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key);
END;

CREATE TRIGGER imports_guard_asset_keys_insert
BEFORE INSERT ON imports
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key)
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key);
END;

CREATE TRIGGER template_versions_guard_source_asset_insert
BEFORE INSERT ON template_versions
WHEN NEW.source_asset_key IS NOT NULL AND NEW.source_asset_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = NEW.source_asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = NEW.source_asset_key AND state = 'orphaned';
END;

CREATE TRIGGER template_versions_guard_source_asset_update
BEFORE UPDATE OF source_asset_key ON template_versions
WHEN NEW.source_asset_key IS NOT NULL AND NEW.source_asset_key <> ''
  AND (OLD.source_asset_key IS NULL OR OLD.source_asset_key <> NEW.source_asset_key)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = NEW.source_asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = NEW.source_asset_key AND state = 'orphaned';
END;

CREATE TRIGGER samples_block_physical_delete
BEFORE DELETE ON samples BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for samples');
END;

CREATE TRIGGER runs_block_physical_delete
BEFORE DELETE ON runs BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for runs');
END;

CREATE TRIGGER run_steps_block_physical_delete
BEFORE DELETE ON run_steps BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for run_steps');
END;

CREATE TRIGGER comment_submissions_block_physical_delete
BEFORE DELETE ON comment_submissions BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for comment_submissions');
END;

CREATE TRIGGER comment_submission_items_block_physical_delete
BEFORE DELETE ON comment_submission_items BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for comment_submission_items');
END;

CREATE TRIGGER run_step_assets_block_physical_delete
BEFORE DELETE ON run_step_assets BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for run_step_assets');
END;

CREATE TRIGGER metrology_template_references_block_physical_delete
BEFORE DELETE ON metrology_template_references BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for metrology_template_references');
END;

CREATE TRIGGER template_versions_block_physical_delete
BEFORE DELETE ON template_versions BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for template_versions');
END;

CREATE TRIGGER events_guard_thumbnail_insert
BEFORE INSERT ON events
WHEN NULLIF(TRIM( CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END ), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
    AND state = 'orphaned';
END;

CREATE TRIGGER events_guard_thumbnail_update
BEFORE UPDATE OF metadata_json ON events
WHEN NULLIF(TRIM( CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END ), '') IS NOT NULL
  AND CASE WHEN json_valid(OLD.metadata_json)
        THEN json_extract(OLD.metadata_json, '$.thumbnailKey') END
      IS NOT CASE WHEN json_valid(NEW.metadata_json)
        THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
    AND state = 'orphaned';
END;

CREATE TRIGGER reference_targets_reject_identity_update
BEFORE UPDATE ON reference_targets
WHEN OLD.id IS NOT NEW.id
  OR OLD.registry_version IS NOT NEW.registry_version
  OR OLD.target_type IS NOT NEW.target_type
  OR OLD.target_id IS NOT NEW.target_id
  OR OLD.first_registered_at IS NOT NEW.first_registered_at
BEGIN
  SELECT RAISE(ABORT, 'reference target identity is immutable');
END;

CREATE TRIGGER reference_targets_reject_physical_delete
BEFORE DELETE ON reference_targets
BEGIN
  SELECT RAISE(ABORT, 'reference target physical deletion is disabled');
END;

CREATE TRIGGER projects_reject_identity_update
BEFORE UPDATE ON projects
WHEN OLD.id IS NOT NEW.id
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project identity is immutable');
END;

CREATE TRIGGER project_contents_reject_identity_update
BEFORE UPDATE ON project_contents
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.content_type IS NOT NEW.content_type
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project content identity is immutable');
END;

CREATE TRIGGER project_items_reject_identity_update
BEFORE UPDATE ON project_items
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.item_type IS NOT NEW.item_type
  OR OLD.project_content_id IS NOT NEW.project_content_id
  OR OLD.reference_target_id IS NOT NEW.reference_target_id
  OR OLD.created_sequence IS NOT NEW.created_sequence
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project item identity is immutable');
END;

CREATE TRIGGER project_map_placements_reject_identity_update
BEFORE UPDATE ON project_map_placements
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_item_id IS NOT NEW.project_item_id
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project placement identity is immutable');
END;

CREATE TRIGGER projects_require_revisioned_update
BEFORE UPDATE ON projects
WHEN OLD.revision IS NOT NEW.revision
  OR OLD.last_mutation_id IS NOT NEW.last_mutation_id
  OR OLD.title IS NOT NEW.title
  OR OLD.next_created_sequence IS NOT NEW.next_created_sequence
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project revision metadata requires a semantic update')
  WHERE NOT (
    OLD.title IS NOT NEW.title
    OR OLD.next_created_sequence IS NOT NEW.next_created_sequence
    OR OLD.deleted_at IS NOT NEW.deleted_at
    OR OLD.deleted_by IS NOT NEW.deleted_by
    OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
  );
  SELECT RAISE(ABORT, 'project update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
  SELECT RAISE(ABORT, 'project sequence cannot move backwards')
  WHERE NEW.next_created_sequence < OLD.next_created_sequence;
END;

CREATE TRIGGER project_contents_require_revisioned_update
BEFORE UPDATE ON project_contents
WHEN OLD.revision IS NOT NEW.revision
  OR OLD.last_mutation_id IS NOT NEW.last_mutation_id
  OR OLD.markdown_source IS NOT NEW.markdown_source
  OR OLD.attachment_caption IS NOT NEW.attachment_caption
  OR OLD.attachment_source_url IS NOT NEW.attachment_source_url
  OR OLD.format_version IS NOT NEW.format_version
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project content revision metadata requires a semantic update')
  WHERE NOT (
    OLD.markdown_source IS NOT NEW.markdown_source
    OR OLD.attachment_caption IS NOT NEW.attachment_caption
    OR OLD.attachment_source_url IS NOT NEW.attachment_source_url
    OR OLD.format_version IS NOT NEW.format_version
    OR OLD.deleted_at IS NOT NEW.deleted_at
    OR OLD.deleted_by IS NOT NEW.deleted_by
    OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
  );
  SELECT RAISE(ABORT, 'project content update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project content update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;

CREATE TRIGGER project_items_require_revisioned_update
BEFORE UPDATE ON project_items
WHEN OLD.revision IS NOT NEW.revision
  OR OLD.last_mutation_id IS NOT NEW.last_mutation_id
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project item revision metadata requires a semantic update')
  WHERE NOT (
    OLD.deleted_at IS NOT NEW.deleted_at
    OR OLD.deleted_by IS NOT NEW.deleted_by
    OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
  );
  SELECT RAISE(ABORT, 'project item update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project item update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;

CREATE TRIGGER project_map_placements_require_revisioned_update
BEFORE UPDATE ON project_map_placements
WHEN OLD.revision IS NOT NEW.revision
  OR OLD.last_mutation_id IS NOT NEW.last_mutation_id
  OR OLD.x IS NOT NEW.x
  OR OLD.y IS NOT NEW.y
  OR OLD.width IS NOT NEW.width
  OR OLD.height IS NOT NEW.height
  OR OLD.z_index IS NOT NEW.z_index
BEGIN
  SELECT RAISE(ABORT, 'project placement revision metadata requires a semantic update')
  WHERE NOT (
    OLD.x IS NOT NEW.x
    OR OLD.y IS NOT NEW.y
    OR OLD.width IS NOT NEW.width
    OR OLD.height IS NOT NEW.height
    OR OLD.z_index IS NOT NEW.z_index
  );
  SELECT RAISE(ABORT, 'project placement update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project placement update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;

CREATE TRIGGER project_contents_require_active_project
BEFORE INSERT ON project_contents
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project content requires an active project');
END;

CREATE TRIGGER project_content_attachments_validate_insert
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment requires active attachment content')
  WHERE NOT EXISTS (
    SELECT 1 FROM project_contents pc
    JOIN projects p ON p.id = pc.project_id
    WHERE pc.id = NEW.project_content_id
      AND pc.content_type = 'attachment'
      AND pc.deleted_at IS NULL
      AND p.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'project attachment asset is not ready')
  WHERE NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.asset_id AND a.status = 'ready'
  );
  SELECT RAISE(ABORT, 'project attachment managed object is not ready')
  WHERE NEW.storage_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM managed_storage_objects mso
    WHERE mso.id = NEW.storage_object_id AND mso.status IN ('ready', 'orphaned')
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_gc_ledger bg
      ON bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id AND bg.state IN ('deleting', 'deleted')
  );
  UPDATE managed_storage_objects
  SET status = 'ready', orphaned_at = NULL
  WHERE id = NEW.storage_object_id AND status = 'orphaned';
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND (provider, object_key) = (
      SELECT provider, object_key FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;

CREATE TRIGGER project_items_validate_insert
BEFORE INSERT ON project_items
BEGIN
  SELECT RAISE(ABORT, 'project item requires an active project')
  WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'project content belongs to another project or is unavailable')
  WHERE NEW.item_type = 'content' AND NOT EXISTS (
    SELECT 1 FROM project_contents pc
    WHERE pc.id = NEW.project_content_id
      AND pc.project_id = NEW.project_id
      AND pc.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'reference target is unavailable')
  WHERE NEW.item_type = 'reference' AND NOT EXISTS (
    SELECT 1 FROM reference_targets rt
    WHERE rt.id = NEW.reference_target_id AND rt.tombstoned_at IS NULL
  );
END;

CREATE TRIGGER project_map_placements_validate_insert
BEFORE INSERT ON project_map_placements
WHEN NOT EXISTS (
  SELECT 1 FROM project_items pi
  JOIN projects p ON p.id = pi.project_id
  WHERE pi.id = NEW.project_item_id
    AND pi.deleted_at IS NULL
    AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project placement requires an active item');
END;

CREATE TRIGGER project_map_placements_validate_update
BEFORE UPDATE ON project_map_placements
WHEN NOT EXISTS (
  SELECT 1 FROM project_items pi
  JOIN projects p ON p.id = pi.project_id
  WHERE pi.id = NEW.project_item_id
    AND pi.deleted_at IS NULL
    AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project placement requires an active item');
END;

CREATE TRIGGER project_edges_validate_insert
BEFORE INSERT ON project_edges
BEGIN
  SELECT RAISE(ABORT, 'project edge requires an active project')
  WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'project edge endpoints must be active items in the same project')
  WHERE NOT EXISTS (
    SELECT 1
    FROM project_items source
    JOIN project_items target
      ON target.id = NEW.target_item_id
    WHERE source.id = NEW.source_item_id
      AND source.project_id = NEW.project_id
      AND target.project_id = NEW.project_id
      AND source.deleted_at IS NULL
      AND target.deleted_at IS NULL
  );
END;

CREATE TRIGGER project_edges_validate_update
BEFORE UPDATE ON project_edges
WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN project_items source ON source.id = NEW.source_item_id
  JOIN project_items target ON target.id = NEW.target_item_id
  WHERE p.id = NEW.project_id
    AND p.deleted_at IS NULL
    AND source.project_id = NEW.project_id
    AND target.project_id = NEW.project_id
    AND source.deleted_at IS NULL
    AND target.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project edge endpoints must remain active items in the same project');
END;

CREATE TRIGGER projects_reject_physical_delete
BEFORE DELETE ON projects
BEGIN
  SELECT RAISE(ABORT, 'project physical deletion is disabled');
END;

CREATE TRIGGER project_contents_reject_physical_delete
BEFORE DELETE ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project content physical deletion is disabled');
END;

CREATE TRIGGER project_content_attachments_reject_physical_delete
BEFORE DELETE ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment physical deletion is disabled');
END;

CREATE TRIGGER project_items_reject_physical_delete
BEFORE DELETE ON project_items
BEGIN
  SELECT RAISE(ABORT, 'project item physical deletion is disabled');
END;

CREATE TRIGGER project_map_placements_reject_physical_delete
BEFORE DELETE ON project_map_placements
BEGIN
  SELECT RAISE(ABORT, 'project placement physical deletion is disabled');
END;

CREATE TRIGGER project_edges_reject_physical_delete
BEFORE DELETE ON project_edges
BEGIN
  SELECT RAISE(ABORT, 'project edge physical deletion is disabled');
END;

CREATE TRIGGER projects_require_api_safe_identifiers_insert
BEFORE INSERT ON projects
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER projects_require_api_safe_identifiers_update
BEFORE UPDATE ON projects
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_api_safe_identifiers_insert
BEFORE INSERT ON project_contents
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project content identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_api_safe_identifiers_update
BEFORE UPDATE ON project_contents
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project content identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_content_attachments_require_api_safe_identifiers_insert
BEFORE INSERT ON project_content_attachments
WHEN length(NEW.project_content_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_content_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_content_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.creation_operation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.creation_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.creation_operation_id GLOB '*[^A-Za-z0-9._~-]*'
BEGIN
  SELECT RAISE(ABORT, 'project attachment identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_items_require_api_safe_identifiers_insert
BEFORE INSERT ON project_items
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.project_content_id IS NOT NULL
    AND (
      length(NEW.project_content_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.project_content_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.project_content_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project item identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_items_require_api_safe_identifiers_update
BEFORE UPDATE ON project_items
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.project_content_id IS NOT NULL
    AND (
      length(NEW.project_content_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.project_content_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.project_content_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project item identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_map_placements_require_api_safe_identifiers_insert
BEFORE INSERT ON project_map_placements
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
BEGIN
  SELECT RAISE(ABORT, 'project placement identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_map_placements_require_api_safe_identifiers_update
BEFORE UPDATE ON project_map_placements
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
BEGIN
  SELECT RAISE(ABORT, 'project placement identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_api_safe_identifiers_insert
BEFORE INSERT ON project_edges
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.source_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.source_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.source_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.target_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.target_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.target_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_api_safe_identifiers_update
BEFORE UPDATE ON project_edges
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.source_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.source_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.source_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.target_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.target_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.target_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_bounded_payload_insert
BEFORE INSERT ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project Markdown exceeds maximum length')
  WHERE NEW.markdown_source IS NOT NULL AND length(NEW.markdown_source) > 200000;
  SELECT RAISE(ABORT, 'project attachment source URL must use http or https')
  WHERE NEW.attachment_source_url IS NOT NULL
    AND (
      NEW.attachment_source_url <> trim(NEW.attachment_source_url)
      OR NOT (
        lower(NEW.attachment_source_url) GLOB 'http://?*'
        OR lower(NEW.attachment_source_url) GLOB 'https://?*'
      )
    );
END;

CREATE TRIGGER project_contents_require_bounded_payload_update
BEFORE UPDATE ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project Markdown exceeds maximum length')
  WHERE NEW.markdown_source IS NOT NULL AND length(NEW.markdown_source) > 200000;
  SELECT RAISE(ABORT, 'project attachment source URL must use http or https')
  WHERE NEW.attachment_source_url IS NOT NULL
    AND (
      NEW.attachment_source_url <> trim(NEW.attachment_source_url)
      OR NOT (
        lower(NEW.attachment_source_url) GLOB 'http://?*'
        OR lower(NEW.attachment_source_url) GLOB 'https://?*'
      )
    );
END;

CREATE TRIGGER project_contents_require_active_project_update
BEFORE UPDATE ON project_contents
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project content update requires an active project');
END;

CREATE TRIGGER project_items_require_active_project_update
BEFORE UPDATE ON project_items
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project item update requires an active project');
END;

CREATE TRIGGER project_contents_require_owner_delete_capacity
BEFORE UPDATE OF deleted_at ON project_contents
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM project_items pi
    WHERE pi.project_content_id = OLD.id
      AND pi.project_id = OLD.project_id
      AND pi.deleted_at IS NULL
      AND pi.revision >= 9007199254740991
  )
BEGIN
  SELECT RAISE(ABORT, 'project content deletion requires owner lifecycle capacity');
END;

CREATE TRIGGER project_contents_require_owner_restore_capacity
BEFORE UPDATE OF deleted_at ON project_contents
WHEN OLD.deleted_at IS NOT NULL
  AND NEW.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM project_items pi
    WHERE pi.project_content_id = OLD.id
      AND pi.project_id = OLD.project_id
      AND pi.deleted_at IS NOT NULL
      AND pi.revision >= 9007199254740991
  )
BEGIN
  SELECT RAISE(ABORT, 'project content restore requires owner lifecycle capacity');
END;

CREATE TRIGGER project_items_require_deleted_edges
BEFORE UPDATE OF deleted_at ON project_items
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM project_edges pe
    WHERE pe.project_id = OLD.project_id
      AND pe.deleted_at IS NULL
      AND (pe.source_item_id = OLD.id OR pe.target_item_id = OLD.id)
  )
BEGIN
  SELECT RAISE(ABORT, 'project item deletion requires connected edges to be deleted');
END;

CREATE TRIGGER project_items_require_deleted_owned_content
BEFORE UPDATE OF deleted_at, deletion_operation_id ON project_items
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND OLD.project_content_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM project_contents pc
    WHERE pc.id = OLD.project_content_id
      AND pc.project_id = OLD.project_id
      AND pc.deleted_at IS NOT NULL
      AND pc.deletion_operation_id = NEW.deletion_operation_id
      AND pc.last_mutation_id = NEW.last_mutation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'project item deletion requires owned content deletion');
END;

CREATE TRIGGER project_items_require_restored_owned_content
BEFORE UPDATE OF deleted_at ON project_items
WHEN OLD.deleted_at IS NOT NULL
  AND NEW.deleted_at IS NULL
  AND OLD.project_content_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM project_contents pc
    WHERE pc.id = OLD.project_content_id
      AND pc.project_id = OLD.project_id
      AND pc.deleted_at IS NULL
      AND pc.last_mutation_id = NEW.last_mutation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'project item restore requires owned content restore');
END;

CREATE TRIGGER project_items_require_available_reference_restore
BEFORE UPDATE OF deleted_at ON project_items
WHEN OLD.deleted_at IS NOT NULL
  AND NEW.deleted_at IS NULL
  AND OLD.item_type = 'reference'
  AND NOT EXISTS (
    SELECT 1 FROM reference_targets rt
    WHERE rt.id = OLD.reference_target_id AND rt.tombstoned_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'project reference restore requires an available target');
END;

CREATE TRIGGER projects_require_identifier_bytes_insert
BEFORE INSERT ON projects
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER projects_require_identifier_bytes_update
BEFORE UPDATE ON projects
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_identifier_bytes_insert
BEFORE INSERT ON project_contents
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project content identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_identifier_bytes_update
BEFORE UPDATE ON project_contents
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project content identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_content_attachments_require_identifier_bytes_insert
BEFORE INSERT ON project_content_attachments
WHEN NEW.project_content_id IS NULL
  OR typeof(NEW.project_content_id) <> 'text'
  OR length(CAST(NEW.project_content_id AS BLOB)) <> length(NEW.project_content_id)
  OR typeof(NEW.creation_operation_id) <> 'text'
  OR length(CAST(NEW.creation_operation_id AS BLOB)) <> length(NEW.creation_operation_id)
BEGIN
  SELECT RAISE(ABORT, 'project attachment identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_items_require_identifier_bytes_insert
BEFORE INSERT ON project_items
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR (
    NEW.project_content_id IS NOT NULL
    AND (
      typeof(NEW.project_content_id) <> 'text'
      OR length(CAST(NEW.project_content_id AS BLOB)) <> length(NEW.project_content_id)
    )
  )
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project item identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_items_require_identifier_bytes_update
BEFORE UPDATE ON project_items
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR (
    NEW.project_content_id IS NOT NULL
    AND (
      typeof(NEW.project_content_id) <> 'text'
      OR length(CAST(NEW.project_content_id AS BLOB)) <> length(NEW.project_content_id)
    )
  )
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project item identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_map_placements_require_identifier_bytes_insert
BEFORE INSERT ON project_map_placements
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_item_id) <> 'text'
  OR length(CAST(NEW.project_item_id AS BLOB)) <> length(NEW.project_item_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
BEGIN
  SELECT RAISE(ABORT, 'project placement identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_map_placements_require_identifier_bytes_update
BEFORE UPDATE ON project_map_placements
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_item_id) <> 'text'
  OR length(CAST(NEW.project_item_id AS BLOB)) <> length(NEW.project_item_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
BEGIN
  SELECT RAISE(ABORT, 'project placement identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_identifier_bytes_insert
BEFORE INSERT ON project_edges
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR typeof(NEW.source_item_id) <> 'text'
  OR length(CAST(NEW.source_item_id AS BLOB)) <> length(NEW.source_item_id)
  OR typeof(NEW.target_item_id) <> 'text'
  OR length(CAST(NEW.target_item_id AS BLOB)) <> length(NEW.target_item_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_identifier_bytes_update
BEFORE UPDATE ON project_edges
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR typeof(NEW.source_item_id) <> 'text'
  OR length(CAST(NEW.source_item_id AS BLOB)) <> length(NEW.source_item_id)
  OR typeof(NEW.target_item_id) <> 'text'
  OR length(CAST(NEW.target_item_id AS BLOB)) <> length(NEW.target_item_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_payload_text_insert
BEFORE INSERT ON project_edges
BEGIN
  SELECT RAISE(ABORT, 'project edge label must be text')
  WHERE NEW.label IS NOT NULL AND typeof(NEW.label) <> 'text';
  SELECT RAISE(ABORT, 'project edge label must not contain NUL')
  WHERE NEW.label IS NOT NULL AND instr(NEW.label, char(0)) > 0;
  SELECT RAISE(ABORT, 'project edge label exceeds maximum length')
  WHERE NEW.label IS NOT NULL AND length(NEW.label) > 200;
END;

CREATE TRIGGER project_edges_require_payload_text_update
BEFORE UPDATE ON project_edges
BEGIN
  SELECT RAISE(ABORT, 'project edge label must be text')
  WHERE NEW.label IS NOT NULL AND typeof(NEW.label) <> 'text';
  SELECT RAISE(ABORT, 'project edge label must not contain NUL')
  WHERE NEW.label IS NOT NULL AND instr(NEW.label, char(0)) > 0;
  SELECT RAISE(ABORT, 'project edge label exceeds maximum length')
  WHERE NEW.label IS NOT NULL AND length(NEW.label) > 200;
END;

CREATE TRIGGER project_items_require_external_identifier_insert
BEFORE INSERT ON project_items
WHEN NEW.reference_target_id IS NOT NULL
  AND (
    typeof(NEW.reference_target_id) <> 'text'
    OR length(NEW.reference_target_id) NOT BETWEEN 1 AND 256
    OR length(CAST(NEW.reference_target_id AS BLOB)) <> length(NEW.reference_target_id)
    OR substr(NEW.reference_target_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
    OR NEW.reference_target_id GLOB '*[^A-Za-z0-9._~-]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'project reference target identity must be API-safe');
END;

CREATE TRIGGER project_items_require_external_identifier_update
BEFORE UPDATE ON project_items
WHEN NEW.reference_target_id IS NOT NULL
  AND (
    typeof(NEW.reference_target_id) <> 'text'
    OR length(NEW.reference_target_id) NOT BETWEEN 1 AND 256
    OR length(CAST(NEW.reference_target_id AS BLOB)) <> length(NEW.reference_target_id)
    OR substr(NEW.reference_target_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
    OR NEW.reference_target_id GLOB '*[^A-Za-z0-9._~-]*'
  )
BEGIN
  SELECT RAISE(ABORT, 'project reference target identity must be API-safe');
END;

CREATE TRIGGER project_content_attachments_require_external_identifier_insert
BEFORE INSERT ON project_content_attachments
WHEN (
    NEW.asset_id IS NOT NULL
    AND (
      typeof(NEW.asset_id) <> 'text'
      OR length(NEW.asset_id) NOT BETWEEN 1 AND 256
      OR length(CAST(NEW.asset_id AS BLOB)) <> length(NEW.asset_id)
      OR substr(NEW.asset_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.asset_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
  OR (
    NEW.storage_object_id IS NOT NULL
    AND (
      typeof(NEW.storage_object_id) <> 'text'
      OR length(NEW.storage_object_id) NOT BETWEEN 1 AND 256
      OR length(CAST(NEW.storage_object_id AS BLOB)) <> length(NEW.storage_object_id)
      OR substr(NEW.storage_object_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.storage_object_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project attachment locator identity must be API-safe');
END;

CREATE TRIGGER projects_require_payload_text_insert
BEFORE INSERT ON projects
BEGIN
  SELECT RAISE(ABORT, 'project title must be text')
  WHERE typeof(NEW.title) <> 'text';
  SELECT RAISE(ABORT, 'project title must not contain NUL')
  WHERE instr(NEW.title, char(0)) > 0;
  SELECT RAISE(ABORT, 'project title must be trimmed and between 1 and 200 characters')
  WHERE NEW.title <> trim(
      NEW.title,
      char(
        9, 10, 11, 12, 13, 32, 160, 5760,
        8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
        8232, 8233, 8239, 8287, 12288, 65279
      )
    )
    OR length(NEW.title) NOT BETWEEN 1 AND 200;
END;

CREATE TRIGGER projects_require_payload_text_update
BEFORE UPDATE ON projects
BEGIN
  SELECT RAISE(ABORT, 'project title must be text')
  WHERE typeof(NEW.title) <> 'text';
  SELECT RAISE(ABORT, 'project title must not contain NUL')
  WHERE instr(NEW.title, char(0)) > 0;
  SELECT RAISE(ABORT, 'project title must be trimmed and between 1 and 200 characters')
  WHERE NEW.title <> trim(
      NEW.title,
      char(
        9, 10, 11, 12, 13, 32, 160, 5760,
        8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
        8232, 8233, 8239, 8287, 12288, 65279
      )
    )
    OR length(NEW.title) NOT BETWEEN 1 AND 200;
END;

CREATE TRIGGER project_contents_require_payload_text_insert
BEFORE INSERT ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project Markdown must be text')
  WHERE NEW.markdown_source IS NOT NULL
    AND typeof(NEW.markdown_source) <> 'text';
  SELECT RAISE(ABORT, 'project Markdown must not contain NUL')
  WHERE NEW.markdown_source IS NOT NULL
    AND instr(NEW.markdown_source, char(0)) > 0;
  SELECT RAISE(ABORT, 'project Markdown exceeds maximum length')
  WHERE NEW.markdown_source IS NOT NULL
    AND length(NEW.markdown_source) > 200000;

  SELECT RAISE(ABORT, 'project attachment caption must be text')
  WHERE NEW.attachment_caption IS NOT NULL
    AND typeof(NEW.attachment_caption) <> 'text';
  SELECT RAISE(ABORT, 'project attachment caption must not contain NUL')
  WHERE NEW.attachment_caption IS NOT NULL
    AND instr(NEW.attachment_caption, char(0)) > 0;
  SELECT RAISE(ABORT, 'project attachment caption exceeds maximum length')
  WHERE NEW.attachment_caption IS NOT NULL
    AND length(NEW.attachment_caption) > 2000;

  SELECT RAISE(ABORT, 'project attachment source URL must use http or https')
  WHERE NEW.attachment_source_url IS NOT NULL
    AND (
      typeof(NEW.attachment_source_url) <> 'text'
      OR instr(NEW.attachment_source_url, char(0)) > 0
      OR NEW.attachment_source_url <> trim(
        NEW.attachment_source_url,
        char(
          9, 10, 11, 12, 13, 32, 160, 5760,
          8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
          8232, 8233, 8239, 8287, 12288, 65279
        )
      )
      OR length(NEW.attachment_source_url) NOT BETWEEN 1 AND 2048
      OR NOT (
        lower(NEW.attachment_source_url) GLOB 'http://?*'
        OR lower(NEW.attachment_source_url) GLOB 'https://?*'
      )
    );
END;

CREATE TRIGGER project_contents_require_payload_text_update
BEFORE UPDATE ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project Markdown must be text')
  WHERE NEW.markdown_source IS NOT NULL
    AND typeof(NEW.markdown_source) <> 'text';
  SELECT RAISE(ABORT, 'project Markdown must not contain NUL')
  WHERE NEW.markdown_source IS NOT NULL
    AND instr(NEW.markdown_source, char(0)) > 0;
  SELECT RAISE(ABORT, 'project Markdown exceeds maximum length')
  WHERE NEW.markdown_source IS NOT NULL
    AND length(NEW.markdown_source) > 200000;

  SELECT RAISE(ABORT, 'project attachment caption must be text')
  WHERE NEW.attachment_caption IS NOT NULL
    AND typeof(NEW.attachment_caption) <> 'text';
  SELECT RAISE(ABORT, 'project attachment caption must not contain NUL')
  WHERE NEW.attachment_caption IS NOT NULL
    AND instr(NEW.attachment_caption, char(0)) > 0;
  SELECT RAISE(ABORT, 'project attachment caption exceeds maximum length')
  WHERE NEW.attachment_caption IS NOT NULL
    AND length(NEW.attachment_caption) > 2000;

  SELECT RAISE(ABORT, 'project attachment source URL must use http or https')
  WHERE NEW.attachment_source_url IS NOT NULL
    AND (
      typeof(NEW.attachment_source_url) <> 'text'
      OR instr(NEW.attachment_source_url, char(0)) > 0
      OR NEW.attachment_source_url <> trim(
        NEW.attachment_source_url,
        char(
          9, 10, 11, 12, 13, 32, 160, 5760,
          8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
          8232, 8233, 8239, 8287, 12288, 65279
        )
      )
      OR length(NEW.attachment_source_url) NOT BETWEEN 1 AND 2048
      OR NOT (
        lower(NEW.attachment_source_url) GLOB 'http://?*'
        OR lower(NEW.attachment_source_url) GLOB 'https://?*'
      )
    );
END;

CREATE TRIGGER imports_require_finalization_identity
BEFORE UPDATE OF status ON imports
WHEN OLD.status = 'pending' AND NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'import finalization identity is required')
  WHERE NEW.operation_id IS NULL OR NEW.finalization_id IS NULL
    OR NEW.completed_at IS NULL OR OLD.lease_expires_at IS NULL
    OR OLD.lease_expires_at <= NEW.completed_at;
END;

CREATE TRIGGER imports_activate_pending_assets
AFTER UPDATE OF status ON imports
WHEN OLD.status = 'pending' AND NEW.status = 'ready'
BEGIN
  UPDATE assets
  SET status = 'ready'
  WHERE import_id = NEW.id AND status = 'pending';
END;

CREATE TRIGGER managed_storage_objects_reject_live_content_duplicate_insert
BEFORE INSERT ON managed_storage_objects
WHEN NEW.status = 'ready' AND EXISTS (
  SELECT 1 FROM managed_storage_objects mso
  WHERE mso.provider = NEW.provider
    AND mso.sha256 = NEW.sha256
    AND mso.byte_size = NEW.byte_size
    AND mso.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
        AND bg.state IN ('deleting', 'deleted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_integrity_quarantine biq
      WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live managed storage content already registered');
END;

CREATE TRIGGER managed_storage_objects_reject_live_content_duplicate_update
BEFORE UPDATE OF provider, sha256, byte_size, status, object_key ON managed_storage_objects
WHEN NEW.status = 'ready' AND EXISTS (
  SELECT 1 FROM managed_storage_objects mso
  WHERE mso.id <> NEW.id
    AND mso.provider = NEW.provider
    AND mso.sha256 = NEW.sha256
    AND mso.byte_size = NEW.byte_size
    AND mso.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
        AND bg.state IN ('deleting', 'deleted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_integrity_quarantine biq
      WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live managed storage content already registered');
END;

CREATE TRIGGER state_representation_assets_guard_integrity_insert
BEFORE INSERT ON state_representation_assets
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_assets_guard_integrity_insert
BEFORE INSERT ON run_step_assets
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER metrology_template_references_guard_integrity_insert
BEFORE INSERT ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER state_verifications_guard_integrity_insert
BEFORE INSERT ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id
  );
END;

CREATE TRIGGER comment_submission_items_guard_asset_integrity_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER comment_submission_items_guard_asset_integrity_update
BEFORE UPDATE OF asset_id ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER comment_submission_items_guard_managed_integrity_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.storage_object_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
END;

CREATE TRIGGER comment_submission_items_guard_managed_integrity_update
BEFORE UPDATE OF storage_object_id ON comment_submission_items
WHEN NEW.storage_object_id IS NOT NULL
  AND (OLD.storage_object_id IS NULL OR OLD.storage_object_id <> NEW.storage_object_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
END;

CREATE TRIGGER project_content_attachments_guard_integrity_insert
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE NEW.asset_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE NEW.storage_object_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE NEW.asset_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id
      AND (
        a.status <> 'ready'
        OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
      )
  );
END;

CREATE TRIGGER events_guard_asset_key_integrity_insert
BEFORE INSERT ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
  );
END;

CREATE TRIGGER events_guard_asset_key_integrity_update
BEFORE UPDATE OF asset_key ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
  AND (OLD.asset_key IS NULL OR OLD.asset_key <> NEW.asset_key)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
  );
END;

CREATE TRIGGER events_guard_thumbnail_integrity_insert
BEFORE INSERT ON events
WHEN NULLIF(TRIM( CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END ), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
  );
END;

CREATE TRIGGER events_guard_thumbnail_integrity_update
BEFORE UPDATE OF metadata_json ON events
WHEN NULLIF(TRIM( CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END ), '') IS NOT NULL
  AND CASE WHEN json_valid(OLD.metadata_json)
        THEN json_extract(OLD.metadata_json, '$.thumbnailKey') END
      IS NOT CASE WHEN json_valid(NEW.metadata_json)
        THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
  );
END;

CREATE TRIGGER imports_guard_asset_keys_integrity_insert
BEFORE INSERT ON imports
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key)
  );
END;

CREATE TRIGGER imports_guard_asset_keys_integrity_update
BEFORE UPDATE OF workbook_asset_key, manifest_asset_key ON imports
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key)
  );
END;

CREATE TRIGGER template_versions_guard_source_asset_integrity_insert
BEFORE INSERT ON template_versions
WHEN NEW.source_asset_key IS NOT NULL AND NEW.source_asset_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.source_asset_key
  );
END;

CREATE TRIGGER template_versions_guard_source_asset_integrity_update
BEFORE UPDATE OF source_asset_key ON template_versions
WHEN NEW.source_asset_key IS NOT NULL AND NEW.source_asset_key <> ''
  AND (OLD.source_asset_key IS NULL OR OLD.source_asset_key <> NEW.source_asset_key)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.source_asset_key
  );
END;

CREATE TRIGGER metrology_template_references_guard_integrity_update
BEFORE UPDATE OF asset_id ON metrology_template_references
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER state_representation_assets_guard_integrity_update
BEFORE UPDATE OF asset_id ON state_representation_assets
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_assets_guard_integrity_update
BEFORE UPDATE OF asset_id ON run_step_assets
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER state_verifications_guard_integrity_update
BEFORE UPDATE OF evidence_asset_id ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
  AND (OLD.evidence_asset_id IS NULL OR OLD.evidence_asset_id <> NEW.evidence_asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id
  );
END;

CREATE TRIGGER project_content_attachments_guard_asset_integrity_update
BEFORE UPDATE OF asset_id ON project_content_attachments
WHEN NEW.asset_id IS NOT NULL
  AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id
      AND (
        a.status <> 'ready'
        OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
      )
  );
END;

CREATE TRIGGER project_content_attachments_guard_managed_integrity_update
BEFORE UPDATE OF storage_object_id ON project_content_attachments
WHEN NEW.storage_object_id IS NOT NULL
  AND (OLD.storage_object_id IS NULL OR OLD.storage_object_id <> NEW.storage_object_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
END;

CREATE TRIGGER template_steps_guard_unpublished_update
BEFORE UPDATE ON template_steps
WHEN EXISTS (
  SELECT 1
  FROM template_versions tv
  JOIN imports i ON i.template_version_id = tv.id
  WHERE tv.id = OLD.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER runs_guard_unpublished_template_insert
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER runs_guard_unpublished_template_update
BEFORE UPDATE OF template_version_id ON runs
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_plan_revisions_guard_unpublished_template_insert
BEFORE INSERT ON run_plan_revisions
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_plan_revisions_guard_unpublished_template_update
BEFORE UPDATE OF template_version_id ON run_plan_revisions
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_steps_guard_unpublished_template_step_insert
BEFORE INSERT ON run_steps
WHEN NEW.template_step_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM template_steps ts
  JOIN imports i ON i.template_version_id = ts.template_version_id
  WHERE ts.id = NEW.template_step_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_steps_guard_unpublished_template_step_update
BEFORE UPDATE OF template_step_id ON run_steps
WHEN NEW.template_step_id IS NOT NULL
  AND NEW.template_step_id IS NOT OLD.template_step_id
  AND EXISTS (
    SELECT 1
    FROM template_steps ts
    JOIN imports i ON i.template_version_id = ts.template_version_id
    WHERE ts.id = NEW.template_step_id AND i.status <> 'ready'
  )
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_step_plan_links_guard_unpublished_template_step_insert
BEFORE INSERT ON run_step_plan_links
WHEN EXISTS (
  SELECT 1
  FROM template_steps ts
  JOIN imports i ON i.template_version_id = ts.template_version_id
  WHERE ts.id = NEW.template_step_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_step_plan_links_guard_unpublished_template_step_update
BEFORE UPDATE OF template_step_id ON run_step_plan_links
WHEN NEW.template_step_id IS NOT OLD.template_step_id AND EXISTS (
  SELECT 1
  FROM template_steps ts
  JOIN imports i ON i.template_version_id = ts.template_version_id
  WHERE ts.id = NEW.template_step_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER recipe_change_proposals_guard_unpublished_template_insert
BEFORE INSERT ON recipe_change_proposals
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.source_template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER recipe_change_proposals_guard_unpublished_template_update
BEFORE UPDATE OF source_template_version_id ON recipe_change_proposals
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.source_template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER reference_targets_guard_unpublished_recipe_insert
BEFORE INSERT ON reference_targets
WHEN NEW.target_type = 'recipe_revision' AND EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.target_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER events_guard_asset_publication_insert
BEFORE INSERT ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> '' AND EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.r2_key = NEW.asset_key AND (
    a.status <> 'ready'
    OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER events_guard_asset_publication_update
BEFORE UPDATE OF asset_key ON events
WHEN NEW.asset_key IS NOT OLD.asset_key
  AND NEW.asset_key IS NOT NULL AND NEW.asset_key <> '' AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.r2_key = NEW.asset_key AND (
      a.status <> 'ready'
      OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER events_guard_thumbnail_publication_insert
BEFORE INSERT ON events
WHEN json_valid(NEW.metadata_json)
  AND typeof(json_extract(NEW.metadata_json, '$.thumbnailKey')) = 'text'
  AND NULLIF(TRIM(CAST(json_extract(NEW.metadata_json, '$.thumbnailKey') AS TEXT)), '') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.r2_key = CAST(json_extract(NEW.metadata_json, '$.thumbnailKey') AS TEXT)
      AND (
        a.status <> 'ready'
        OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER events_guard_thumbnail_publication_update
BEFORE UPDATE OF metadata_json ON events
WHEN CAST( CASE WHEN json_valid(NEW.metadata_json)
               THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END AS TEXT)
     IS NOT
     CAST( CASE WHEN json_valid(OLD.metadata_json)
               THEN json_extract(OLD.metadata_json, '$.thumbnailKey') END AS TEXT)
  AND json_valid(NEW.metadata_json)
  AND typeof(json_extract(NEW.metadata_json, '$.thumbnailKey')) = 'text'
  AND NULLIF(TRIM(CAST(json_extract(NEW.metadata_json, '$.thumbnailKey') AS TEXT)), '') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.r2_key = CAST(json_extract(NEW.metadata_json, '$.thumbnailKey') AS TEXT)
      AND (
        a.status <> 'ready'
        OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER state_representation_assets_guard_publication_insert
BEFORE INSERT ON state_representation_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER state_representation_assets_guard_publication_update
BEFORE UPDATE OF asset_id ON state_representation_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER run_step_assets_guard_publication_insert
BEFORE INSERT ON run_step_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER run_step_assets_guard_publication_update
BEFORE UPDATE OF asset_id ON run_step_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER state_verifications_guard_publication_insert
BEFORE INSERT ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.evidence_asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER state_verifications_guard_publication_update
BEFORE UPDATE OF evidence_asset_id ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.evidence_asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER comment_submission_items_guard_asset_publication_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER comment_submission_items_guard_asset_publication_update
BEFORE UPDATE OF asset_id ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER metrology_template_references_guard_publication_insert
BEFORE INSERT ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'template version is not published') WHERE EXISTS (
    SELECT 1 FROM imports i
    WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
  );
  SELECT RAISE(ABORT, 'asset owning import is not ready') WHERE NOT EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id AND a.status = 'ready'
      AND (a.import_id IS NULL OR i.status = 'ready')
  );
END;

CREATE TRIGGER imports_guard_template_identity_staging
BEFORE UPDATE OF template_version_id ON imports
WHEN NEW.template_version_id IS NOT OLD.template_version_id
BEGIN
  SELECT RAISE(
    ABORT,
    'import template identity can only be staged once while pending'
  )
  WHERE NOT (
    OLD.status = 'pending'
    AND NEW.status = 'pending'
    AND OLD.template_version_id IS NULL
    AND NEW.template_version_id IS NOT NULL
    AND OLD.finalization_id IS NULL
    AND NEW.finalization_id IS NULL
    AND OLD.recovery_operation_id IS NULL
    AND NEW.recovery_operation_id IS NULL
  );
END;

CREATE TRIGGER imports_require_publishable_assets
BEFORE UPDATE OF status ON imports
WHEN OLD.status = 'pending' AND NEW.status = 'ready'
BEGIN
  -- Finalization is a state transition over the already-staged graph. A single
  -- UPDATE may not validate OLD dependencies while publishing a different NEW
  -- template root.
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE OLD.template_version_id IS NULL
    OR NEW.template_version_id IS NOT OLD.template_version_id;

  -- Publication must resolve the staged template identity before validating
  -- any asset edge. imports.template_version_id is intentionally nullable and
  -- has no foreign key in the legacy schema.
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.template_version_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM template_versions tv
      WHERE tv.id = NEW.template_version_id
    );

  -- The final UPDATE supplies workbook/manifest keys through NEW, so validate
  -- them explicitly; a view over imports still observes the OLD pending row.
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.workbook_asset_key IS NULL
    OR NULLIF(TRIM(NEW.workbook_asset_key), '') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM assets a
      WHERE a.r2_key = NEW.workbook_asset_key
        AND a.sha256 IS NOT NULL
        AND (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );

  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.manifest_asset_key IS NULL
    OR NULLIF(TRIM(NEW.manifest_asset_key), '') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM assets a
      WHERE a.r2_key = NEW.manifest_asset_key
        AND a.sha256 IS NOT NULL
        AND (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );

  -- Every dependency of the staged template must either be a healthy pending
  -- asset owned by this exact import or an already-published healthy asset.
  -- In particular, a standalone failed/quarantined asset retained by a Sample
  -- or Run can preserve bytes/history but cannot make this import publishable.
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE EXISTS (
    SELECT 1
    FROM fabublox_import_asset_dependencies dependency
    LEFT JOIN assets a ON a.id = dependency.asset_id
    WHERE dependency.import_id = NEW.id
      AND (
        a.id IS NULL
        OR a.sha256 IS NULL
        OR NOT (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
        OR EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        OR EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
      )
  );
END;

CREATE TRIGGER assets_reject_live_sha_duplicate
BEFORE INSERT ON assets
WHEN NEW.sha256 IS NOT NULL AND (
  (
    NEW.import_id IS NULL AND NEW.status = 'ready'
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.sha256 = NEW.sha256 AND a.status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  ) OR (
    NEW.import_id IS NOT NULL AND NEW.status IN ('pending', 'ready')
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.sha256 = NEW.sha256 AND a.status IN ('pending', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER assets_reject_live_sha_duplicate_update
BEFORE UPDATE OF sha256, status, r2_key, import_id ON assets
WHEN NEW.sha256 IS NOT NULL AND (
  (
    NEW.import_id IS NULL AND NEW.status = 'ready'
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.id <> OLD.id AND a.sha256 = NEW.sha256
        AND a.status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  ) OR (
    NEW.import_id IS NOT NULL AND NEW.status IN ('pending', 'ready')
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.id <> OLD.id AND a.sha256 = NEW.sha256
        AND a.status IN ('pending', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER assets_reject_pending_import_sha_publication_insert
BEFORE INSERT ON assets
WHEN NEW.import_id IS NULL
  AND NEW.status IN ('pending', 'ready')
  AND NEW.sha256 IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets staged
    JOIN imports owner ON owner.id = staged.import_id
    WHERE staged.sha256 = NEW.sha256
      AND staged.status IN ('pending', 'ready')
      AND owner.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = staged.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = staged.r2_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'matching asset is owned by a pending import');
END;

CREATE TRIGGER assets_reject_pending_import_sha_publication_update
BEFORE UPDATE OF status, sha256, import_id ON assets
WHEN NEW.import_id IS NULL
  AND NEW.status IN ('pending', 'ready')
  AND NEW.sha256 IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets staged
    JOIN imports owner ON owner.id = staged.import_id
    WHERE staged.id <> OLD.id
      AND staged.sha256 = NEW.sha256
      AND staged.status IN ('pending', 'ready')
      AND owner.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = staged.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = staged.r2_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'matching asset is owned by a pending import');
END;

CREATE TRIGGER template_versions_guard_unpublished_update
BEFORE UPDATE ON template_versions
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = OLD.id AND i.status = 'pending'
)
AND NOT (
  OLD.id IS NEW.id
  AND OLD.recipe_family_id IS NEW.recipe_family_id
  AND OLD.name IS NEW.name
  AND OLD.template_type IS NEW.template_type
  AND OLD.version IS NEW.version
  AND OLD.manifest_hash IS NEW.manifest_hash
  AND OLD.initial_state_hash IS NEW.initial_state_hash
  AND OLD.source_filename IS NEW.source_filename
  AND OLD.source_asset_key IS NOT NEW.source_asset_key
  AND OLD.content_json IS NEW.content_json
  AND OLD.created_by IS NEW.created_by
  AND OLD.created_at IS NEW.created_at
  AND OLD.locked_at IS NEW.locked_at
  AND OLD.locked_by IS NEW.locked_by
  AND OLD.archived_at IS NEW.archived_at
  AND OLD.archived_by IS NEW.archived_by
  AND OLD.template_kind IS NEW.template_kind
  AND OLD.metrology_notes IS NEW.metrology_notes
  AND OLD.deleted_at IS NEW.deleted_at
  AND OLD.deleted_by IS NEW.deleted_by
  AND EXISTS (
    SELECT 1
    FROM assets legacy
    JOIN imports failed_owner ON failed_owner.id = legacy.import_id
    JOIN assets canonical ON canonical.r2_key = NEW.source_asset_key
    LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
    WHERE legacy.r2_key = OLD.source_asset_key
      AND failed_owner.status = 'failed'
      AND failed_owner.recovery_operation_id IS NOT NULL
      AND legacy.sha256 IS NOT NULL
      AND canonical.sha256 = legacy.sha256
      AND canonical.byte_size = legacy.byte_size
      AND canonical.status = 'ready'
      AND (
        canonical.import_id IS NULL
        OR canonical_owner.status = 'ready'
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = canonical.r2_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = canonical.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER metrology_template_references_guard_publication_update
BEFORE UPDATE OF template_version_id, asset_id ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'template version is not published')
  WHERE EXISTS (
    SELECT 1 FROM imports i
    WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
  )
  AND NOT (
    OLD.id IS NEW.id
    AND OLD.template_version_id IS NEW.template_version_id
    AND OLD.asset_id IS NOT NEW.asset_id
    AND OLD.display_name IS NEW.display_name
    AND OLD.position IS NEW.position
    AND OLD.actor_email IS NEW.actor_email
    AND OLD.created_at IS NEW.created_at
    AND OLD.deleted_at IS NEW.deleted_at
    AND OLD.deleted_by IS NEW.deleted_by
    AND EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN assets canonical ON canonical.id = NEW.asset_id
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id IS NOT NULL
        AND legacy.sha256 IS NOT NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (
          canonical.import_id IS NULL
          OR canonical_owner.status = 'ready'
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = canonical.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = canonical.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    )
  );

  SELECT RAISE(ABORT, 'asset owning import is not ready') WHERE NOT EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id AND a.status = 'ready'
      AND (a.import_id IS NULL OR i.status = 'ready')
  );
END;

CREATE TRIGGER project_content_attachments_reject_update
BEFORE UPDATE ON project_content_attachments
WHEN NOT (
  OLD.project_content_id IS NEW.project_content_id
  AND OLD.asset_id IS NOT NEW.asset_id
  AND OLD.asset_id IS NOT NULL
  AND NEW.asset_id IS NOT NULL
  AND OLD.storage_object_id IS NULL
  AND NEW.storage_object_id IS NULL
  AND OLD.original_name IS NEW.original_name
  AND OLD.mime_type IS NEW.mime_type
  AND OLD.byte_size IS NEW.byte_size
  AND OLD.created_by IS NEW.created_by
  AND OLD.created_at IS NEW.created_at
  AND OLD.creation_operation_id IS NEW.creation_operation_id
  AND EXISTS (
    SELECT 1
    FROM assets legacy
    JOIN imports failed_owner ON failed_owner.id = legacy.import_id
    JOIN assets canonical ON canonical.id = NEW.asset_id
    LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
    WHERE legacy.id = OLD.asset_id
      AND failed_owner.status = 'failed'
      AND failed_owner.recovery_operation_id IS NOT NULL
      AND legacy.sha256 IS NOT NULL
      AND canonical.sha256 = legacy.sha256
      AND canonical.byte_size = legacy.byte_size
      AND canonical.status = 'ready'
      AND (
        canonical.import_id IS NULL
        OR canonical_owner.status = 'ready'
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = canonical.r2_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = canonical.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'r2' AND biq.provider = 'r2'
       AND biq.object_key = a.r2_key
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'managed'
       AND biq.provider = mso.provider
       AND biq.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
    )
  );

  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE NEW.asset_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM assets a
      LEFT JOIN imports i ON i.id = a.import_id
      WHERE a.id = NEW.asset_id
        AND a.status = 'ready'
        AND (a.import_id IS NULL OR i.status = 'ready')
    );

  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'r2' AND bg.provider = 'r2'
       AND bg.object_key = a.r2_key
       AND bg.state IN ('deleting', 'deleted')
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'managed'
       AND bg.provider = mso.provider
       AND bg.object_key = mso.object_key
       AND bg.state IN ('deleting', 'deleted')
      WHERE mso.id = NEW.storage_object_id
    )
  );

  SELECT RAISE(ABORT, 'project attachment intrinsic metadata is immutable');
END;

CREATE TRIGGER run_step_assets_reject_superseded_insert
BEFORE INSERT ON run_step_assets
WHEN NEW.superseded_by_occurrence_id IS NOT NULL
  OR NEW.superseded_at IS NOT NULL
  OR NEW.superseded_by IS NOT NULL
  OR NEW.supersession_operation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'run step asset supersession is recovery-only');
END;

CREATE TRIGGER run_step_assets_restore_successor_after_supersession
AFTER UPDATE OF superseded_by_occurrence_id ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND NEW.superseded_by_occurrence_id IS NOT NULL
  AND OLD.deleted_at IS NULL
BEGIN
  UPDATE run_step_assets
  SET deleted_at = NULL,
      deleted_by = NULL,
      last_mutation_id = NEW.supersession_operation_id
  WHERE id = NEW.superseded_by_occurrence_id
    AND superseded_by_occurrence_id IS NULL;
END;

CREATE TRIGGER metrology_template_references_reject_superseded_insert
BEFORE INSERT ON metrology_template_references
WHEN NEW.superseded_by_occurrence_id IS NOT NULL
  OR NEW.superseded_at IS NOT NULL
  OR NEW.superseded_by IS NOT NULL
  OR NEW.supersession_operation_id IS NOT NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'metrology reference supersession is recovery-only'
  );
END;

CREATE TRIGGER metrology_template_references_guard_supersession_create
BEFORE UPDATE OF
  superseded_by_occurrence_id,
  superseded_at,
  superseded_by,
  supersession_operation_id
ON metrology_template_references
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND (
    NEW.superseded_by_occurrence_id IS NOT NULL
    OR NEW.superseded_at IS NOT NULL
    OR NEW.superseded_by IS NOT NULL
    OR NEW.supersession_operation_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid metrology reference supersession')
  WHERE NEW.superseded_by_occurrence_id IS NULL
    OR NEW.superseded_at IS NULL
    OR length(NEW.superseded_at) = 0
    OR NEW.superseded_by IS NOT 'system:fabublox-import-recovery'
    OR NEW.supersession_operation_id IS NULL
    OR length(NEW.supersession_operation_id) = 0
    OR NEW.deleted_at IS NULL
    OR NEW.deleted_by IS NULL
    OR NEW.id IS NOT OLD.id
    OR NEW.template_version_id IS NOT OLD.template_version_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.display_name IS NOT OLD.display_name
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NOT EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN metrology_template_references successor
        ON successor.id = NEW.superseded_by_occurrence_id
      JOIN assets canonical ON canonical.id = successor.asset_id
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id =
            NEW.supersession_operation_id
        AND legacy.sha256 IS NOT NULL
        AND successor.id <> OLD.id
        AND successor.template_version_id = OLD.template_version_id
        AND successor.superseded_by_occurrence_id IS NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (
          canonical.import_id IS NULL
          OR canonical_owner.status = 'ready'
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = canonical.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = canonical.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );
END;

CREATE TRIGGER metrology_template_references_lock_superseded_occurrence
BEFORE UPDATE ON metrology_template_references
WHEN OLD.superseded_by_occurrence_id IS NOT NULL
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.template_version_id IS NOT OLD.template_version_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.display_name IS NOT OLD.display_name
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.deleted_by IS NOT OLD.deleted_by
    OR NEW.superseded_by_occurrence_id
       IS NOT OLD.superseded_by_occurrence_id
    OR NEW.superseded_at IS NOT OLD.superseded_at
    OR NEW.superseded_by IS NOT OLD.superseded_by
    OR NEW.supersession_operation_id
       IS NOT OLD.supersession_operation_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'superseded metrology reference occurrence is immutable'
  );
END;

CREATE TRIGGER metrology_template_references_restore_successor_after_supersession
AFTER UPDATE OF superseded_by_occurrence_id ON metrology_template_references
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND NEW.superseded_by_occurrence_id IS NOT NULL
  AND OLD.deleted_at IS NULL
BEGIN
  UPDATE metrology_template_references
  SET deleted_at = NULL,
      deleted_by = NULL
  WHERE id = NEW.superseded_by_occurrence_id
    AND superseded_by_occurrence_id IS NULL;
END;

CREATE TRIGGER run_step_assets_sync_supersession_timeline
AFTER UPDATE OF superseded_by_occurrence_id ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND NEW.superseded_by_occurrence_id IS NOT NULL
BEGIN
  UPDATE events
  SET asset_key = CASE
        WHEN asset_key = (
          SELECT legacy_asset.r2_key
          FROM assets legacy_asset
          WHERE legacy_asset.id = OLD.asset_id
        )
        THEN (
          SELECT survivor_asset.r2_key
          FROM run_step_assets survivor
          JOIN assets survivor_asset ON survivor_asset.id = survivor.asset_id
          WHERE survivor.id = NEW.superseded_by_occurrence_id
        )
        ELSE asset_key
      END ,
      metadata_json = json_set(
        metadata_json,
        '$.supersededRunStepAssetId',
        COALESCE(
          json_extract(metadata_json, '$.supersededRunStepAssetId'),
          NEW.id
        ),
        '$.runStepAssetId',
        NEW.superseded_by_occurrence_id
      )
  WHERE json_valid(metadata_json)
    AND json_type(metadata_json, '$.runStepAssetId') = 'text'
    AND CAST(json_extract(metadata_json, '$.runStepAssetId') AS TEXT) = NEW.id;

  UPDATE events
  SET metadata_json = json_set(
        metadata_json,
        '$.thumbnailKey',
        (
          SELECT survivor_asset.r2_key
          FROM run_step_assets survivor
          JOIN assets survivor_asset ON survivor_asset.id = survivor.asset_id
          WHERE survivor.id = NEW.superseded_by_occurrence_id
        )
      )
  WHERE json_valid(metadata_json)
    AND json_type(metadata_json, '$.thumbnailKey') = 'text'
    AND CAST(json_extract(metadata_json, '$.thumbnailKey') AS TEXT) = (
      SELECT legacy_asset.r2_key
      FROM assets legacy_asset
      WHERE legacy_asset.id = OLD.asset_id
    );
END;

CREATE TRIGGER run_step_assets_guard_attachment_restore
BEFORE UPDATE OF deleted_at ON run_step_assets
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND OLD.superseded_by_occurrence_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2'
     AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2'
     AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_assets_release_orphan_after_restore
AFTER UPDATE OF deleted_at ON run_step_assets
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND OLD.superseded_by_occurrence_id IS NULL
BEGIN
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER comment_submission_items_guard_attachment_restore
BEFORE UPDATE OF deleted_at ON comment_submission_items
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'r2' AND bg.provider = 'r2'
       AND bg.object_key = a.r2_key
      WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'managed'
       AND bg.provider = mso.provider
       AND bg.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
        AND bg.state IN ('deleting', 'deleted')
    )
  );

  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'r2' AND biq.provider = 'r2'
       AND biq.object_key = a.r2_key
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'managed'
       AND biq.provider = mso.provider
       AND biq.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
    )
  );
END;

CREATE TRIGGER comment_submission_items_release_orphan_after_restore
AFTER UPDATE OF deleted_at ON comment_submission_items
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  -- Managed GC marks the physical metadata row orphaned when it creates the
  -- ledger entry. Restoring the child occurrence must reverse both halves of
  -- that state transition in the same SQLite statement; otherwise the rebuilt
  -- retention edge would permanently protect an object that download routes
  -- still reject as non-ready.
  UPDATE managed_storage_objects
  SET status = 'ready',
      orphaned_at = NULL
  WHERE id = NEW.storage_object_id
    AND status = 'orphaned';

  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND NEW.asset_id IS NOT NULL
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);

  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND NEW.storage_object_id IS NOT NULL
    AND (provider, object_key) = (
      SELECT provider, object_key
      FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;

CREATE TRIGGER run_step_assets_guard_supersession_create
BEFORE UPDATE OF
  superseded_by_occurrence_id,
  superseded_at,
  superseded_by,
  supersession_operation_id
ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND (
    NEW.superseded_by_occurrence_id IS NOT NULL
    OR NEW.superseded_at IS NOT NULL
    OR NEW.superseded_by IS NOT NULL
    OR NEW.supersession_operation_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid run step asset supersession')
  WHERE NEW.superseded_by_occurrence_id IS NULL
    OR NEW.superseded_at IS NULL
    OR length(NEW.superseded_at) = 0
    OR NEW.superseded_by IS NOT 'system:fabublox-import-recovery'
    OR NEW.supersession_operation_id IS NULL
    OR length(NEW.supersession_operation_id) = 0
    OR NEW.deleted_at IS NULL
    OR NEW.deleted_by IS NULL
    OR NEW.id IS NOT OLD.id
    OR NEW.run_step_id IS NOT OLD.run_step_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.role IS NOT OLD.role
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.filename IS NOT OLD.filename
    OR NEW.mime_type IS NOT OLD.mime_type
    OR NEW.byte_size IS NOT OLD.byte_size
    OR NEW.last_mutation_id IS NOT NEW.supersession_operation_id
    OR NOT EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN run_step_assets successor
        ON successor.id = NEW.superseded_by_occurrence_id
      JOIN assets canonical ON canonical.id = successor.asset_id
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id =
            NEW.supersession_operation_id
        AND legacy.sha256 IS NOT NULL
        AND successor.id <> OLD.id
        AND successor.run_step_id = OLD.run_step_id
        AND successor.role IS OLD.role
        AND successor.superseded_by_occurrence_id IS NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (
          canonical.import_id IS NULL
          OR canonical_owner.status = 'ready'
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = canonical.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = canonical.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );
END;

CREATE TRIGGER run_step_assets_lock_superseded_occurrence
BEFORE UPDATE ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NOT NULL
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.run_step_id IS NOT OLD.run_step_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.role IS NOT OLD.role
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.filename IS NOT OLD.filename
    OR NEW.mime_type IS NOT OLD.mime_type
    OR NEW.byte_size IS NOT OLD.byte_size
    OR NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.deleted_by IS NOT OLD.deleted_by
    OR NEW.last_mutation_id IS NOT OLD.last_mutation_id
    OR NEW.superseded_by_occurrence_id
       IS NOT OLD.superseded_by_occurrence_id
    OR NEW.superseded_at IS NOT OLD.superseded_at
    OR NEW.superseded_by IS NOT OLD.superseded_by
    OR NEW.supersession_operation_id
       IS NOT OLD.supersession_operation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'superseded run step asset occurrence is immutable');
END;

CREATE TRIGGER run_step_assets_fill_occurrence_metadata
AFTER INSERT ON run_step_assets
WHEN NEW.filename IS NULL OR NEW.mime_type IS NULL OR NEW.byte_size IS NULL
BEGIN
  UPDATE run_step_assets
  SET filename = COALESCE(
        NEW.filename,
        (SELECT a.original_name FROM assets a WHERE a.id = NEW.asset_id)
      ),
      mime_type = COALESCE(
        NEW.mime_type,
        (SELECT a.mime_type FROM assets a WHERE a.id = NEW.asset_id)
      ),
      byte_size = COALESCE(
        NEW.byte_size,
        (SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id)
      )
  WHERE id = NEW.id;
END;

CREATE TRIGGER run_step_assets_occurrence_metadata_insert_guard
BEFORE INSERT ON run_step_assets
BEGIN
  SELECT RAISE(ABORT, 'run step attachment filename is invalid')
  WHERE NEW.filename IS NOT NULL AND (
    length(trim(NEW.filename)) NOT BETWEEN 1 AND 255
    OR instr(NEW.filename, char(0)) > 0
  );
  SELECT RAISE(ABORT, 'run step attachment MIME type is invalid')
  WHERE NEW.mime_type IS NOT NULL AND (
    length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) <= 1
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) >= length(trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ))
    OR instr(
      substr(
        trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ),
        instr(trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ), '/') + 1
      ),
      '/'
    ) > 0
    OR trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*'
  );
  SELECT RAISE(ABORT, 'run step attachment byte size does not match blob')
  WHERE NEW.byte_size IS NOT NULL AND (
    typeof(NEW.byte_size) <> 'integer'
    OR NEW.byte_size < 0
    OR NEW.byte_size > 9007199254740991
    OR NEW.byte_size <> COALESCE(
      (SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id),
      -1
    )
  );
END;

CREATE TRIGGER run_step_assets_occurrence_metadata_update_guard
BEFORE UPDATE OF filename, mime_type, byte_size ON run_step_assets
BEGIN
  SELECT RAISE(ABORT, 'run step attachment filename is invalid')
  WHERE NEW.filename IS NULL
    OR length(trim(NEW.filename)) NOT BETWEEN 1 AND 255
    OR instr(NEW.filename, char(0)) > 0;
  SELECT RAISE(ABORT, 'run step attachment MIME type is invalid')
  WHERE NEW.mime_type IS NULL
    OR length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) <= 1
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) >= length(trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ))
    OR instr(
      substr(
        trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ),
        instr(trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ), '/') + 1
      ),
      '/'
    ) > 0
    OR trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*';
  SELECT RAISE(ABORT, 'run step attachment byte size does not match blob')
  WHERE NEW.byte_size IS NULL
    OR typeof(NEW.byte_size) <> 'integer'
    OR NEW.byte_size < 0
    OR NEW.byte_size > 9007199254740991
    OR NEW.byte_size <> COALESCE(
      (SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id),
      -1
    );
END;

CREATE TRIGGER run_step_assets_sync_byte_size_after_asset_rebind
AFTER UPDATE OF asset_id ON run_step_assets
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  UPDATE run_step_assets
  SET byte_size = (
    SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER project_attachment_occurrence_mime_insert_guard
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment MIME type is invalid')
  WHERE NEW.mime_type IS NULL
    OR length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) <= 1
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) >= length(trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ))
    OR instr(
      substr(
        trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ),
        instr(trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ), '/') + 1
      ),
      '/'
    ) > 0
    OR trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*';
END;

CREATE TRIGGER project_attachment_occurrence_mime_update_guard
BEFORE UPDATE OF mime_type ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment MIME type is invalid')
  WHERE NEW.mime_type IS NULL
    OR length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) <= 1
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) >= length(trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ))
    OR instr(
      substr(
        trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ),
        instr(trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ), '/') + 1
      ),
      '/'
    ) > 0
    OR trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*';
END;

CREATE TRIGGER project_attachment_occurrence_byte_size_guard
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment byte size does not match blob')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND NEW.byte_size <> COALESCE(
      (SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id),
      -1
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND NEW.byte_size <> COALESCE(
      (SELECT mso.byte_size FROM managed_storage_objects mso
       WHERE mso.id = NEW.storage_object_id),
      -1
    )
  );
END;

CREATE TRIGGER attachment_derivatives_lock_identity
BEFORE UPDATE OF
  source_sha256,
  source_byte_size,
  derivative_kind,
  generator_version
ON attachment_derivatives
BEGIN
  SELECT RAISE(ABORT, 'attachment derivative identity is immutable');
END;

CREATE TRIGGER attachment_derivatives_keep_ready
BEFORE UPDATE OF status ON attachment_derivatives
WHEN OLD.status = 'ready' AND NEW.status <> 'ready'
BEGIN
  SELECT RAISE(ABORT, 'ready attachment derivative cannot be demoted');
END;

CREATE TRIGGER attachment_derivatives_release_orphan_after_insert
AFTER INSERT ON attachment_derivatives
WHEN NEW.status = 'ready'
  AND NEW.retain_until IS NOT NULL
  AND datetime(NEW.retain_until) > datetime('now')
BEGIN
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (
      SELECT r2_key FROM assets WHERE id = NEW.derived_asset_id
    );
END;

CREATE TRIGGER attachment_derivatives_release_orphan_after_binding_update
AFTER UPDATE OF status, derived_asset_id ON attachment_derivatives
WHEN NEW.status = 'ready'
  AND NEW.retain_until IS NOT NULL
  AND datetime(NEW.retain_until) > datetime('now')
BEGIN
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (
      SELECT r2_key FROM assets WHERE id = NEW.derived_asset_id
    );
END;

CREATE TRIGGER attachment_derivatives_release_orphan_after_lease_touch
AFTER UPDATE OF retain_until ON attachment_derivatives
WHEN NEW.status = 'ready'
  AND NEW.retain_until IS NOT NULL
  AND datetime(NEW.retain_until) > datetime('now')
BEGIN
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (
      SELECT r2_key FROM assets WHERE id = NEW.derived_asset_id
    );
END;

CREATE TRIGGER attachment_derivatives_lock_healthy_winner
BEFORE UPDATE OF derived_asset_id ON attachment_derivatives
WHEN OLD.status = 'ready'
  AND NEW.derived_asset_id IS NOT OLD.derived_asset_id
BEGIN
  SELECT RAISE(ABORT, 'healthy attachment derivative winner is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM attachment_derivative_browser_safe_assets current_asset
    WHERE current_asset.id = OLD.derived_asset_id
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = current_asset.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = current_asset.r2_key
      )
  );
END;

CREATE TRIGGER attachment_derivatives_guard_ready_insert
BEFORE INSERT ON attachment_derivatives
WHEN NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'attachment derivative asset is unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.derived_asset_id AND a.status = 'ready'
  ) OR EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2'
     AND bg.object_key = a.r2_key
    WHERE a.id = NEW.derived_asset_id
      AND bg.state IN ('deleting', 'deleted')
  );

  SELECT RAISE(ABORT, 'attachment derivative asset is quarantined')
  WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2'
     AND biq.object_key = a.r2_key
    WHERE a.id = NEW.derived_asset_id
  );

  SELECT RAISE(ABORT, 'attachment derivative asset is not browser-safe')
  WHERE NOT EXISTS (
    SELECT 1 FROM attachment_derivative_browser_safe_assets a
    WHERE a.id = NEW.derived_asset_id
  );
END;

CREATE TRIGGER attachment_derivatives_guard_ready_update
BEFORE UPDATE OF status, derived_asset_id, retain_until ON attachment_derivatives
WHEN NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'attachment derivative asset is unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.derived_asset_id AND a.status = 'ready'
  ) OR EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2'
     AND bg.object_key = a.r2_key
    WHERE a.id = NEW.derived_asset_id
      AND bg.state IN ('deleting', 'deleted')
  );

  SELECT RAISE(ABORT, 'attachment derivative asset is quarantined')
  WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2'
     AND biq.object_key = a.r2_key
    WHERE a.id = NEW.derived_asset_id
  );

  SELECT RAISE(ABORT, 'attachment derivative asset is not browser-safe')
  WHERE NOT EXISTS (
    SELECT 1 FROM attachment_derivative_browser_safe_assets a
    WHERE a.id = NEW.derived_asset_id
  );
END;

CREATE TRIGGER project_edges_reject_identity_update
BEFORE UPDATE ON project_edges
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project edge identity is immutable');
END;

CREATE TRIGGER project_edges_require_revisioned_update
BEFORE UPDATE ON project_edges
WHEN OLD.revision IS NOT NEW.revision
  OR OLD.last_mutation_id IS NOT NEW.last_mutation_id
  OR OLD.source_item_id IS NOT NEW.source_item_id
  OR OLD.target_item_id IS NOT NEW.target_item_id
  OR OLD.source_handle IS NOT NEW.source_handle
  OR OLD.target_handle IS NOT NEW.target_handle
  OR OLD.marker_start IS NOT NEW.marker_start
  OR OLD.marker_end IS NOT NEW.marker_end
  OR OLD.label IS NOT NEW.label
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project edge revision metadata requires a semantic update')
  WHERE NOT (
    OLD.source_item_id IS NOT NEW.source_item_id
    OR OLD.target_item_id IS NOT NEW.target_item_id
    OR OLD.source_handle IS NOT NEW.source_handle
    OR OLD.target_handle IS NOT NEW.target_handle
    OR OLD.marker_start IS NOT NEW.marker_start
    OR OLD.marker_end IS NOT NEW.marker_end
    OR OLD.label IS NOT NEW.label
    OR OLD.deleted_at IS NOT NEW.deleted_at
    OR OLD.deleted_by IS NOT NEW.deleted_by
    OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
  );
  SELECT RAISE(ABORT, 'project edge update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project edge update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;

CREATE TRIGGER run_step_comments_guard_blob_insert
BEFORE INSERT ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER run_step_comments_block_physical_delete
BEFORE DELETE ON run_step_comments BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for run_step_comments');
END;

CREATE TRIGGER run_step_comments_guard_integrity_insert
BEFORE INSERT ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_comments_guard_integrity_update
BEFORE UPDATE OF asset_id ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
  AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_comments_guard_publication_insert
BEFORE INSERT ON run_step_comments
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER run_step_comments_guard_publication_update
BEFORE UPDATE OF asset_id ON run_step_comments
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

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

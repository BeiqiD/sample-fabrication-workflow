PRAGMA foreign_keys = ON;

-- SQLite TEXT affinity still accepts BLOB values, and length(TEXT) stops at the
-- first embedded NUL. These guards keep every public Project payload inside the
-- same NUL-free text and length contract as shared/project-api.ts so direct SQL,
-- import, and restore paths cannot persist values serializers cannot expose as
-- strings.
CREATE TRIGGER projects_require_payload_text_insert
BEFORE INSERT ON projects
BEGIN
  SELECT RAISE(ABORT, 'project title must be text')
  WHERE typeof(NEW.title) <> 'text';
  SELECT RAISE(ABORT, 'project title must not contain NUL')
  WHERE instr(NEW.title, char(0)) > 0;
  SELECT RAISE(ABORT, 'project title must be trimmed and between 1 and 200 characters')
  WHERE NEW.title <> trim(NEW.title)
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
  WHERE NEW.title <> trim(NEW.title)
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
      OR NEW.attachment_source_url <> trim(NEW.attachment_source_url)
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
      OR NEW.attachment_source_url <> trim(NEW.attachment_source_url)
      OR length(NEW.attachment_source_url) NOT BETWEEN 1 AND 2048
      OR NOT (
        lower(NEW.attachment_source_url) GLOB 'http://?*'
        OR lower(NEW.attachment_source_url) GLOB 'https://?*'
      )
    );
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

-- External registry/blob rows are selected by stable IDs through the public
-- Project API. Apply the same ASCII/256-character identity contract to these
-- foreign keys as to Project-owned identities.
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

PRAGMA foreign_keys = ON;

-- TypeScript uses ECMAScript String.prototype.trim(), whose whitespace set is
-- broader than SQLite's default trim(X) (U+0020 only). Recreate the title and
-- source-URL guards with the exact ECMAScript WhiteSpace + LineTerminator set:
-- U+0009-U+000D, U+0020, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029,
-- U+202F, U+205F, U+3000, and U+FEFF. SQLite length(TEXT) already counts
-- Unicode code points; shared/project-api.ts now uses the same unit.
DROP TRIGGER IF EXISTS projects_require_payload_text_insert;
DROP TRIGGER IF EXISTS projects_require_payload_text_update;
DROP TRIGGER IF EXISTS project_contents_require_payload_text_insert;
DROP TRIGGER IF EXISTS project_contents_require_payload_text_update;

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

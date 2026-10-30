-- Owner-authorized retirement of six obsolete FP1b-FP1g synthetic QA Projects.
-- Exact identities only; never title/prefix matching. Existing test data was
-- already placed in recoverable Trash. If one was restored, fail for review.
-- The surrounding D1 migration transaction owns atomicity. All six temporary
-- physical-delete guard removals are restored verbatim before commit.
-- Leave assets, reference targets, File publications, and all immutable audit
-- history intact. Existing capture triggers record disappeared consumers; shared
-- bytes continue through the existing retention/GC lifecycle, without provider I/O.
-- This data-only migration changes neither final schema nor archive protocol.

SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM projects WHERE deleted_at IS NULL AND id IN (
    'project-70013e0d-8275-4f07-856f-5b49dbf59366',
    'project-a20563ba-8561-4f46-bb98-c24018fbdaa2',
    'project-baa236dd-c260-427c-b717-62d1ac5208f0',
    'project-9f37185a-ad27-44e7-b9ba-184724efc42b',
    'project-ab124de5-283a-41a3-b642-6326529a00c9',
    'project-9fd35dfe-541d-4bf3-a87c-00169e86f1d6'
  )
) THEN 1 ELSE json('FP1b-FP1g cleanup requires the selected Projects to remain in Trash') END ;

DROP TRIGGER project_edges_reject_physical_delete;

DROP TRIGGER project_map_placements_reject_physical_delete;

DROP TRIGGER project_content_attachments_reject_physical_delete;

DROP TRIGGER project_items_reject_physical_delete;

DROP TRIGGER project_contents_reject_physical_delete;

DROP TRIGGER projects_reject_physical_delete;

DELETE FROM project_edges WHERE project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND id IN (
    'project-70013e0d-8275-4f07-856f-5b49dbf59366',
    'project-a20563ba-8561-4f46-bb98-c24018fbdaa2',
    'project-baa236dd-c260-427c-b717-62d1ac5208f0',
    'project-9f37185a-ad27-44e7-b9ba-184724efc42b',
    'project-ab124de5-283a-41a3-b642-6326529a00c9',
    'project-9fd35dfe-541d-4bf3-a87c-00169e86f1d6'
  ));

DELETE FROM project_map_placements WHERE project_item_id IN (SELECT id FROM project_items WHERE project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND id IN (
    'project-70013e0d-8275-4f07-856f-5b49dbf59366',
    'project-a20563ba-8561-4f46-bb98-c24018fbdaa2',
    'project-baa236dd-c260-427c-b717-62d1ac5208f0',
    'project-9f37185a-ad27-44e7-b9ba-184724efc42b',
    'project-ab124de5-283a-41a3-b642-6326529a00c9',
    'project-9fd35dfe-541d-4bf3-a87c-00169e86f1d6'
  )));

DELETE FROM project_content_attachments WHERE project_content_id IN (SELECT id FROM project_contents WHERE project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND id IN (
    'project-70013e0d-8275-4f07-856f-5b49dbf59366',
    'project-a20563ba-8561-4f46-bb98-c24018fbdaa2',
    'project-baa236dd-c260-427c-b717-62d1ac5208f0',
    'project-9f37185a-ad27-44e7-b9ba-184724efc42b',
    'project-ab124de5-283a-41a3-b642-6326529a00c9',
    'project-9fd35dfe-541d-4bf3-a87c-00169e86f1d6'
  )));

DELETE FROM project_items WHERE project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND id IN (
    'project-70013e0d-8275-4f07-856f-5b49dbf59366',
    'project-a20563ba-8561-4f46-bb98-c24018fbdaa2',
    'project-baa236dd-c260-427c-b717-62d1ac5208f0',
    'project-9f37185a-ad27-44e7-b9ba-184724efc42b',
    'project-ab124de5-283a-41a3-b642-6326529a00c9',
    'project-9fd35dfe-541d-4bf3-a87c-00169e86f1d6'
  ));

DELETE FROM project_contents WHERE project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND id IN (
    'project-70013e0d-8275-4f07-856f-5b49dbf59366',
    'project-a20563ba-8561-4f46-bb98-c24018fbdaa2',
    'project-baa236dd-c260-427c-b717-62d1ac5208f0',
    'project-9f37185a-ad27-44e7-b9ba-184724efc42b',
    'project-ab124de5-283a-41a3-b642-6326529a00c9',
    'project-9fd35dfe-541d-4bf3-a87c-00169e86f1d6'
  ));

DELETE FROM projects WHERE id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND id IN (
    'project-70013e0d-8275-4f07-856f-5b49dbf59366',
    'project-a20563ba-8561-4f46-bb98-c24018fbdaa2',
    'project-baa236dd-c260-427c-b717-62d1ac5208f0',
    'project-9f37185a-ad27-44e7-b9ba-184724efc42b',
    'project-ab124de5-283a-41a3-b642-6326529a00c9',
    'project-9fd35dfe-541d-4bf3-a87c-00169e86f1d6'
  ));

CREATE TRIGGER project_edges_reject_physical_delete
BEFORE DELETE ON project_edges
BEGIN
  SELECT RAISE(ABORT, 'project edge physical deletion is disabled');
END;

CREATE TRIGGER project_map_placements_reject_physical_delete
BEFORE DELETE ON project_map_placements
BEGIN
  SELECT RAISE(ABORT, 'project placement physical deletion is disabled');
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

CREATE TRIGGER project_contents_reject_physical_delete
BEFORE DELETE ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project content physical deletion is disabled');
END;

CREATE TRIGGER projects_reject_physical_delete
BEFORE DELETE ON projects
BEGIN
  SELECT RAISE(ABORT, 'project physical deletion is disabled');
END;

-- Metrology templates are user-owned records. Retire the five historical
-- presets so a newly migrated database starts with an empty template list.
-- A preset already referenced by user data is archived instead of destroyed.

UPDATE template_versions
SET archived_at = COALESCE(archived_at, '2026-08-07T00:00:00.000Z'),
    archived_by = COALESCE(archived_by, 'system:retire-builtin-metrology')
WHERE id IN (
  'builtin-metrology-template-sem',
  'builtin-metrology-template-tem',
  'builtin-metrology-template-afm',
  'builtin-metrology-template-optical-microscope',
  'builtin-metrology-template-xrd'
);

DELETE FROM template_versions
WHERE id IN (
  'builtin-metrology-template-sem',
  'builtin-metrology-template-tem',
  'builtin-metrology-template-afm',
  'builtin-metrology-template-optical-microscope',
  'builtin-metrology-template-xrd'
)
AND NOT EXISTS (
  SELECT 1 FROM runs WHERE runs.template_version_id = template_versions.id
)
AND NOT EXISTS (
  SELECT 1 FROM run_plan_revisions
  WHERE run_plan_revisions.template_version_id = template_versions.id
)
AND NOT EXISTS (
  SELECT 1 FROM recipe_change_proposals
  WHERE recipe_change_proposals.source_template_version_id = template_versions.id
);

UPDATE recipe_families
SET archived_at = COALESCE(archived_at, '2026-08-07T00:00:00.000Z'),
    archived_by = COALESCE(archived_by, 'system:retire-builtin-metrology')
WHERE id IN (
  'builtin-metrology-family-sem',
  'builtin-metrology-family-tem',
  'builtin-metrology-family-afm',
  'builtin-metrology-family-optical-microscope',
  'builtin-metrology-family-xrd'
);

DELETE FROM recipe_families
WHERE id IN (
  'builtin-metrology-family-sem',
  'builtin-metrology-family-tem',
  'builtin-metrology-family-afm',
  'builtin-metrology-family-optical-microscope',
  'builtin-metrology-family-xrd'
)
AND NOT EXISTS (
  SELECT 1 FROM template_versions
  WHERE template_versions.recipe_family_id = recipe_families.id
)
AND NOT EXISTS (
  SELECT 1 FROM recipe_change_proposals
  WHERE recipe_change_proposals.recipe_family_id = recipe_families.id
);

-- Metrology templates are user-owned records. Retire the five historical
-- presets without deleting their stable identities, steps, reference files,
-- or any Run history that may point to them.

UPDATE template_versions
SET name = CASE id
      WHEN 'builtin-metrology-template-sem'
        THEN 'Retired built-in · SEM · builtin-metrology-template-sem'
      WHEN 'builtin-metrology-template-tem'
        THEN 'Retired built-in · TEM · builtin-metrology-template-tem'
      WHEN 'builtin-metrology-template-afm'
        THEN 'Retired built-in · AFM · builtin-metrology-template-afm'
      WHEN 'builtin-metrology-template-optical-microscope'
        THEN 'Retired built-in · Optical microscope · builtin-metrology-template-optical-microscope'
      WHEN 'builtin-metrology-template-xrd'
        THEN 'Retired built-in · XRD · builtin-metrology-template-xrd'
      ELSE name
    END,
    archived_at = COALESCE(archived_at, '2026-08-07T00:00:00.000Z'),
    archived_by = COALESCE(archived_by, 'system:retire-builtin-metrology')
WHERE id IN (
  'builtin-metrology-template-sem',
  'builtin-metrology-template-tem',
  'builtin-metrology-template-afm',
  'builtin-metrology-template-optical-microscope',
  'builtin-metrology-template-xrd'
);

UPDATE recipe_families
SET name = CASE id
      WHEN 'builtin-metrology-family-sem'
        THEN 'Retired built-in · SEM · builtin-metrology-family-sem'
      WHEN 'builtin-metrology-family-tem'
        THEN 'Retired built-in · TEM · builtin-metrology-family-tem'
      WHEN 'builtin-metrology-family-afm'
        THEN 'Retired built-in · AFM · builtin-metrology-family-afm'
      WHEN 'builtin-metrology-family-optical-microscope'
        THEN 'Retired built-in · Optical microscope · builtin-metrology-family-optical-microscope'
      WHEN 'builtin-metrology-family-xrd'
        THEN 'Retired built-in · XRD · builtin-metrology-family-xrd'
      ELSE name
    END,
    archived_at = COALESCE(archived_at, '2026-08-07T00:00:00.000Z'),
    archived_by = COALESCE(archived_by, 'system:retire-builtin-metrology')
WHERE id IN (
  'builtin-metrology-family-sem',
  'builtin-metrology-family-tem',
  'builtin-metrology-family-afm',
  'builtin-metrology-family-optical-microscope',
  'builtin-metrology-family-xrd'
);

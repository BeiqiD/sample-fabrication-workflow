from __future__ import annotations

from pathlib import Path


path = Path(".github/pr141-cross-module-fixes.py")
source = path.read_text()

helper_needle = (
    "    updated, count = re.subn(pattern, replacement, text, "
    "count=1, flags=re.S)\n"
)
helper_replacement = (
    '    pattern = pattern.replace("\\\\\\\\", "\\\\")\n'
    + helper_needle
)
if source.count(helper_needle) != 1:
    raise SystemExit("Could not normalize patch regex helper")
source = source.replace(helper_needle, helper_replacement, 1)

section_start = source.index(
    "# Reference adapters resolve the stable legacy occurrence"
)
section_end = source.index(
    "# Reference media follows the same effective-occurrence rule.",
    section_start,
)

adapter_section = r'''# Reference adapters resolve the stable legacy occurrence through its immutable,
# provider-verified survivor without changing the target ID.
execution_block = r'''const executionImageAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT rsa.id, rsa.created_at, rsa.deleted_at,
           rsa.superseded_by_occurrence_id,
           original_asset.original_name AS original_name,
           effective_asset.original_name AS effective_original_name,
           effective_asset.mime_type,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at,
           r.id AS run_id, r.template_name_snapshot AS run_template_name,
           r.template_version_snapshot AS run_template_version,
           r.deleted_at AS run_deleted_at,
           rs.id AS step_id, COALESCE(rs.title, sd.name) AS step_title,
           rs.deleted_at AS step_deleted_at
    FROM run_step_assets rsa
    LEFT JOIN run_step_assets successor
      ON successor.id = rsa.superseded_by_occurrence_id
    LEFT JOIN assets original_asset ON original_asset.id = rsa.asset_id
    LEFT JOIN assets effective_asset
      ON effective_asset.id = COALESCE(successor.asset_id, rsa.asset_id)
    LEFT JOIN run_steps rs ON rs.id = rsa.run_step_id
    LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
    LEFT JOIN runs r ON r.id = rs.run_id
    LEFT JOIN samples s ON s.id = r.sample_id
    WHERE rsa.id IN (SELECT value FROM json_each(?))
      AND rsa.role = 'execution'
      AND effective_asset.status = 'ready'
      AND ${publishedAssetSql("effective_asset")}
      AND (
        rsa.superseded_by_occurrence_id IS NULL
        OR (
          successor.id IS NOT NULL
          AND successor.superseded_by_occurrence_id IS NULL
        )
      )
    ORDER BY rsa.id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.id);
    const context = executionContext(row);
    return [id, {
      source: {
        title: text(row.original_name)
          ?? text(row.effective_original_name)
          ?? "Execution image",
        subtitle: text(row.mime_type),
        excerpt: null,
        kind: "execution",
        state: row.superseded_by_occurrence_id ? "superseded" : "ready",
        updatedAt: text(row.created_at),
        deletedAt: text(row.deleted_at),
        archivedAt: null,
      },
      contexts: context ? [context] : [],
      consistent: Boolean(
        context
        && text(row.original_name)
        && text(row.effective_original_name)
      ),
    }];
  }));
};'''
replace_regex_once(
    "worker/references/adapters.ts",
    r'''const executionImageAdapter: ReferenceAdapter = async \(db, ids\) => \{.*?\n\};(?=\n\nconst metrologyReferenceAdapter)''',
    execution_block,
)

metrology_block = r'''const metrologyReferenceAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT mtr.id, mtr.display_name, mtr.created_at, mtr.deleted_at,
           mtr.superseded_by_occurrence_id,
           effective_asset.original_name, effective_asset.mime_type,
           tv.id AS recipe_id, tv.name AS recipe_name,
           tv.version AS recipe_version,
           tv.deleted_at AS recipe_deleted_at,
           tv.archived_at AS recipe_archived_at
    FROM metrology_template_references mtr
    LEFT JOIN metrology_template_references successor
      ON successor.id = mtr.superseded_by_occurrence_id
    LEFT JOIN assets effective_asset
      ON effective_asset.id = COALESCE(successor.asset_id, mtr.asset_id)
    LEFT JOIN template_versions tv ON tv.id = mtr.template_version_id
    WHERE mtr.id IN (SELECT value FROM json_each(?))
      AND effective_asset.status = 'ready'
      AND ${publishedAssetSql("effective_asset")}
      AND ${publishedTemplateVersionSql("tv")}
      AND (
        mtr.superseded_by_occurrence_id IS NULL
        OR (
          successor.id IS NOT NULL
          AND successor.superseded_by_occurrence_id IS NULL
        )
      )
    ORDER BY mtr.id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.id);
    const recipe = recipeSegment(row);
    return [id, {
      source: {
        title: requiredText(row.display_name)
          || text(row.original_name)
          || "Metrology reference",
        subtitle: text(row.original_name) ?? text(row.mime_type),
        excerpt: null,
        kind: "metrology_reference",
        state: row.superseded_by_occurrence_id ? "superseded" : "ready",
        updatedAt: text(row.created_at),
        deletedAt: text(row.deleted_at),
        archivedAt: text(row.recipe_archived_at),
      },
      contexts: recipe ? [{ segments: [recipe] }] : [],
      consistent: Boolean(recipe && text(row.original_name)),
    }];
  }));
};'''
replace_regex_once(
    "worker/references/adapters.ts",
    r'''const metrologyReferenceAdapter: ReferenceAdapter = async \(db, ids\) => \{.*?\n\};(?=\n\nconst recipeRevisionAdapter)''',
    metrology_block,
)

'''

source = source[:section_start] + adapter_section + source[section_end:]
exec(compile(source, str(path), "exec"), {"__name__": "__main__"})

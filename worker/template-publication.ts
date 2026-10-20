const SAFE_SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const TEMPLATE_VERSION_NOT_PUBLISHED_SQL_ERROR = "template version is not published";
export const ASSET_OWNING_IMPORT_NOT_READY_SQL_ERROR = "asset owning import is not ready";

function safeAlias(alias: string) {
  if (!SAFE_SQL_ALIAS.test(alias)) {
    throw new Error(`Unsafe SQL alias: ${alias}`);
  }
  return alias;
}

/**
 * Standalone template revisions are published immediately. Imported revisions
 * are published only after every owning import has reached ready.
 */
export function publishedTemplateVersionSql(alias: string) {
  const table = safeAlias(alias);
  return `NOT EXISTS (
    SELECT 1 FROM imports owning_import
    WHERE owning_import.template_version_id = ${table}.id
      AND owning_import.status <> 'ready'
  )`;
}

/**
 * Standalone assets are available when ready. Imported assets additionally
 * require their owning import to be ready; a dangling import identity fails
 * closed.
 */
export function publishedAssetSql(alias: string) {
  const table = safeAlias(alias);
  return `(
    ${table}.import_id IS NULL
    OR EXISTS (
      SELECT 1 FROM imports owning_import
      WHERE owning_import.id = ${table}.import_id
        AND owning_import.status = 'ready'
    )
  )`;
}

import { HTTPException } from "hono/http-exception";
import { publishedTemplateVersionSql } from "../template-publication";
import { prepareFileRestorationWithDatabase } from "../files/business-lifecycle-service";
import type { FileBusinessMetadataDatabase, FileBusinessMetadataStatement } from "../files/business-metadata-sql";
import type { TemplateReferenceLifecycleDatabase } from "./reference-lifecycle-sql";

export async function requirePublishedTemplateVersionWithDatabase<Statement extends FileBusinessMetadataStatement<Statement>>(db: FileBusinessMetadataDatabase<Statement>, id: string) {
  const row = await db.prepare(`
    SELECT 1 AS published
    FROM template_versions tv
    WHERE tv.id = ? AND ${publishedTemplateVersionSql("tv")}
  `).bind(id).first<{ published: number }>();
  if (!row) throw new HTTPException(404, { message: "Template version not found" });
}

export async function removeMetrologyReferenceWithDatabase<Statement extends FileBusinessMetadataStatement<Statement>>(db: TemplateReferenceLifecycleDatabase<Statement>, id: string, referenceId: string, actor: string, currentTimestamp: () => string = () => new Date().toISOString()) {
  await requirePublishedTemplateVersionWithDatabase(db, id);
  const now = currentTimestamp();
  const result = await db.mutation(db.prepare(
    `UPDATE metrology_template_references
     SET deleted_at = ?, deleted_by = ?
     WHERE id = ? AND template_version_id = ?
       AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM template_versions
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL
       )`,
  ).bind(now, actor, referenceId, id, id));
  if (!result.changes) throw new HTTPException(404, { message: "Template reference not found" });
  return { ok: true };
}

export async function restoreMetrologyReferenceWithDatabase<Statement extends FileBusinessMetadataStatement<Statement>>(db: TemplateReferenceLifecycleDatabase<Statement>, id: string, referenceId: string) {
  await requirePublishedTemplateVersionWithDatabase(db, id);
  const fences = await prepareFileRestorationWithDatabase(db, "metrology_reference", [referenceId]);
  const results = await db.atomicBatch([...fences, db.prepare(
    `UPDATE metrology_template_references
     SET deleted_at = NULL, deleted_by = NULL
     WHERE id = ? AND template_version_id = ? AND deleted_at IS NOT NULL
       AND superseded_by_occurrence_id IS NULL
       AND EXISTS (
         SELECT 1 FROM template_versions
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL
       )`,
  ).bind(referenceId, id, id)]);
  const result = results[fences.length];
  if (!result.changes) throw new HTTPException(404, { message: "Deleted template reference not found" });
  return { ok: true };
}

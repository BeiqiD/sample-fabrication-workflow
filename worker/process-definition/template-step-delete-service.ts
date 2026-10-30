import { HTTPException } from "hono/http-exception";
import { hashRecipeManifest } from "../../shared/content-addressing";
import { TEMPLATE_STEP_DELETE_PUBLISHED_SQL, TEMPLATE_STEP_DELETE_STATE_SQL, TEMPLATE_STEP_DELETE_STEP_SQL, TEMPLATE_STEP_DELETE_REMAINING_SQL, TEMPLATE_STEP_DELETE_REMOVE_SQL, TEMPLATE_STEP_DELETE_MANIFEST_SQL, type TemplateStepDeleteDatabase } from "./template-step-delete-sql";
function text(value: unknown): string { if (typeof value !== "string") throw new TypeError("Invalid template step SQL text"); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
async function requirePublishedTemplateVersion(db: TemplateStepDeleteDatabase, id: string) {
  if (!await db.prepare(TEMPLATE_STEP_DELETE_PUBLISHED_SQL).bind(id).first()) throw new HTTPException(404, { message: "Template version not found" });
}
/** Full original Worker delete/remaining-manifest algorithm; no asset branch
 * is omitted. Definition/state/File evidence retains its original ownership. */
export async function deleteTemplateStepWithDatabase(db: TemplateStepDeleteDatabase, templateId: string, stepId: string) {
  await requirePublishedTemplateVersion(db, templateId);
  const [template, step, remainingSteps] = await Promise.all([
    db.prepare(TEMPLATE_STEP_DELETE_STATE_SQL)
      .bind(templateId).first(),
    db.prepare(TEMPLATE_STEP_DELETE_STEP_SQL).bind(stepId, templateId).first(),
    db.prepare(TEMPLATE_STEP_DELETE_REMAINING_SQL).bind(templateId, stepId).all(),
  ]);
  if (!template || template.deleted_at || !step) throw new HTTPException(404, { message: "Template step not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  const manifestHash = await hashRecipeManifest(remainingSteps.results.map((entry) => ({
    logicalStepKey: text(entry.logical_step_key),
    definitionHash: text(entry.definition_hash),
    expectedStateHash: nullableText(entry.expected_state_hash),
  })));
  const results = await db.batch([
    db.prepare(TEMPLATE_STEP_DELETE_REMOVE_SQL).bind(stepId, templateId, templateId),
    db.prepare(TEMPLATE_STEP_DELETE_MANIFEST_SQL).bind(manifestHash, templateId),
  ]);
  if (!results[0]!.changes || !results[1]!.changes) {
    throw new HTTPException(409, { message: "This template version was used to start a process run while the step was being deleted. Clone it to continue." });
  }
  return { ok: true as const };
}
export function createTemplateStepDeleteService(capabilities: { database(): TemplateStepDeleteDatabase; admit(actor: string): Promise<void> }) {
  return { async remove(templateId: string, stepId: string, actor: string) {
    await capabilities.admit(actor); const db = capabilities.database(); await capabilities.admit(actor);
    const result = await deleteTemplateStepWithDatabase(db, templateId, stepId);
    await capabilities.admit(actor); return result;
  } };
}
export type TemplateStepDeleteService = ReturnType<typeof createTemplateStepDeleteService>;

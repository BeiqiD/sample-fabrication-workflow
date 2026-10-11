import { HTTPException } from "hono/http-exception";
import { TEMPLATE_LIFECYCLE_PUBLISHED_SQL, TEMPLATE_LIFECYCLE_RENAME_SQL, TEMPLATE_LIFECYCLE_EDIT_STATE_SQL, TEMPLATE_LIFECYCLE_REMOVE_SQL, TEMPLATE_LIFECYCLE_DELETE_STATE_SQL, TEMPLATE_LIFECYCLE_RESTORE_SQL, TEMPLATE_LIFECYCLE_RESTORE_STATE_SQL, type TemplateLifecycleDatabase } from "./template-lifecycle-sql";

/** Original Worker lifecycle algorithms/SQL/binds/current-read/CAS/messages.
 * Native and actual D1 own their distinct exact transport/cell adapters. */
async function requirePublishedTemplateVersion(db: TemplateLifecycleDatabase, id: string) {
  const row = await db.prepare(TEMPLATE_LIFECYCLE_PUBLISHED_SQL).bind(id).first();
  if (!row) throw new HTTPException(404, { message: "Template version not found" });
}

export async function renameTemplateWithDatabase(db: TemplateLifecycleDatabase, id: string, readInput: () => Promise<unknown>) {
  await requirePublishedTemplateVersion(db, id);
  const input = (await readInput()) as { name?: string; version?: number };
  if (typeof input.name !== "string" || typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) throw new HTTPException(400, { message: "A template name and positive integer version are required" });
  const name = input.name.trim();
  if (!name || name.length > 200) throw new HTTPException(400, { message: "Template name is required and must be at most 200 characters" });
  const current = await db.prepare(TEMPLATE_LIFECYCLE_EDIT_STATE_SQL).bind(id).first();
  if (!current) throw new HTTPException(404, { message: "Template version not found" });
  if (current.deleted_at) throw new HTTPException(404, { message: "Template version not found" });
  if (current.archived_at) throw new HTTPException(409, { message: "Archived templates cannot be edited" });
  if (current.locked_at) throw new HTTPException(409, { message: "This template version has been used by a process run and is now locked. Clone it to create an editable version." });
  try {
    const result = await db.prepare(TEMPLATE_LIFECYCLE_RENAME_SQL).bind(name, input.version, id).run();
    if (!result.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: `Version ${input.version} already exists for this template` });
    throw error;
  }
  return { ok: true as const };
}

export async function removeTemplateWithDatabase(db: TemplateLifecycleDatabase, id: string, actor: string, capabilities: { now(): number }) {
  await requirePublishedTemplateVersion(db, id);
  const template = await db.prepare(TEMPLATE_LIFECYCLE_DELETE_STATE_SQL).bind(id).first();
  if (!template || template.archived_at || template.deleted_at) {
    throw new HTTPException(404, { message: "Active template version not found" });
  }

  const now = new Date(capabilities.now()).toISOString();
  const userEmail = actor;
  const archive = Boolean(template.locked_at || template.referenced);
  const result = await db.prepare(TEMPLATE_LIFECYCLE_REMOVE_SQL).bind(now, userEmail, archive ? 1 : 0, now, archive ? 1 : 0, userEmail, id).run();
  if (!result.changes) {
    throw new HTTPException(409, { message: "This template changed while it was being deleted" });
  }
  return { ok: true as const, disposition: archive ? "archived" as const : "deleted" as const };
}

export async function restoreTemplateWithDatabase(db: TemplateLifecycleDatabase, id: string) {
  await requirePublishedTemplateVersion(db, id);
  const template = await db.prepare(TEMPLATE_LIFECYCLE_RESTORE_STATE_SQL).bind(id).first();
  if (!template) throw new HTTPException(404, { message: "Deleted template version not found" });
  const result = await db.prepare(TEMPLATE_LIFECYCLE_RESTORE_SQL).bind(id, template.deleted_at).run();
  if (!result.changes) {
    throw new HTTPException(409, { message: "The template changed while it was being restored" });
  }
  return { ok: true as const };
}

export function createTemplateLifecycleService(capabilities: {
  database(): TemplateLifecycleDatabase; admit(actor: string): Promise<void>; now(): number;
}) {
  const execute = async <T>(actor: string, operation: (db: TemplateLifecycleDatabase) => Promise<T>): Promise<T> => {
    await capabilities.admit(actor); const db = capabilities.database(); await capabilities.admit(actor);
    const result = await operation(db); await capabilities.admit(actor); return result;
  };
  return {
    rename(id: string, readInput: () => Promise<unknown>, actor: string) { return execute(actor, db => renameTemplateWithDatabase(db, id, readInput)); },
    remove(id: string, actor: string) { return execute(actor, db => removeTemplateWithDatabase(db, id, actor, capabilities)); },
    restore(id: string, actor: string) { return execute(actor, db => restoreTemplateWithDatabase(db, id)); },
  };
}
export type TemplateLifecycleService = ReturnType<typeof createTemplateLifecycleService>;

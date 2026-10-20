import { HTTPException } from "hono/http-exception";
import { hashRecipeManifest, hashStepDefinition, stableJson, STEP_HASH_SCHEME } from "../../shared/content-addressing";
import { METROLOGY_DEFINITION_PUBLISHED_SQL, METROLOGY_DEFINITION_INSERT_STEP_SQL, METROLOGY_DEFINITION_INSERT_VERSION_SQL, METROLOGY_DEFINITION_INSERT_DEFINITION_SQL, METROLOGY_DEFINITION_INSERT_FAMILY_SQL, METROLOGY_DEFINITION_UPDATE_STEP_SQL, METROLOGY_DEFINITION_UPDATE_VERSION_SQL, METROLOGY_DEFINITION_SINGLE_STEP_SQL, METROLOGY_DEFINITION_UPDATE_NOTES_SQL, type MetrologyDefinitionDatabase } from "./metrology-definition-sql";
interface DefinitionClock { now(): number }
interface DefinitionClockAndIds extends DefinitionClock { randomId(): string }
function text(value: unknown): string { if (typeof value !== "string") throw new TypeError("Invalid metrology template step SQL text"); return value; }
/** Original field validation, content addressing, SQL/binds and update-result
 * ordinals shared by the actual Worker and owned Node adapters. */
async function requirePublishedTemplateVersion(db: MetrologyDefinitionDatabase, id: string) {
  const row = await db.prepare(METROLOGY_DEFINITION_PUBLISHED_SQL).bind(id).first();
  if (!row) throw new HTTPException(404, { message: "Template version not found" });
}

export async function createMetrologyTemplateWithDatabase(db: MetrologyDefinitionDatabase, readInput: () => Promise<unknown>, actor: string, capabilities: DefinitionClockAndIds) {
  const input = (await readInput()) as {
    name?: string; toolName?: string; parametersText?: string; commentsText?: string;
  };
  if (typeof input.name !== "string" || typeof input.toolName !== "string"
    || typeof input.parametersText !== "string" || typeof input.commentsText !== "string") {
    throw new HTTPException(400, { message: "Valid metrology-template fields are required" });
  }
  const name = input.name.trim();
  const toolName = input.toolName.trim();
  const parametersText = input.parametersText.trim();
  const commentsText = input.commentsText.trim();
  if (!name || name.length > 200 || toolName.length > 500
    || parametersText.length > 10_000 || commentsText.length > 10_000) {
    throw new HTTPException(400, { message: "One or more metrology-template fields are invalid" });
  }
  const definition = await hashStepDefinition({ name, toolName, parametersText, commentsText });
  const familyId = capabilities.randomId();
  const templateId = capabilities.randomId();
  const stepId = capabilities.randomId();
  const logicalKey = `metrology:${stepId}`;
  const manifestHash = await hashRecipeManifest([
    { logicalStepKey: logicalKey, definitionHash: definition.hash, expectedStateHash: null },
  ]);
  const now = new Date(capabilities.now()).toISOString();
  const userEmail = actor;
  try {
    await db.atomicBatch([
      db.prepare(METROLOGY_DEFINITION_INSERT_FAMILY_SQL).bind(familyId, `Metrology template · ${familyId}`, userEmail, now),
      db.prepare(METROLOGY_DEFINITION_INSERT_DEFINITION_SQL).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
        definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
      db.prepare(METROLOGY_DEFINITION_INSERT_VERSION_SQL).bind(templateId, familyId, name, manifestHash, userEmail, now),
      db.prepare(METROLOGY_DEFINITION_INSERT_STEP_SQL).bind(stepId, templateId, logicalKey, definition.hash),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "A metrology template with this title already exists" });
    }
    throw error;
  }
  return { id: templateId, version: 1 as const };
}

export async function updateMetrologyTemplateWithDatabase(db: MetrologyDefinitionDatabase, id: string, readInput: () => Promise<unknown>, capabilities: DefinitionClock) {
  await requirePublishedTemplateVersion(db, id);
  const input = (await readInput()) as {
    name?: string; toolName?: string; parametersText?: string; commentsText?: string;
  };
  if (typeof input.name !== "string" || typeof input.toolName !== "string"
    || typeof input.parametersText !== "string" || typeof input.commentsText !== "string") {
    throw new HTTPException(400, { message: "Valid metrology-template fields are required" });
  }
  const name = input.name.trim();
  const toolName = input.toolName.trim();
  const parametersText = input.parametersText.trim();
  const commentsText = input.commentsText.trim();
  if (!name || name.length > 200 || toolName.length > 500
    || parametersText.length > 10_000 || commentsText.length > 10_000) {
    throw new HTTPException(400, { message: "One or more metrology-template fields are invalid" });
  }
  const selected = await db.prepare(METROLOGY_DEFINITION_SINGLE_STEP_SQL).bind(id).first();
  const template = selected === null ? null : { template_step_id: text(selected.template_step_id), logical_step_key: text(selected.logical_step_key) };
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const definition = await hashStepDefinition({ name, toolName, parametersText, commentsText });
  const manifestHash = await hashRecipeManifest([
    { logicalStepKey: template.logical_step_key, definitionHash: definition.hash, expectedStateHash: null },
  ]);
  const now = new Date(capabilities.now()).toISOString();
  try {
    const results = await db.atomicBatch([
      db.prepare(METROLOGY_DEFINITION_INSERT_DEFINITION_SQL).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
        definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
      db.prepare(METROLOGY_DEFINITION_UPDATE_VERSION_SQL).bind(name, manifestHash, id),
      db.prepare(METROLOGY_DEFINITION_UPDATE_STEP_SQL).bind(definition.hash, template.template_step_id, id),
    ]);
    if (results.slice(1).some((result) => !result.changes)) {
      throw new HTTPException(409, { message: "This metrology template changed while it was being saved" });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "A metrology template with this title already exists" });
    }
    throw error;
  }
  return { ok: true as const };
}

export async function updateMetrologyNotesWithDatabase(db: MetrologyDefinitionDatabase, id: string, readInput: () => Promise<unknown>, capabilities: DefinitionClock) {
  void capabilities;
  await requirePublishedTemplateVersion(db, id);
  const input = (await readInput()) as { notes?: string };
  if (typeof input.notes !== "string" || input.notes.length > 20_000) {
    throw new HTTPException(400, { message: "Equipment or method notes must be at most 20,000 characters" });
  }
  const result = await db.prepare(METROLOGY_DEFINITION_UPDATE_NOTES_SQL).bind(input.notes.trim() || null, id).run();
  if (!result.changes) throw new HTTPException(404, { message: "Metrology template not found" });
  return { ok: true as const };
}

export function createMetrologyDefinitionService(capabilities: {
  database(): MetrologyDefinitionDatabase; admit(actor: string): Promise<void>; now(): number; randomId(): string;
}) {
  const execute = async <T>(actor: string, operation: (db: MetrologyDefinitionDatabase) => Promise<T>): Promise<T> => {
    await capabilities.admit(actor); const db = capabilities.database(); await capabilities.admit(actor);
    const result = await operation(db); await capabilities.admit(actor); return result;
  };
  return {
    create(readInput: () => Promise<unknown>, actor: string) {
      return execute(actor, db => createMetrologyTemplateWithDatabase(db, readInput, actor, capabilities));
    },
    update(id: string, readInput: () => Promise<unknown>, actor: string) {
      return execute(actor, db => updateMetrologyTemplateWithDatabase(db, id, readInput, capabilities));
    },
    notes(id: string, readInput: () => Promise<unknown>, actor: string) {
      return execute(actor, db => updateMetrologyNotesWithDatabase(db, id, readInput, capabilities));
    },
  };
}
export type MetrologyDefinitionService = ReturnType<typeof createMetrologyDefinitionService>;

import { HTTPException } from "hono/http-exception";
import { hashRecipeManifest, hashStateRepresentation, hashStepDefinition, stableJson, STATE_HASH_SCHEME, STEP_HASH_SCHEME } from "../../shared/content-addressing";
import { publishedTemplateVersionSql } from "../template-publication";
import { bulkInsertStatementsWithDatabase } from "../runtime/bulk-insert";
import { fileAuthorityActiveSqlWithDatabase } from "../files/business-lifecycle-service";
import { readReadyAssetInputWithDatabase } from "../files/asset-input-service";
import { consumerFileBindingFenceWithDatabase, resolveConsumerFileIdWithDatabase } from "../files/consumer-binding-service";
import { requirePublishedTemplateVersionWithDatabase } from "./reference-lifecycle-service";
import type { TemplateContentDatabase, TemplateContentStatement } from "./template-content-sql";

/** Complete original clone/create-step/update-step algorithms, SSOT hashing,
 * File binding fences and mutation ACK ordinals. No HTTP or permission issuer. */
export async function cloneTemplateWithDatabase<Statement extends TemplateContentStatement<Statement>>(db: TemplateContentDatabase<Statement>, sourceId: string, actor: string) {
  const active = await fileAuthorityActiveSqlWithDatabase(db) === "1";
  const [source, steps] = await Promise.all([
    db.prepare(
      `SELECT * FROM template_versions tv
       WHERE tv.id = ? AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}`,
    ).bind(sourceId).first<Record<string, unknown>>(),
    db.prepare("SELECT * FROM template_steps WHERE template_version_id = ? ORDER BY position").bind(sourceId).all<Record<string, unknown>>(),
  ]);
  if (!source) throw new HTTPException(404, { message: "Template version not found" });
  const latest = await db.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE recipe_family_id = ?",
  ).bind(source.recipe_family_id).first<{ version: number }>();
  const id = crypto.randomUUID();
  const version = Number(latest?.version ?? 0) + 1;
  const now = new Date().toISOString();
  const userEmail = actor;
  const stepIds = new Map(steps.results.map((step) => [String(step.id), crypto.randomUUID()]));
  const statements: Statement[] = [
    db.prepare(
      `INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, template_kind, version, manifest_hash, initial_state_hash,
         source_filename, source_asset_key${active ? ", source_file_id" : ""}, content_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${active ? ", ?" : ""}, ?, ?, ?)`,
    ).bind(id, source.recipe_family_id, source.name, source.template_type, source.template_kind, version, source.manifest_hash,
      source.initial_state_hash, source.source_filename, source.source_asset_key, ...(active ? [source.source_file_id] : []), source.content_json, userEmail, now),
    ...bulkInsertStatementsWithDatabase(db, "template_steps",
      ["id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json"],
      steps.results.map((step) => [stepIds.get(String(step.id)), id, step.logical_step_key, step.position,
        step.source_row, step.step_number, step.section_name, step.definition_hash, step.expected_state_hash, step.raw_json])),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This template is too large to clone on the current plan" });
  await db.atomicBatch(statements);
  return { id, version };
}


export async function createTemplateStepWithDatabase<Statement extends TemplateContentStatement<Statement>>(db: TemplateContentDatabase<Statement>, templateId: string, readInput: () => Promise<unknown>) {
  await requirePublishedTemplateVersionWithDatabase(db, templateId);
  const input = (await readInput()) as { name?: string; toolName?: string; parametersText?: string; commentsText?: string; assetKey?: string; assetId?: string };
  if (typeof input.name !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid template step fields are required" });
  const name = input.name.trim();
  if (!name || name.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000) throw new HTTPException(400, { message: "One or more template step fields are invalid" });
  const definition = await hashStepDefinition({ name, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [template, existingSteps, asset] = await Promise.all([
    db.prepare(
      "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
    ).bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    db.prepare("SELECT logical_step_key, definition_hash, expected_state_hash, position FROM template_steps WHERE template_version_id = ? ORDER BY position")
      .bind(templateId).all<{ logical_step_key: string; definition_hash: string; expected_state_hash: string | null; position: number }>(),
    readReadyAssetInputWithDatabase(db, input),
  ]);
  if (!template || template.deleted_at) throw new HTTPException(404, { message: "Template version not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  if ((input.assetKey || input.assetId) && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const fileId = asset ? await resolveConsumerFileIdWithDatabase(db, { assetId: asset.id, nativeAsset: asset.r2_key === null, purpose: "embedded_content" }) : null;
  const stepId = crypto.randomUUID();
  const now = new Date().toISOString();
  const state = asset ? await hashStateRepresentation([asset.sha256]) : null;
  const expectedStateHash = state?.hash ?? existingSteps.results.at(-1)?.expected_state_hash ?? null;
  const logicalKey = `manual:${stepId}`;
  const manifestHash = await hashRecipeManifest([
    ...existingSteps.results.map((step) => ({ logicalStepKey: step.logical_step_key, definitionHash: step.definition_hash, expectedStateHash: step.expected_state_hash })),
    { logicalStepKey: logicalKey, definitionHash: definition.hash, expectedStateHash },
  ]);
  const statements = [
    db.prepare(
      `INSERT OR IGNORE INTO step_definitions
       (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
      definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
  ];
  if (asset) statements.unshift(consumerFileBindingFenceWithDatabase(db, { assetId: asset.id, nativeAsset: asset.r2_key === null, purpose: "embedded_content" }, fileId));
  if (state) statements.push(db.prepare(
    `INSERT OR IGNORE INTO state_representations (hash, hash_scheme, representation_type, content_json, created_at)
     VALUES (?, ?, 'diagram', ?, ?)`,
  ).bind(state.hash, STATE_HASH_SCHEME, stableJson(state.canonical), now));
  if (state && asset) statements.push(db.prepare(
    `INSERT OR IGNORE INTO state_representation_assets (state_hash, asset_id, position, file_id)
     SELECT ?, ?, 0, ? WHERE NOT EXISTS (
       SELECT 1 FROM state_representation_assets
       WHERE state_hash = ? AND asset_id = ? AND position = 0 AND file_id IS ?
     )`,
  ).bind(state.hash, asset.id, fileId, state.hash, asset.id, fileId));
  statements.push(db.prepare(
    `INSERT INTO template_steps
     (id, template_version_id, logical_step_key, position, definition_hash, expected_state_hash)
     SELECT ?, id, ?, ?, ?, ? FROM template_versions
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(stepId, logicalKey, Number(existingSteps.results.at(-1)?.position ?? -1) + 1, definition.hash, expectedStateHash, templateId));
  statements.push(db.prepare(
    `UPDATE template_versions SET manifest_hash = ?
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(manifestHash, templateId));
  const results = await db.atomicBatch(statements);
  if (!results[results.length - 2].meta.changes || !results.at(-1)?.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  return { id: stepId };
}


export async function updateTemplateStepWithDatabase<Statement extends TemplateContentStatement<Statement>>(db: TemplateContentDatabase<Statement>, templateId: string, stepId: string, readInput: () => Promise<unknown>) {
  await requirePublishedTemplateVersionWithDatabase(db, templateId);
  const input = (await readInput()) as { name?: string; toolName?: string; parametersText?: string; commentsText?: string; assetKey?: string; assetId?: string };
  if (typeof input.name !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid template step fields are required" });
  const name = input.name.trim();
  if (!name || name.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000) throw new HTTPException(400, { message: "One or more template step fields are invalid" });
  const definition = await hashStepDefinition({ name, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [template, step, allSteps, asset] = await Promise.all([
    db.prepare(
      "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
    ).bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    db.prepare("SELECT id, logical_step_key, expected_state_hash FROM template_steps WHERE id = ? AND template_version_id = ?")
      .bind(stepId, templateId).first<{ id: string; logical_step_key: string; expected_state_hash: string | null }>(),
    db.prepare("SELECT id, logical_step_key, definition_hash, expected_state_hash FROM template_steps WHERE template_version_id = ? ORDER BY position")
      .bind(templateId).all<{ id: string; logical_step_key: string; definition_hash: string; expected_state_hash: string | null }>(),
    readReadyAssetInputWithDatabase(db, input),
  ]);
  if (!template || template.deleted_at || !step) throw new HTTPException(404, { message: "Template step not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  if ((input.assetKey || input.assetId) && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const fileId = asset ? await resolveConsumerFileIdWithDatabase(db, { assetId: asset.id, nativeAsset: asset.r2_key === null, purpose: "embedded_content" }) : null;
  const now = new Date().toISOString();
  const state = asset ? await hashStateRepresentation([asset.sha256]) : null;
  const expectedStateHash = state?.hash ?? step.expected_state_hash;
  const manifestHash = await hashRecipeManifest(allSteps.results.map((entry) => ({
    logicalStepKey: entry.logical_step_key,
    definitionHash: entry.id === stepId ? definition.hash : entry.definition_hash,
    expectedStateHash: entry.id === stepId ? expectedStateHash : entry.expected_state_hash,
  })));
  const statements = [db.prepare(
    `INSERT OR IGNORE INTO step_definitions
     (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
    definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now)];
  if (asset) statements.unshift(consumerFileBindingFenceWithDatabase(db, { assetId: asset.id, nativeAsset: asset.r2_key === null, purpose: "embedded_content" }, fileId));
  if (state) statements.push(db.prepare(
    `INSERT OR IGNORE INTO state_representations (hash, hash_scheme, representation_type, content_json, created_at)
     VALUES (?, ?, 'diagram', ?, ?)`,
  ).bind(state.hash, STATE_HASH_SCHEME, stableJson(state.canonical), now));
  if (state && asset) statements.push(db.prepare(
    `INSERT OR IGNORE INTO state_representation_assets (state_hash, asset_id, position, file_id)
     SELECT ?, ?, 0, ? WHERE NOT EXISTS (
       SELECT 1 FROM state_representation_assets
       WHERE state_hash = ? AND asset_id = ? AND position = 0 AND file_id IS ?
     )`,
  ).bind(state.hash, asset.id, fileId, state.hash, asset.id, fileId));
  statements.push(db.prepare(
    `UPDATE template_steps SET definition_hash = ?, expected_state_hash = ?
     WHERE id = ? AND template_version_id = ? AND EXISTS (
       SELECT 1 FROM template_versions
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
     )`,
  ).bind(definition.hash, expectedStateHash, stepId, templateId, templateId));
  statements.push(db.prepare(
    `UPDATE template_versions SET manifest_hash = ?
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(manifestHash, templateId));
  const results = await db.atomicBatch(statements);
  if (!results[results.length - 2].meta.changes || !results.at(-1)?.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  return { ok: true };
}

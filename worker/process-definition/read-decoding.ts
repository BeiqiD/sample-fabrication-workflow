import type { ReadSqlRow } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid template SQL text: ${field}`);
  return value;
}
function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}
function templateType(value: unknown): "process" | "module" | "recipe" {
  if (value !== "process" && value !== "module" && value !== "recipe") throw new TypeError("Invalid template SQL type");
  return value;
}
function templateKind(value: unknown): "process" | "metrology" {
  if (value !== "process" && value !== "metrology") throw new TypeError("Invalid template SQL kind");
  return value;
}
/** Only the consumed fields are decoded. The real adapter preserves exact
 * unconsumed BigInt/blob cells; no whole-row number conversion or assertion. */
export function templateReadFamilyOptionRow(row: ReadSqlRow) {
  return { recipe_family_id: text(row.recipe_family_id, "recipeFamily.id"), name: text(row.name, "template.name"),
    version: configurationSqlInteger(row.version, "template.version", 1) };
}
export function templateReadDirectoryRow(row: ReadSqlRow) {
  return { ...templateReadFamilyOptionRow(row), id: text(row.id, "template.id"), template_type: templateType(row.template_type),
    source_filename: nullableText(row.source_filename, "template.sourceFilename"),
    step_count: configurationSqlInteger(row.step_count, "template.stepCount"),
    initial_state_hash: nullableText(row.initial_state_hash, "template.initialStateHash"),
    has_initial_substrate_step: configurationSqlInteger(row.has_initial_substrate_step, "template.hasInitialSubstrateStep"),
    initial_asset_count: configurationSqlInteger(row.initial_asset_count, "template.initialStateImageCount"),
    locked_at: nullableText(row.locked_at, "template.lockedAt"), created_at: text(row.created_at, "template.createdAt"),
    version_count: configurationSqlInteger(row.version_count ?? 1, "recipeFamily.versionCount", 1) };
}
export function templateReadMetrologyRow(row: ReadSqlRow) {
  return { id: text(row.id, "template.id"), name: text(row.name, "template.name"), created_at: text(row.created_at, "template.createdAt"),
    tool_name: nullableText(row.tool_name, "template.toolName"),
    has_default_content: configurationSqlInteger(row.has_default_content, "metrologyTemplate.hasDefaultContent") };
}
export function templateReadListRow(row: ReadSqlRow) {
  return { ...templateReadFamilyOptionRow(row), id: text(row.id, "template.id"), template_type: templateType(row.template_type),
    template_kind: templateKind(row.template_kind), manifest_hash: text(row.manifest_hash, "template.manifestHash"),
    source_filename: nullableText(row.source_filename, "template.sourceFilename"),
    initial_state_hash: nullableText(row.initial_state_hash, "template.initialStateHash"),
    content_json: nullableText(row.content_json, "template.contentJson"),
    created_at: text(row.created_at, "template.createdAt"), locked_at: nullableText(row.locked_at, "template.lockedAt"),
    step_count: configurationSqlInteger(row.step_count, "template.stepCount"),
    tool_name: nullableText(row.tool_name, "template.toolName"), parameters_text: nullableText(row.parameters_text, "template.parametersText"),
    comments_text: nullableText(row.comments_text, "template.commentsText") };
}
export function templateReadAssetRow(row: ReadSqlRow) {
  return { asset_id: text(row.asset_id, "templateAsset.assetId"), r2_key: nullableText(row.r2_key, "templateAsset.legacyKey"),
    file_id: nullableText(row.file_id, "templateAsset.fileId"),
    template_version_id: row.template_version_id === undefined ? "" : text(row.template_version_id, "templateAsset.templateId"),
    template_step_id: row.template_step_id === undefined ? "" : text(row.template_step_id, "templateAsset.stepId") };
}
export function templateReadReferenceRow(row: ReadSqlRow) {
  return { ...templateReadAssetRow(row), id: text(row.id, "metrologyReference.id"), display_name: text(row.display_name, "metrologyReference.filename"),
    mime_type: text(row.mime_type, "metrologyReference.mimeType"), byte_size: configurationSqlInteger(row.byte_size, "metrologyReference.byteSize"),
    created_at: text(row.created_at, "metrologyReference.createdAt") };
}

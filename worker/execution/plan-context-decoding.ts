import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";
function text(value: ReadSqlCell | undefined, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid plan SQL text: ${field}`);
  return value;
}
function nullableText(value: ReadSqlCell | undefined, field: string): string | null {
  return value === null ? null : text(value, field);
}
function position(value: ReadSqlCell | undefined, field: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new TypeError(`Invalid plan SQL position: ${field}`);
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number)
    || typeof value === "bigint" && (!Number.isSafeInteger(number) || BigInt(number) !== value)) throw new RangeError(`Plan SQL position outside exact range: ${field}`);
  return number;
}
function origin(value: ReadSqlCell | undefined): "template" | "ad_hoc" {
  if (value !== "template" && value !== "ad_hoc") throw new TypeError("Invalid plan SQL origin");
  return value;
}
export function planRunRow(row: ReadSqlRow) {
  return { id: text(row.id, "run.id"), status: text(row.status, "run.status"), recipe_family_id: text(row.recipe_family_id, "run.recipeFamilyId"),
    current_plan_revision_id: text(row.current_plan_revision_id, "run.currentPlanRevisionId"),
    revision_no: configurationSqlInteger(row.revision_no, "plan.revision", 1),
    current_template_version_id: text(row.current_template_version_id, "plan.currentTemplateVersionId"),
    current_template_version_number: configurationSqlInteger(row.current_template_version_number, "plan.currentTemplateVersion", 1) };
}
export function planTemplateRow(row: ReadSqlRow) {
  return { id: text(row.id, "template.id"), recipe_family_id: text(row.recipe_family_id, "template.recipeFamilyId"),
    name: text(row.name, "template.name"), template_type: text(row.template_type, "template.type"),
    version: configurationSqlInteger(row.version, "template.version", 1),
    initial_state_hash: nullableText(row.initial_state_hash, "template.initialStateHash"), content_json: nullableText(row.content_json, "template.contentJson") };
}
export function planExistingStepRow(row: ReadSqlRow) {
  const actualized = configurationSqlInteger(row.actualized, "runStep.actualized");
  if (actualized !== 0 && actualized !== 1) throw new TypeError("Invalid plan SQL actualized flag");
  return { id: text(row.id, "runStep.id"), name: text(row.name, "runStep.name"),
    logicalStepKey: nullableText(row.logical_step_key, "runStep.logicalStepKey"), definitionHash: nullableText(row.definition_hash, "runStep.definitionHash"),
    position: position(row.position, "runStep.position"), alignmentPosition: position(row.alignment_position, "runStep.alignmentPosition"),
    actualized: Boolean(actualized), origin: origin(row.origin) };
}
export function planNextStepRow(row: ReadSqlRow) {
  return { id: text(row.id, "templateStep.id"), name: text(row.name, "templateStep.name"),
    logicalStepKey: text(row.logical_step_key, "templateStep.logicalStepKey"), definitionHash: text(row.definition_hash, "templateStep.definitionHash"),
    expectedStateHash: nullableText(row.expected_state_hash, "templateStep.expectedStateHash"), position: position(row.position, "templateStep.position") };
}

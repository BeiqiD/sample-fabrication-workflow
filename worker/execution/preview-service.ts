import { HTTPException } from "hono/http-exception";
import { nativeAssetUrl } from "../../shared/contracts/r2-upload";
import { configurationSqlCell, configurationSqlInteger } from "../runtime/configuration-sql";
import type { ReadSqlRow } from "../runtime/read-sql";
import { loadCurrentSampleStructureSql, stateAssetsSql, type SampleStructureReadCapabilities } from "../application/sample-structure-read";
import { loadPlanContextSql } from "./plan-context-read";
import { alignFuturePlan } from "./plan-alignment";
import { resolvePlanUpdateStructureTarget } from "../plan-update";
import { parseInitialSubstrateStep } from "../process-definition/substrate";

export interface ExecutionPreviewCapabilities extends SampleStructureReadCapabilities {
  /** Genuine current original Request/actor/control admission before and after
   * reads. This capability does not grant mutations, bytes, or File roles. */
  admit(actor: string): Promise<void>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid preview SQL text: ${field}`);
  return value;
}
function nullableText(value: unknown, field: string): string | null { return value === null ? null : text(value, field); }
function previewLatestRunRow(row: ReadSqlRow) { return { id: text(row.id, "latestRun.id"), status: text(row.status, "latestRun.status") }; }
function previewSampleRow(row: ReadSqlRow) { return { updated_at: text(row.updated_at, "sample.updatedAt") }; }
function previewTemplateRow(row: ReadSqlRow) {
  return { id: text(row.id, "template.id"), name: text(row.name, "template.name"),
    version: configurationSqlInteger(row.version, "template.version", 1),
    initial_state_hash: nullableText(row.initial_state_hash, "template.initialStateHash"), content_json: nullableText(row.content_json, "template.contentJson") };
}
function templateInput(input: unknown, message: string): string | number {
  // Preserve the mature truthiness guard/bind semantics; a malformed non-cell
  // is an internal parse/bind failure, not invented authorization or fallback.
  if (input === null || input === undefined) throw new TypeError("Invalid preview request body");
  const value = typeof input === "object" && "templateVersionId" in input ? input.templateVersionId : undefined;
  if (!value) throw new HTTPException(400, { message });
  if (typeof value !== "string" && typeof value !== "number") throw new TypeError("Invalid preview template binding");
  configurationSqlCell(value);
  return value;
}

function compareSubstrateStructures(
  previousStateHash: string | null,
  previousImageHashes: string[],
  templateStateHash: string | null,
  templateImageHashes: string[],
): "same" | "different" | "no_previous_structure" | "not_comparable" {
  if (!previousStateHash) return "no_previous_structure";
  if (previousStateHash === templateStateHash) return "same";
  if (!previousImageHashes.length || !templateImageHashes.length) return "not_comparable";
  return previousImageHashes.length === templateImageHashes.length
    && previousImageHashes.every((hash, index) => hash === templateImageHashes[index])
    ? "same"
    : "different";
}

async function startPreview(capabilities: ExecutionPreviewCapabilities, sampleId: string, input: unknown, actor: string) {
  const templateVersionId = templateInput(input, "A process-template version is required");
  await capabilities.admit(actor);
  const db = capabilities.database();
  const [sample, template, latestRun, currentState] = await Promise.all([
    db.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first(),
    db.prepare(
      `SELECT id, name, version, initial_state_hash, content_json
       FROM template_versions
       WHERE id = ? AND template_kind = 'process' AND archived_at IS NULL
         AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = template_versions.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first(),
    db.prepare(
      "SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1",
    ).bind(sampleId).first(),
    loadCurrentSampleStructureSql(capabilities, sampleId),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const selectedLatestRun = latestRun === null ? null : previewLatestRunRow(latestRun);
  const selectedTemplate = template === null ? null : previewTemplateRow(template);
  if (!selectedTemplate) throw new HTTPException(404, { message: "Process-template version not found" });
  if (selectedLatestRun?.status === "active") {
    throw new HTTPException(409, { message: "Finish the active process run or update its process template instead." });
  }
  const templateAssets = await stateAssetsSql(capabilities, selectedTemplate.initial_state_hash);
  const initialSubstrateStep = parseInitialSubstrateStep(selectedTemplate.content_json);
  const canConfirm = Boolean(selectedTemplate.initial_state_hash && initialSubstrateStep);
  const result = {
    successor: Boolean(selectedLatestRun),
    sampleUpdatedAt: previewSampleRow(sample).updated_at,
    expectedLatestRunId: selectedLatestRun?.id ?? null,
    comparison: compareSubstrateStructures(
      currentState.stateHash,
      currentState.imageHashes,
      selectedTemplate.initial_state_hash,
      templateAssets.map((asset) => asset.sha256),
    ),
    canConfirm,
    blockingReason: canConfirm ? null : "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before starting a run.",
    comparisonTarget: canConfirm ? {
      kind: "initial_substrate" as const,
      key: `initial-substrate:${selectedTemplate.id}`,
      stateHash: selectedTemplate.initial_state_hash,
      imageKeys: templateAssets.flatMap(asset => asset.r2_key === null ? [] : [asset.r2_key]),
      ...(templateAssets.some(asset => asset.r2_key === null) ? { images: templateAssets.flatMap(asset => asset.r2_key === null
        ? [{ assetId: asset.assetId, fileId: asset.file_id, url: nativeAssetUrl(asset.assetId) }] : []) } : {}),
      stepId: null,
      stepTitle: initialSubstrateStep!.name,
    } : null,
    template: {
      id: selectedTemplate.id,
      name: selectedTemplate.name,
      version: selectedTemplate.version,
      initialSubstrateStep,
    },
    sampleCurrentState: {
      hash: currentState.stateHash,
      stepTitle: currentState.stepTitle,
      imageKeys: currentState.imageKeys,
      ...(currentState.images ? { images: currentState.images } : {}),
    },
  };
  await capabilities.admit(actor);
  return result;
}

async function planUpdatePreview(capabilities: ExecutionPreviewCapabilities, sampleId: string, runId: string, input: unknown, actor: string) {
  const templateVersionId = templateInput(input, "A template version is required");
  await capabilities.admit(actor);
  const db = capabilities.database();
  const context = await loadPlanContextSql(db, sampleId, runId, templateVersionId);
  const [sample, latestRun, currentState] = await Promise.all([
    db.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first(),
    db.prepare("SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1")
      .bind(sampleId).first(),
    loadCurrentSampleStructureSql(capabilities, sampleId),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const selectedLatestRun = latestRun === null ? null : previewLatestRunRow(latestRun);
  const sameFamily = context.run.recipe_family_id === context.nextTemplate.recipe_family_id;
  const isNewerVersion = context.nextTemplate.version > Number(context.run.current_template_version_number);
  const alignment = sameFamily ? alignFuturePlan(context.existing, context.next) : {
    matches: [], additions: [], supersededStepIds: [], historicalDifferences: [],
  };
  const canReopen = context.run.status === "complete" && selectedLatestRun?.id === runId;
  const lifecycleAllowed = context.run.status === "active" || canReopen;
  const pendingAdditions = alignment.additions.filter((step) => step.initialStatus === "pending");
  const hasFutureWork = context.run.status === "active" || pendingAdditions.length > 0;
  const initialSubstrateStep = parseInitialSubstrateStep(context.nextTemplate.content_json);
  const hasInitialSubstrate = Boolean(context.nextTemplate.initial_state_hash && initialSubstrateStep);
  const comparisonTarget = sameFamily ? resolvePlanUpdateStructureTarget(
    alignment,
    currentState.stepId,
    context.next,
    {
      templateVersionId: String(templateVersionId),
      stateHash: context.nextTemplate.initial_state_hash,
      valid: hasInitialSubstrate,
    },
  ) : null;
  const comparisonAssets = await stateAssetsSql(capabilities, comparisonTarget?.stateHash ?? null);
  const hasComparisonTarget = Boolean(comparisonTarget);
  const blockingReason = !sameFamily
    ? "An in-place update must use another version of the same process template."
    : !isNewerVersion
      ? "Choose a newer version of this process template."
    : !lifecycleAllowed
      ? "Only an active run or the latest completed run can be updated."
      : !hasFutureWork
        ? "This version adds no future work after the completed run."
        : !hasComparisonTarget
          ? currentState.stepId
            ? "The step that produced the current structure could not be matched in this template version."
            : "This process-template version has no valid Step 0: Substrate Stack snapshot."
          : null;
  const result = {
    compatible: blockingReason === null,
    blockingReason,
    currentTemplateVersionId: context.run.current_template_version_id,
    nextTemplateVersionId: templateVersionId,
    canReopen,
    substrateTransition: {
      successor: false,
      sampleUpdatedAt: previewSampleRow(sample).updated_at,
      expectedLatestRunId: selectedLatestRun?.id ?? null,
      comparison: compareSubstrateStructures(
        currentState.stateHash,
        currentState.imageHashes,
        comparisonTarget?.stateHash ?? null,
        comparisonAssets.map((asset) => asset.sha256),
      ),
      canConfirm: hasComparisonTarget,
      blockingReason: hasComparisonTarget ? null : currentState.stepId
        ? "The current structure-producing step has no match in this template version. Review the step alignment before updating the run."
        : "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before updating the run.",
      comparisonTarget: comparisonTarget ? {
        ...comparisonTarget,
        imageKeys: comparisonAssets.flatMap(asset => asset.r2_key === null ? [] : [asset.r2_key]),
        ...(comparisonAssets.some(asset => asset.r2_key === null) ? { images: comparisonAssets.flatMap(asset => asset.r2_key === null
          ? [{ assetId: asset.assetId, fileId: asset.file_id, url: nativeAssetUrl(asset.assetId) }] : []) } : {}),
      } : null,
      template: {
        id: context.nextTemplate.id,
        name: context.nextTemplate.name,
        version: context.nextTemplate.version,
        initialSubstrateStep,
      },
      sampleCurrentState: {
        hash: currentState.stateHash,
        stepTitle: currentState.stepTitle,
        imageKeys: currentState.imageKeys,
      ...(currentState.images ? { images: currentState.images } : {}),
      },
    },
    preservedCount: alignment.matches.length,
    additionCount: alignment.additions.length,
    skippedAdditionCount: alignment.additions.length - pendingAdditions.length,
    supersededCount: alignment.supersededStepIds.length,
    historicalDifferences: alignment.historicalDifferences,
    familyMismatch: !sameFamily,
  };
  await capabilities.admit(actor);
  return result;
}

export function createExecutionPreviewService(capabilities: ExecutionPreviewCapabilities) {
  return {
    start: (sampleId: string, input: unknown, actor: string) => startPreview(capabilities, sampleId, input, actor),
    planUpdate: (sampleId: string, runId: string, input: unknown, actor: string) => planUpdatePreview(capabilities, sampleId, runId, input, actor),
  };
}
export type ExecutionPreviewService = ReturnType<typeof createExecutionPreviewService>;

import type { FilePurpose } from "../../shared/contracts/files";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import { researchRecordsDocument, type ResearchDomainRecord, type ResearchPackageV1, type ResearchPackageFile } from "../../shared/contracts/research-package";
import { hashRecipeManifest, hashStateRepresentation, hashStepDefinition, sha256Hex, stableJson } from "../../shared/domain/content-addressing";
import { REFERENCE_IMPORT_KINDS } from "./import-domain-identity";

export const IMPORT_FIXTURE_AT = "2026-10-06T09:00:00.000Z";
export const IMPORT_FIXTURE_ACTOR = "foreign-research-author@example.test";

function row(kind: ResearchRecordKind, sourceId: string, override: Record<string, unknown> = {}): ResearchDomainRecord {
  const definition = RESEARCH_PACKAGE_CATALOG[kind], at = IMPORT_FIXTURE_AT;
  const data = Object.fromEntries(Object.entries(definition.fields).map(([field, rule]) => [field,
    rule.nullable ? null : rule.type === "integer" ? 1 : rule.type === "number" ? 0 : rule.type === "json" ? {}
      : field.endsWith("_at") ? at : field.endsWith("_by") || field === "actor_email" ? IMPORT_FIXTURE_ACTOR : "fixture"]));
  Object.assign(data, override);
  return { kind, sourceId, sourceRevision: { scheme: definition.revision.scheme,
    value: definition.revision.scheme === "integer" ? Number(data[definition.revision.field!])
      : definition.revision.scheme === "contentHash" ? sourceId
      : definition.revision.scheme === "timestamp" ? String(data[definition.revision.field!]) : at }, data };
}

/** One shared, nonempty public fixture for planner and native whole-flow tests.
 * IDs are deliberately foreign; ordinary prose containing them stays literal.
 * Payload aliases are distinct even for equal bytes. No SQL/provider address or
 * executable source acceptance is embedded in the package. */
export async function buildImportDomainFixture(): Promise<{ package: ResearchPackageV1; payloads: Map<string, Uint8Array> }> {
  const at = IMPORT_FIXTURE_AT, actor = IMPORT_FIXTURE_ACTOR;
  const files: ResearchPackageFile[] = [], payloads = new Map<string, Uint8Array>(), aliases: ResearchDomainRecord[] = [];
  const file = async (name: string, purpose: FilePurpose, value = name, withAlias = true) => {
    const bytes = new TextEncoder().encode(`Verified isolated fixture bytes: ${value}`), packageFileId = `logical-${name}`, sha256 = await sha256Hex(bytes.slice().buffer);
    files.push({ packageFileId, path: `files/${packageFileId}`, purpose, sha256, byteSize: bytes.byteLength, mediaType: purpose === "provenance" ? "application/octet-stream" : "image/png" });
    payloads.set(packageFileId, bytes);
    const asset = `asset:foreign-${name}`;
    if (withAlias) aliases.push(row("fileAlias", asset, { alias_kind: "asset", packageFileId, original_name: `${name}.png`, mime_type: "image/png", byte_size: bytes.byteLength, sha256 }));
    return { packageFileId, asset, sha256, byteSize: bytes.byteLength };
  };
  const stateOne = await file("state-one", "embedded_content", "ordered equal State bytes"), stateTwo = await file("state-two", "embedded_content", "ordered equal State bytes");
  // Alias presentation is independent of verified File content metadata. Keep
  // this historical MIME label rather than replacing it with File mediaType.
  Object.assign(aliases.find(alias => alias.sourceId === stateTwo.asset)!.data, { original_name: "original-second-state.png", mime_type: "image/x-png" });
  const executionOld = await file("execution-old", "embedded_content"), executionNew = await file("execution-new", "embedded_content");
  const metrologyOld = await file("metrology-old", "research_source"), metrologyNew = await file("metrology-new", "research_source");
  const occurrence = await file("occurrence", "embedded_content"), evidence = await file("evidence", "embedded_content");
  const original = await file("comment-original", "research_source"), preview = await file("comment-preview", "derived_preview");
  Object.assign(aliases.find(alias => alias.sourceId === original.asset)!.data, { original_name: "original.tif", mime_type: "image/tiff" });
  files.find(file => file.packageFileId === original.packageFileId)!.mediaType = "image/tiff";
  const attachment = await file("project-attachment", "research_source"), event = await file("event", "embedded_content"), thumbnail = await file("event-thumbnail", "derived_preview");
  const workbook = await file("workbook", "provenance", "original workbook", false), manifest = await file("manifest", "provenance", "source manifest", false);
  const state = await hashStateRepresentation([stateOne.sha256, stateTwo.sha256]);
  const definition = await hashStepDefinition({ name: "Exact immutable step", toolName: "Fixture tool", parametersText: "foreign-run-one is ordinary parameter text", commentsText: "Original researcher note" });
  const manifestHash = await hashRecipeManifest([{ logicalStepKey: "step:one", definitionHash: definition.hash, expectedStateHash: state.hash }]);
  const records: ResearchDomainRecord[] = [
    row("project", "foreign-project", { title: "Imported Project history", revision: 8, next_created_sequence: 12, last_mutation_id: "project-final-mutation" }),
    row("sample", "foreign-sample", { code: "IMPORTED-SAMPLE", title: "foreign-run-one remains literal title", status: "stored", pinned: 0, inherited_state_hash: state.hash }),
    row("recipeFamily", "foreign-family", { name: "Imported recipe family", template_type: "module" }),
    row("recipeRevision", "foreign-recipe", { recipe_family_id: "foreign-family", name: "Imported recipe", template_type: "module", version: 3,
      manifest_hash: manifestHash, initial_state_hash: state.hash, source_filename: "original.xlsx", sourcePackageFileId: workbook.packageFileId,
      content_json: { initialSubstrateStep: null, provenance: { schemaVersion: 1, importedTitle: "Imported recipe", objectKind: "module", warningCount: 0 } },
      template_kind: "process", locked_at: "2020-01-01T00:00:00.000Z", locked_by: actor, archived_at: at, archived_by: actor }),
    row("stepDefinition", definition.hash, { hash_scheme: "step-definition/v1", name: "Exact immutable step", tool_name: "Fixture tool",
      parameters_text: "foreign-run-one is ordinary parameter text", comments_text: "Original researcher note", canonical_json: definition.canonical }),
    row("state", state.hash, { hash_scheme: "state-diagram/v1", representation_type: "diagram", content_json: state.canonical }),
    row("templateStep", "foreign-template-step", { template_version_id: "foreign-recipe", logical_step_key: "step:one", position: 0, definition_hash: definition.hash, expected_state_hash: state.hash, raw_json: { userText: "foreign-sample" } }),
    ...["one", "two"].map((id, index) => row("run", `foreign-run-${id}`, { sample_id: "foreign-sample", recipe_family_id: "foreign-family", template_version_id: "foreign-recipe",
      current_plan_revision_id: `foreign-plan-${id}`, predecessor_run_id: `foreign-run-${index ? "one" : "two"}`, anchor_step_id: `foreign-step-${id}`, sequence_no: index + 1,
      run_group_id: "foreign-shared-run-group", template_name_snapshot: "Original recipe name", template_type_snapshot: "module", template_version_snapshot: 3,
      status: index ? "superseded" : "active", run_kind: "process", initial_state_hash: state.hash, deleted_at: index ? at : null, deleted_by: index ? actor : null })),
    ...["one", "two"].map(id => row("runPlanRevision", `foreign-plan-${id}`, { run_id: `foreign-run-${id}`, revision_no: 1,
      template_version_id: "foreign-recipe", effective_after_step_id: `foreign-step-${id}`, reason: "Preserved source plan", actor_email: actor })),
    ...["one", "two"].map((id, index) => row("runStep", `foreign-step-${id}`, { run_id: `foreign-run-${id}`, previous_step_id: `foreign-step-${id}-tail`, position: 0,
      origin: "template", plan_status: index ? "superseded" : "current", template_step_id: "foreign-template-step", logical_step_key: "step:one", definition_hash: definition.hash,
      expected_state_hash: state.hash, title: "Preserved step", status: index ? "skipped" : "done", entry_kind: "fabrication", notes: "foreign-step-two is literal history text" })),
    ...["one", "two"].map(id => row("runStep", `foreign-step-${id}-tail`, { run_id: `foreign-run-${id}`, previous_step_id: `foreign-step-${id}`, position: 1,
      origin: "ad_hoc", plan_status: "superseded", definition_hash: definition.hash, expected_state_hash: state.hash, title: "Cyclic historical step", status: "skipped", entry_kind: "fabrication" })),
    ...["one", "two"].map(id => row("runStepPlanLink", JSON.stringify([`foreign-plan-${id}`, "foreign-template-step", `foreign-step-${id}`]), {
      run_plan_revision_id: `foreign-plan-${id}`, template_step_id: "foreign-template-step", run_step_id: `foreign-step-${id}`, relation: "historical" })),
    row("comment", "foreign-common-comment", { context_kind: "run_steps", scope: "common", body: "One canonical Common Comment body", status: "ready", completed_at: at,
      retry_closed_at: at, retry_closed_by: actor, excluded_targets: [] }),
    ...["one", "two"].map(id => row("commentTarget", JSON.stringify(["foreign-common-comment", `foreign-step-${id}`]), { submission_id: "foreign-common-comment", sample_id: "foreign-sample",
      run_id: `foreign-run-${id}`, run_step_id: `foreign-step-${id}`, expected_updated_at: at })),
    // Preview comes first in the public array: publisher must order originals
    // before their previews while retaining the cyclic related-item identities.
    row("commentItem", "foreign-comment-preview", { submission_id: "foreign-common-comment", kind: "comment_image", status: "ready", position: 1,
      filename: "preview.png", mime_type: "image/png", byte_size: preview.byteSize, asset_id: preview.asset, packageFileId: preview.packageFileId, sha256: preview.sha256, related_item_id: "foreign-comment-original" }),
    row("commentItem", "foreign-comment-original", { submission_id: "foreign-common-comment", kind: "attachment", status: "ready", position: 0,
      filename: "original.tif", mime_type: "image/tiff", byte_size: original.byteSize, asset_id: original.asset, packageFileId: original.packageFileId, sha256: original.sha256, related_item_id: "foreign-comment-preview" }),
    ...["one", "two"].map((id, index) => row("commentOccurrence", `foreign-occurrence-${id}`, { run_step_id: `foreign-step-${id}`, scope: "common", operation_group_id: "foreign-common-comment",
      submission_id: "foreign-common-comment", asset_id: index ? null : occurrence.asset, packageFileId: index ? null : occurrence.packageFileId,
      legacy_body: null, updated_at: at, deleted_at: index ? at : null, deleted_by: index ? actor : null,
      deletion_operation_id: index ? "foreign-delete-comment" : null })),
    row("commentOccurrence", "foreign-legacy-occurrence", { run_step_id: "foreign-step-one", scope: "individual", legacy_body: "Legacy occurrence body remains source text", updated_at: at }),
    ...[[stateOne, 0], [stateTwo, 1]].map(([file, index]) => {
      const f = file as typeof stateOne; return row("stateAsset", JSON.stringify([state.hash, f.asset]), { state_hash: state.hash, asset_id: f.asset, position: index, packageFileId: f.packageFileId });
    }),
    ...["one", "two"].map((id, index) => row("stateVerification", `foreign-verification-${id}`, { sample_id: "foreign-sample", after_run_step_id: `foreign-step-${id}`,
      previous_verification_id: `foreign-verification-${index ? "one" : "two"}`, run_plan_revision_id: `foreign-plan-${id}`, expected_state_hash: state.hash,
      result: index ? "mismatched" : "matched", status: index ? "stale" : "valid", evidence_asset_id: index ? null : evidence.asset,
      evidencePackageFileId: index ? null : evidence.packageFileId, note: "Foreign observation retained without recomputation" })),
    ...["one", "two"].map(id => row("verificationStep", JSON.stringify([`foreign-verification-${id}`, `foreign-step-${id}`]), { verification_id: `foreign-verification-${id}`, run_step_id: `foreign-step-${id}`, ordinal: 0 })),
    ...[[executionOld, "old", executionNew], [executionNew, "new", null]].map(([value, id, successor], index) => {
      const f = value as typeof executionOld; return row("executionImage", `foreign-execution-${id}`, { run_step_id: "foreign-step-one", asset_id: f.asset, packageFileId: f.packageFileId,
        role: "execution", position: index, filename: `${id}.png`, mime_type: "image/png", byte_size: f.byteSize,
        superseded_by_occurrence_id: successor ? "foreign-execution-new" : null, superseded_at: successor ? at : null, superseded_by: successor ? actor : null,
        supersession_operation_id: successor ? "foreign-supersede-image" : null });
    }),
    ...[[metrologyOld, "old", metrologyNew], [metrologyNew, "new", null]].map(([value, id, successor], index) => {
      const f = value as typeof metrologyOld; return row("metrologyReference", `foreign-metrology-${id}`, { template_version_id: "foreign-recipe", asset_id: f.asset, packageFileId: f.packageFileId,
        display_name: `Metrology ${id}`, position: index, superseded_by_occurrence_id: successor ? "foreign-metrology-new" : null, superseded_at: successor ? at : null,
        superseded_by: successor ? "system:fabublox-import-recovery" : null, deleted_at: successor ? at : null, deleted_by: successor ? "system:fabublox-import-recovery" : null,
        supersession_operation_id: successor ? "foreign-supersede-metrology" : null });
    }),
    row("recipeChangeProposal", "foreign-proposal", { recipe_family_id: "foreign-family", source_template_version_id: "foreign-recipe", source_verification_id: "foreign-verification-one", change_type: "process", body: "Original suggestion", status: "open" }),
    row("event", "foreign-event", { sample_id: "foreign-sample", kind: "image", body: "foreign-run-one remains ordinary event text", packageFileId: event.packageFileId,
      thumbnailPackageFileId: thumbnail.packageFileId, metadata: { caption: "Original <b>caption</b>", rawCells: { stepId: "foreign-step-one" } }, relationships: [
        { field: "runId", target: { kind: "run", sourceId: "foreign-run-one" }, resolution: "included" },
        { field: "stepIds[0]", target: { kind: "runStep", sourceId: "foreign-step-one" }, resolution: "included" },
        { field: "stepIds[1]", target: { kind: "runStep", sourceId: "foreign-step-two" }, resolution: "included" },
        { field: "operationGroupId", target: { kind: "group", sourceId: "foreign-common-comment" }, resolution: "unresolved" },
      ] }),
    row("sourceImport", "foreign-source-import", { status: "ready", source_filename: "original.xlsx", source_sha256: workbook.sha256, sheet_name: "Original source sheet", template_type: "module",
      recipe_family_id: "foreign-family", template_version_id: "foreign-recipe", workbookPackageFileId: workbook.packageFileId, manifestPackageFileId: manifest.packageFileId, warning_count: 0, completed_at: at }),
    row("fileDerivation", "foreign-derivation", { sourcePackageFileId: event.packageFileId, derivedPackageFileId: thumbnail.packageFileId, generator: "foreign-thumbnail", generator_version: "1",
      parameters_sha256: "a".repeat(64), source_sha256: event.sha256, derived_sha256: thumbnail.sha256, trust_state: "imported_unverified" }),
    row("attachmentDerivative", "foreign-browser-preview", { source_sha256: original.sha256, source_byte_size: original.byteSize, derivative_kind: "browser_preview", generator_version: "foreign-preview/1",
      derived_asset_id: preview.asset, derivedPackageFileId: preview.packageFileId, status: "ready", trust_state: "imported_unverified", retain_until: "2099-10-06T09:00:00.000Z" }),
    ...aliases,
  ];
  const targets = { sample: "foreign-sample", run: "foreign-run-one", run_step: "foreign-step-one", comment: "foreign-common-comment", comment_occurrence: "foreign-occurrence-one",
    comment_attachment: "foreign-comment-original", execution_image: "foreign-execution-new", metrology_reference: "foreign-metrology-new", recipe_revision: "foreign-recipe" };
  Object.entries(REFERENCE_IMPORT_KINDS).forEach(([type, kind], index) => {
    records.push(row("reference", `foreign-reference-${type}`, { registry_version: 1, target: { kind, sourceId: targets[type as keyof typeof targets] }, resolution: "included",
      first_registered_at: at, last_validated_at: at, contexts: [{ segments: [{ target: { kind: "sample", sourceId: "foreign-sample" }, label: "Original sample context", deletedAt: null, archivedAt: null, resolution: "included" }] }] }));
    records.push(row("projectItem", `foreign-reference-item-${type}`, { project_id: "foreign-project", item_type: "reference", reference_target_id: `foreign-reference-${type}`,
      created_sequence: index + 1, last_mutation_id: "project-reference-create" }));
    records.push(row("projectPlacement", `foreign-reference-placement-${type}`, { project_item_id: `foreign-reference-item-${type}`,
      x: index * 220, y: 180, width: 200, height: 100, z_index: index + 1, revision: 2, last_mutation_id: "project-reference-placement" }));
  });
  for (const [id, deleted, contentType] of [["markdown", false, "markdown"], ["attachment", true, "attachment"]] as const) {
    records.push(row("projectContent", `foreign-content-${id}`, { project_id: "foreign-project", content_type: contentType,
      markdown_source: contentType === "markdown" ? "# Original Markdown\n\nforeign-run-one remains user text." : null,
      attachment_caption: contentType === "attachment" ? "Deleted attachment history" : null, format_version: 1, revision: 4, last_mutation_id: "project-content-mutation",
      deleted_at: deleted ? at : null, deleted_by: deleted ? actor : null, deletion_operation_id: deleted ? "project-delete-history" : null }));
    records.push(row("projectItem", `foreign-owned-item-${id}`, { project_id: "foreign-project", item_type: "content", project_content_id: `foreign-content-${id}`,
      created_sequence: id === "markdown" ? 10 : 11, revision: 5, last_mutation_id: "project-item-mutation", deleted_at: deleted ? at : null, deleted_by: deleted ? actor : null,
      deletion_operation_id: deleted ? "project-delete-history" : null }));
    records.push(row("projectPlacement", `foreign-placement-${id}`, { project_item_id: `foreign-owned-item-${id}`, x: id === "markdown" ? 10 : 200, y: 20, width: 180, height: 100,
      z_index: 2, revision: 3, last_mutation_id: "project-placement-mutation" }));
  }
  records.push(row("projectAttachment", "foreign-content-attachment", { project_content_id: "foreign-content-attachment", asset_id: attachment.asset, packageFileId: attachment.packageFileId,
    original_name: "original-project-image.png", mime_type: "image/png", byte_size: attachment.byteSize, creation_operation_id: "project-attachment-create" }));
  for (const [from, to, id] of [["markdown", "attachment", "forward"], ["attachment", "markdown", "reverse"]]) records.push(row("projectEdge", `foreign-edge-${id}`, {
    project_id: "foreign-project", source_item_id: `foreign-owned-item-${from}`, target_item_id: `foreign-owned-item-${to}`, source_handle: "right", target_handle: "left", marker_start: "none", marker_end: "arrow",
    label: "Preserved cyclic graph edge", revision: 6, last_mutation_id: "project-edge-mutation", deleted_at: id === "reverse" ? at : null, deleted_by: id === "reverse" ? actor : null,
    deletion_operation_id: id === "reverse" ? "project-delete-history" : null }));
  return { payloads, package: { schema: "research-package/1", kind: "data_package", packageId: "foreign-nonempty-package", sourceInstallationId: "foreign-installation", createdAt: at,
    roots: [{ kind: "project", id: "foreign-project" }, { kind: "sample", id: "foreign-sample" }], records, files, dependencies: [], completeness: "complete",
    counts: { records: records.length, files: files.length, bytes: files.reduce((sum, file) => sum + file.byteSize, 0) }, recordsSha256: await sha256Hex(stableJson(researchRecordsDocument(records))),
    report: { htmlPath: "report/index.html", markdownPath: "report/report.md" } } };
}

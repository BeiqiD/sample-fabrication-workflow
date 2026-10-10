import type { ResearchDomainRecord, ResearchPackageFile } from "./research-package";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "./research-package-catalog";
import { isProjectAttachmentCaption, isProjectAttachmentSourceUrl, isProjectEdgeLabel, isProjectMarkdownSource, isProjectTitle } from "./project-api";
import { safeAttachmentUrl } from "./comment-submissions";

/** Closed domain constraints apply before provider I/O. Database guards are a
 * second publication fence, not the first validator for an uploaded graph. */
export function validateResearchDomainRelations(records: ResearchDomainRecord[], files: ResearchPackageFile[]): void {
  function invalid(code: string): never { throw new Error(`Invalid research package: ${code}`); }
  const index = new Map(records.map(record => [`${record.kind}\0${record.sourceId}`, record]));
  const fileIndex = new Map(files.map(file => [file.packageFileId, file]));
  const get = (kind: ResearchRecordKind, id: unknown) => index.get(`${kind}\0${id}`);
  const same = (left: unknown, right: unknown, code: string) => { if (left !== right) invalid(code); };
  const enums: Partial<Record<ResearchRecordKind, Record<string, readonly string[]>>> = {
    sample: { status: ["active", "stored", "consumed", "lost"] },
    run: { status: ["active", "complete", "cancelled", "superseded"] },
    runStep: { origin: ["template", "ad_hoc"], plan_status: ["current", "superseded"], status: ["pending", "in_progress", "done", "skipped", "blocked"], entry_kind: ["fabrication", "metrology"] },
    runStepPlanLink: { relation: ["planned", "fulfilled", "skipped", "deviated", "substituted", "retry", "manual_anchor", "historical"] },
    comment: { context_kind: ["sample", "run_steps"], status: ["draft", "uploading", "ready", "failed", "cancelled"] },
    commentItem: { kind: ["comment_image", "attachment", "link"], status: ["pending", "uploading", "ready", "failed", "cancelled"] },
    commentOccurrence: { scope: ["common", "individual"] },
    projectContent: { content_type: ["markdown", "attachment"] }, projectItem: { item_type: ["content", "reference"] },
    projectEdge: { source_handle: ["top", "right", "bottom", "left"], target_handle: ["top", "right", "bottom", "left"], marker_start: ["none", "arrow"], marker_end: ["none", "arrow"] },
    recipeFamily: { template_type: ["process", "module", "recipe"] },
    recipeRevision: { template_type: ["process", "module", "recipe"], template_kind: ["process", "metrology"] },
    stateVerification: { result: ["matched", "mismatched"], status: ["valid", "stale"] },
    executionImage: { role: ["execution", "state_observation"] },
    recipeChangeProposal: { change_type: ["expected_state", "process", "applicability"], status: ["open", "accepted", "rejected"] },
    event: { kind: ["comment", "image", "location", "status", "created", "step", "run", "plan", "verification"] },
    sourceImport: { status: ["pending", "ready", "failed"], template_type: ["process", "module", "recipe"] },
    attachmentDerivative: { status: ["ready", "failed"] },
  };
  const uniqueFields: Partial<Record<ResearchRecordKind, string[][]>> = {
    sample: [["code"]], run: [["sample_id", "sequence_no"]], runStep: [["run_id", "position"]], runPlanRevision: [["run_id", "revision_no"]],
    runStepPlanLink: [["run_plan_revision_id", "template_step_id", "run_step_id"]],
    commentItem: [["submission_id", "position"]], commentTarget: [["submission_id", "run_step_id"]],
    projectContent: [], projectAttachment: [["project_content_id"]],
    projectItem: [["project_id", "created_sequence"], ["project_content_id"]], projectPlacement: [["project_item_id"]],
    recipeFamily: [["name", "template_type"]], recipeRevision: [["recipe_family_id", "version"], ["name", "template_type", "version"]],
    templateStep: [["template_version_id", "position"], ["template_version_id", "logical_step_key"]],
    stateAsset: [["state_hash", "asset_id"], ["state_hash", "position"]], verificationStep: [["verification_id", "run_step_id"], ["verification_id", "ordinal"]],
    metrologyReference: [["template_version_id", "asset_id"]], executionImage: [["run_step_id", "asset_id", "role"]],
  };
  const uniqueness = new Set<string>();
  for (const record of records) {
    const data = record.data;
    for (const [field, values] of Object.entries(enums[record.kind] ?? {})) if (!values.includes(String(data[field]))) invalid("enum");
    const definition = RESEARCH_PACKAGE_CATALOG[record.kind];
    if (definition.id.length > 1) same(record.sourceId, JSON.stringify(definition.id.map(field => data[field])), "composite_identity");
    if (record.kind === "projectAttachment") same(record.sourceId, data.project_content_id, "attachment_identity");
    for (const fields of uniqueFields[record.kind] ?? []) {
      if (fields.some(field => data[field] === null)) continue;
      const key = JSON.stringify([record.kind, fields, fields.map(field => data[field])]);
      if (uniqueness.has(key)) invalid("duplicate_domain_key"); uniqueness.add(key);
    }
    for (const field of ["position", "ordinal", "byte_size", "source_byte_size", "original_byte_size", "warning_count"]) {
      if (Object.hasOwn(data, field) && data[field] !== null && Number(data[field]) < 0) invalid("negative_domain_value");
    }
    for (const field of ["revision", "format_version", "created_sequence", "next_created_sequence"]) {
      if (Object.hasOwn(data, field) && Number(data[field]) < 1) invalid("nonpositive_revision");
    }
    if (record.kind.startsWith("project") && Object.hasOwn(data, "deleted_at")) {
      if ((data.deleted_at === null) !== (data.deleted_by === null) || (data.deleted_at === null) !== (data.deletion_operation_id === null)) invalid("project_deletion");
    }
    if (record.kind === "sample" && data.pinned !== 0 && data.pinned !== 1) invalid("sample_pinned");
    if (record.kind === "run") {
      if (data.current_plan_revision_id !== null) same(get("runPlanRevision", data.current_plan_revision_id)?.data.run_id, record.sourceId, "run_current_plan");
      if (data.predecessor_run_id !== null) same(get("run", data.predecessor_run_id)?.data.sample_id, data.sample_id, "run_predecessor_owner");
    }
    if (record.kind === "runStep" && data.previous_step_id !== null) same(get("runStep", data.previous_step_id)?.data.run_id, data.run_id, "step_previous_owner");
    if (record.kind === "runStepPlanLink") {
      const plan = get("runPlanRevision", data.run_plan_revision_id), step = get("runStep", data.run_step_id), templateStep = get("templateStep", data.template_step_id);
      same(step?.data.run_id, plan?.data.run_id, "plan_link_run"); same(templateStep?.data.template_version_id, plan?.data.template_version_id, "plan_link_template");
    }
    if (record.kind === "comment") {
      if (data.context_kind === "sample" ? data.sample_id === null || data.scope !== null : data.sample_id !== null || !["common", "individual"].includes(String(data.scope))) invalid("comment_context");
      if (!Array.isArray(data.excluded_targets)) invalid("comment_excluded_targets");
      for (const value of data.excluded_targets) {
        if (!value || typeof value !== "object" || Array.isArray(value)) invalid("comment_excluded_target");
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(",") !== "resolution,run,sample,step" || row.resolution !== "excluded") invalid("comment_excluded_target");
        for (const [field, kind] of [["sample", "sample"], ["run", "run"], ["step", "runStep"]]) {
          const target = row[field] as Record<string, unknown>;
          if (!target || typeof target !== "object" || Object.keys(target).sort().join(",") !== "kind,sourceId" || target.kind !== kind || typeof target.sourceId !== "string" || !target.sourceId) invalid("comment_excluded_target");
          if (field === "step" && get("runStep", target.sourceId)) invalid("comment_excluded_target_included");
        }
      }
    }
    if (record.kind === "commentTarget") {
      same(get("run", data.run_id)?.data.sample_id, data.sample_id, "comment_target_sample");
      same(get("runStep", data.run_step_id)?.data.run_id, data.run_id, "comment_target_step");
      same(get("comment", data.submission_id)?.data.context_kind, "run_steps", "comment_target_parent");
    }
    if (record.kind === "commentOccurrence" && data.submission_id !== null) {
      const comment = get("comment", data.submission_id); same(comment?.data.context_kind, "run_steps", "comment_occurrence_parent");
      same(comment?.data.scope, data.scope, "comment_occurrence_scope");
      if (!records.some(row => row.kind === "commentTarget" && row.data.submission_id === data.submission_id && row.data.run_step_id === data.run_step_id)) invalid("comment_occurrence_target");
    }
    if (record.kind === "commentItem") {
      if (data.external_url !== null && !safeAttachmentUrl(data.external_url) || data.kind === "link" && data.external_url === null) invalid("comment_link_url");
      if (data.kind === "link" && (data.packageFileId !== null || data.asset_id !== null || data.storage_object_id !== null)) invalid("link_file");
      if (data.kind !== "link" && data.status === "ready" && data.packageFileId === null) invalid("ready_item_file_missing");
      if (data.related_item_id !== null) {
        const related = get("commentItem", data.related_item_id); same(related?.data.submission_id, data.submission_id, "comment_related_parent");
        same(related?.data.related_item_id, record.sourceId, "comment_related_pair");
        if (!related || new Set([data.kind, related.data.kind]).size !== 2 || ![data.kind, related.data.kind].every(kind => kind === "attachment" || kind === "comment_image")) invalid("comment_related_kind");
      }
    }
    if (record.kind === "projectContent") {
      if (data.content_type === "markdown" ? typeof data.markdown_source !== "string" || data.attachment_caption !== null || data.attachment_source_url !== null : data.markdown_source !== null) invalid("project_content_shape");
      if (data.content_type === "markdown" && !isProjectMarkdownSource(data.markdown_source)
        || !isProjectAttachmentCaption(data.attachment_caption) || !isProjectAttachmentSourceUrl(data.attachment_source_url)) invalid("project_content_text");
    }
    if (record.kind === "project" && !isProjectTitle(data.title)) invalid("project_title");
    if (record.kind === "projectItem") {
      if (data.item_type === "content") {
        if (data.project_content_id === null || data.reference_target_id !== null) invalid("project_item_shape");
        same(get("projectContent", data.project_content_id)?.data.project_id, data.project_id, "project_content_owner");
      } else if (data.project_content_id !== null || data.reference_target_id === null) invalid("project_item_shape");
    }
    if (record.kind === "projectEdge") {
      if (!isProjectEdgeLabel(data.label)) invalid("project_edge_label");
      if (data.source_item_id === data.target_item_id) invalid("project_self_edge");
      same(get("projectItem", data.source_item_id)?.data.project_id, data.project_id, "project_edge_source");
      same(get("projectItem", data.target_item_id)?.data.project_id, data.project_id, "project_edge_target");
    }
    if (record.kind === "projectPlacement") {
      if (Math.abs(Number(data.x)) > 1e6 || Math.abs(Number(data.y)) > 1e6 || Math.abs(Number(data.z_index)) > 1e6
        || Number(data.width) <= 0 || Number(data.width) > 1e5 || Number(data.height) <= 0 || Number(data.height) > 1e5) invalid("project_placement_bounds");
    }
    if (record.kind === "stateVerification") {
      const step = get("runStep", data.after_run_step_id); same(get("run", step?.data.run_id)?.data.sample_id, data.sample_id, "verification_owner");
      if (data.previous_verification_id !== null) same(get("stateVerification", data.previous_verification_id)?.data.sample_id, data.sample_id, "verification_previous_owner");
    }
    if (record.kind === "verificationStep") {
      const step = get("runStep", data.run_step_id), verification = get("stateVerification", data.verification_id);
      same(get("run", step?.data.run_id)?.data.sample_id, verification?.data.sample_id, "verification_step_owner");
    }
    if (record.kind === "sourceImport" && data.template_version_id !== null) same(get("recipeRevision", data.template_version_id)?.data.recipe_family_id, data.recipe_family_id, "source_import_family");
    if (record.kind === "fileAlias" && !record.sourceId.startsWith(`${data.alias_kind}:`)) invalid("file_alias_identity");
    const aliasSlots: Partial<Record<ResearchRecordKind, [string, string[]]>> = {
      stateAsset: ["packageFileId", ["asset_id"]], executionImage: ["packageFileId", ["asset_id"]],
      metrologyReference: ["packageFileId", ["asset_id"]], commentOccurrence: ["packageFileId", ["asset_id"]],
      commentItem: ["packageFileId", ["asset_id", "storage_object_id"]], projectAttachment: ["packageFileId", ["asset_id", "storage_object_id"]],
      stateVerification: ["evidencePackageFileId", ["evidence_asset_id"]], attachmentDerivative: ["derivedPackageFileId", ["derived_asset_id"]],
    };
    const slot = aliasSlots[record.kind];
    if (slot && data[slot[0]] !== null) for (const aliasField of slot[1]) if (data[aliasField] !== null) {
      same(get("fileAlias", data[aliasField])?.data.packageFileId, data[slot[0]], "consumer_alias_file");
    }
    if (record.kind === "event") for (const relation of data.relationships as Array<{ field: string; target: { kind: string; sourceId: string }; resolution: string }>) {
      const fileField = relation.field === "assetId" ? "packageFileId" : relation.field === "thumbnailAssetId" ? "thumbnailPackageFileId" : null;
      if (fileField && data[fileField] !== null && relation.resolution === "included") {
        same(get("fileAlias", relation.target.sourceId)?.data.packageFileId, data[fileField], "event_alias_file");
      }
    }
    if (record.kind === "fileDerivation") {
      same(fileIndex.get(String(data.sourcePackageFileId))?.sha256, data.source_sha256, "derivation_source_content");
      same(fileIndex.get(String(data.derivedPackageFileId))?.sha256, data.derived_sha256, "derivation_derived_content");
      if (!/^[a-f0-9]{64}$/.test(String(data.parameters_sha256))) invalid("derivation_parameters_hash");
    }
    // Run images, metrology references and Project attachments have an explicit
    // NULL expected purpose in the canonical typed consumer projection. Keep
    // converted historical File purposes intact rather than inventing a gate.
    const purpose: Partial<Record<ResearchRecordKind, string>> = { stateAsset: "embedded_content",
      commentOccurrence: "embedded_content", stateVerification: "embedded_content", recipeRevision: "provenance", sourceImport: "provenance", attachmentDerivative: "derived_preview" };
    for (const [field, value] of Object.entries(data)) if (value !== null && (field === "packageFileId" || /PackageFileId$/.test(field))) {
      const file = fileIndex.get(String(value)); if (!file) invalid("file_missing");
      const expected = record.kind === "commentItem" ? data.kind === "attachment" ? "research_source" : data.related_item_id !== null ? "derived_preview" : "embedded_content"
        : record.kind === "event" ? field === "thumbnailPackageFileId" ? "derived_preview" : "embedded_content" : purpose[record.kind];
      if (expected && file.purpose !== expected) invalid("file_purpose");
      if (record.kind === "fileDerivation" && field === "derivedPackageFileId" && file.purpose !== "derived_preview") invalid("derivation_purpose");
    }
  }
}

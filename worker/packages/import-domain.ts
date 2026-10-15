import type { ResearchDomainRecord, ResearchPackageV1 } from "../../shared/contracts/research-package";
import { validateResearchPackage, researchRecordsDocument, RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES } from "../../shared/contracts/research-package";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import { isProjectTitle } from "../../shared/contracts/project-api";
import { hashStepDefinition, sha256Hex, stableJson } from "../../shared/domain/content-addressing";
import type { JobSqlDatabase, JobSqlStatement } from "../files/jobs/sql-repository";
import { ImportDomainError, ImportIdentityMap, REFERENCE_IMPORT_KINDS, rewriteImportEventRelationships,
  rewriteImportReferenceContexts, type ImportEventRelationship } from "./import-domain-identity";
import { importNameCandidates } from "./import-domain-snapshot";
import type { FrozenImportDomainPlan, ImportDestinationSnapshot, ImportDomainCanonicalFence, ImportDomainFileTarget,
  ImportDomainNaming, ImportDomainRow, ImportDomainPlanBudget } from "./import-domain-types";
export { readImportDestinationColumns, readImportDestinationSnapshot } from "./import-domain-snapshot";
export * from "./import-domain-types";

const MAX_STATEMENTS = 112;
const MAX_STATEMENT_DATA_BYTES = 96 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const quote = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new ImportDomainError("unknown_destination_column");
  return `"${value}"`;
};
const operationFields = new Set(["last_mutation_id", "deletion_operation_id", "asset_deletion_operation_id", "supersession_operation_id", "creation_operation_id"]);
const fileColumns: Record<string, string> = { packageFileId: "file_id", evidencePackageFileId: "evidence_file_id",
  sourcePackageFileId: "source_file_id", workbookPackageFileId: "workbook_file_id", manifestPackageFileId: "manifest_file_id" };
const uniqueTuples: Partial<Record<ResearchRecordKind, string[][]>> = {
  run: [["sample_id", "sequence_no"]], runPlanRevision: [["run_id", "revision_no"]],
  recipeFamily: [["name", "template_type"]], recipeRevision: [["recipe_family_id", "version"], ["name", "template_type", "version"]],
  templateStep: [["template_version_id", "position"], ["template_version_id", "logical_step_key"]],
  projectItem: [["project_content_id"], ["project_id", "created_sequence"]], projectPlacement: [["project_item_id"]],
  executionImage: [["run_step_id", "asset_id", "role"]], metrologyReference: [["template_version_id", "asset_id"]],
  reference: [["target_type", "target_id"]],
};

function validateDestinationUniqueness(rows: readonly ImportDomainRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) for (const tuple of [RESEARCH_PACKAGE_CATALOG[row.kind].id, ...uniqueTuples[row.kind] ?? []]) {
    const values = tuple.map(field => row.data[field]);
    if (values.some(value => value === null)) continue; // Match SQL UNIQUE NULL semantics.
    const key = stableJson([row.table, tuple, values]);
    if (seen.has(key)) throw new ImportDomainError("duplicate_domain_destination_key");
    seen.add(key);
  }
}

/** Match the canonical Project final-state checks used by offline recovery.
 * Deleted history remains part of ownership and sequence validation; only an
 * active item requires a placement. Check the source graph before allocating
 * fresh identities, so an invalid copy never reaches File staging. */
function validateProjectFinalState(records: readonly ResearchDomainRecord[]): void {
  const projects = new Map(records.filter(row => row.kind === "project").map(row => [row.sourceId, row]));
  const contents = new Map(records.filter(row => row.kind === "projectContent").map(row => [row.sourceId, row]));
  const items = new Map(records.filter(row => row.kind === "projectItem").map(row => [row.sourceId, row]));
  const placements = new Map<string, number>();
  for (const row of records) if (row.kind === "projectPlacement") {
    const item = String(row.data.project_item_id);
    placements.set(item, (placements.get(item) ?? 0) + 1);
  }
  for (const item of items.values()) {
    if (item.data.project_content_id !== null && contents.get(String(item.data.project_content_id))?.data.project_id !== item.data.project_id)
      throw new ImportDomainError("project_content_owner");
    if (item.data.deleted_at === null && placements.get(item.sourceId) !== 1)
      throw new ImportDomainError("project_active_placement_missing");
    if (Number(item.data.created_sequence) >= Number(projects.get(String(item.data.project_id))?.data.next_created_sequence))
      throw new ImportDomainError("project_sequence_watermark");
  }
  for (const row of records) {
    if (row.kind === "projectEdge" && (items.get(String(row.data.source_item_id))?.data.project_id !== row.data.project_id
      || items.get(String(row.data.target_item_id))?.data.project_id !== row.data.project_id))
      throw new ImportDomainError("project_edge_owner");
    if (row.kind === "projectAttachment" && contents.get(String(row.data.project_content_id))?.data.content_type !== "attachment")
      throw new ImportDomainError("project_attachment_subtype");
  }
}

function jsonCell(value: unknown): string { return stableJson(value); }
function defaultCell(sql: string | null, acceptedAt: string): unknown {
  if (sql === null || sql.toUpperCase() === "NULL") return null;
  if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(sql)) return Number(sql);
  if (/^'(?:[^']|'')*'$/.test(sql)) return sql.slice(1, -1).replaceAll("''", "'");
  if (/^(?:CURRENT_TIMESTAMP|\(?datetime\('now'\)\)?)$/i.test(sql)) return acceptedAt;
  throw new ImportDomainError("unsupported_destination_default");
}
function canonicalCells(kind: "state" | "stepDefinition", data: Record<string, unknown>) {
  const fields = kind === "state" ? ["hash_scheme", "representation_type", "content_json"] : ["hash_scheme", "canonical_json"];
  return Object.fromEntries(Object.entries(data).filter(([field]) => fields.includes(field))
    .map(([field, value]) => [field, RESEARCH_PACKAGE_CATALOG[kind].fields[field]?.type === "json" && typeof value === "string" ? JSON.parse(value) : value]));
}
function namePlan(pkg: ResearchPackageV1, destination: ImportDestinationSnapshot, suffix: string): ImportDomainNaming[] {
  const sample = new Set(destination.names.sample), project = new Set(destination.names.project);
  const family = new Set(destination.names.recipeFamily.map(row => stableJson([row.name, row.type])));
  const revision = new Set(destination.names.recipeRevision.map(row => stableJson([row.name, row.type, row.version])));
  const result: ImportDomainNaming[] = [];
  for (const row of [...pkg.records].sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId))) {
    if (!["sample", "project", "recipeFamily", "recipeRevision"].includes(row.kind)) continue;
    const kind = row.kind as ImportDomainNaming["kind"], field = kind === "sample" ? "code" : kind === "project" ? "title" : "name";
    const original = String(row.data[field]), set = kind === "sample" ? sample : kind === "project" ? project : kind === "recipeFamily" ? family : revision;
    if (kind === "project" && !isProjectTitle(original + suffix)) throw new ImportDomainError("destination_name_limit");
    const key = (name: string) => kind === "recipeFamily" ? stableJson([name, row.data.template_type])
      : kind === "recipeRevision" ? stableJson([name, row.data.template_type, row.data.version]) : name;
    const name = importNameCandidates(original + suffix).find(candidate => !set.has(key(candidate)));
    if (!name) throw new ImportDomainError("destination_name_conflict");
    if (name.length > 1000 || kind === "project" && !isProjectTitle(name)) throw new ImportDomainError("destination_name_limit");
    set.add(key(name)); result.push({ kind, sourceId: row.sourceId, field, original, destination: name });
  }
  return result;
}

/** Public metadata is reauthenticated before accepting any permanent mapping.
 * Destination discovery is preflight only. Publication consumes this frozen
 * plan and uses transactional fences, never a mutable source reread. */
interface PrepareImportDomainOptions {
  files: readonly ImportDomainFileTarget[]; destination: ImportDestinationSnapshot;
  randomId: () => string; acceptedAt: string; namingSuffix?: string;
}
export async function prepareImportDomainPlan(pkg: ResearchPackageV1, options: PrepareImportDomainOptions): Promise<FrozenImportDomainPlan> {
  const plan = await buildImportDomainPlan(pkg, options);
  assertImportPlanBudget(plan);
  return plan;
}

function assertImportPlanBudget(plan: FrozenImportDomainPlan): void {
  if (bytes(stableJson(plan)) > RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES) throw new ImportDomainError("import_plan_budget");
}

async function buildImportDomainPlan(pkg: ResearchPackageV1, options: PrepareImportDomainOptions): Promise<FrozenImportDomainPlan> {
  const { records: _records, ...manifest } = pkg;
  pkg = await validateResearchPackage(manifest, researchRecordsDocument(pkg.records));
  validateProjectFinalState(pkg.records);
  // Pending/failed foreign imports are readable report provenance, not a local
  // executable workflow or a completed import. V1 copies only ready provenance.
  if (pkg.records.some(row => row.kind === "sourceImport" && row.data.status !== "ready"))
    throw new ImportDomainError("unsupported_source_import_state");
  const files = new Map(options.files.map(file => [file.packageFileId, { ...file }]));
  if (files.size !== options.files.length || files.size !== pkg.files.length) throw new ImportDomainError("destination_file_inventory_mismatch");
  if (new Set(options.files.map(file => file.assetId)).size !== files.size || new Set(options.files.map(file => file.destinationFileId)).size !== files.size)
    throw new ImportDomainError("destination_file_inventory_mismatch");
  for (const source of pkg.files) {
    const target = files.get(source.packageFileId);
    if (!target || target.scope !== "system" || target.profileRevision !== 1 || !target.profileId || !target.namespaceIdentity
      || target.sha256 !== source.sha256 || target.byteSize !== source.byteSize || target.purpose !== source.purpose
      || !target.destinationFileId || !target.assetId) throw new ImportDomainError("destination_file_inventory_mismatch");
  }
  const logicalAliases = new Set<string>();
  for (const alias of pkg.records.filter(row => row.kind === "fileAlias")) {
    const file = files.get(String(alias.data.packageFileId))!;
    if (logicalAliases.has(file.packageFileId)) throw new ImportDomainError("destination_alias_inventory_mismatch");
    logicalAliases.add(file.packageFileId);
    Object.assign(file, { originalName: alias.data.original_name, mimeType: alias.data.mime_type, aliasCreatedAt: alias.data.created_at });
  }
  const sourceIds = new Set(pkg.records.map(row => row.sourceId));
  for (const row of pkg.records) {
    for (const relation of RESEARCH_PACKAGE_CATALOG[row.kind].relations ?? []) if (typeof row.data[relation.field] === "string") sourceIds.add(String(row.data[relation.field]));
    for (const field of [...operationFields, "run_group_id", "operation_group_id"]) if (typeof row.data[field] === "string") sourceIds.add(String(row.data[field]));
    if (row.kind === "reference") {
      sourceIds.add(String((row.data.target as { sourceId: string }).sourceId));
      for (const context of row.data.contexts as Array<{ segments: Array<{ target: { sourceId: string } }> }>)
        for (const segment of context.segments) sourceIds.add(segment.target.sourceId);
    }
    if (row.kind === "event") for (const relationship of row.data.relationships as ImportEventRelationship[]) sourceIds.add(relationship.target.sourceId);
  }
  const identities = new ImportIdentityMap(options.randomId, sourceIds);
  const suffix = options.namingSuffix ?? "";
  if (suffix.length > 32 || /[\u0000-\u001f\u007f]/.test(suffix)) throw new ImportDomainError("invalid_naming_suffix");
  const naming = namePlan(pkg, options.destination, suffix), canonicalFences: ImportDomainCanonicalFence[] = [], fileReuses: FrozenImportDomainPlan["fileReuses"] = [];
  const reusedStates = new Set<string>(), reusedDefinitions = new Set<string>();
  for (const source of pkg.records.filter(row => row.kind === "state" || row.kind === "stepDefinition")) {
    const kind = source.kind as "state" | "stepDefinition";
    const existing = options.destination.definitions.find(row => row.kind === kind && row.hash === source.sourceId);
    if (existing) {
      try {
        const stored = canonicalCells(kind, existing.data);
        if (stableJson(stored) !== stableJson(canonicalCells(kind, source.data))) throw new Error("different canonical value");
        if (kind === "stepDefinition") {
          const expected = await hashStepDefinition({ name: String(existing.data.name), toolName: existing.data.tool_name as string | null,
            parametersText: existing.data.parameters_text as string | null, commentsText: existing.data.comments_text as string | null });
          if (expected.hash !== source.sourceId || stableJson(expected.canonical) !== stableJson(stored.canonical_json)) throw new Error("unverified canonical value");
        } else if (await sha256Hex(stableJson(stored.content_json)) !== source.sourceId) throw new Error("unverified canonical value");
      } catch { throw new ImportDomainError("canonical_definition_conflict"); }
    }
    const media = kind === "state" ? pkg.records.filter(row => row.kind === "stateAsset" && row.data.state_hash === source.sourceId)
      .sort((a, b) => Number(a.data.position) - Number(b.data.position) || a.sourceId.localeCompare(b.sourceId)) : [];
    const destinationMedia = options.destination.stateMedia.filter(row => row.stateHash === source.sourceId);
    if (new Set(media.map(row => row.data.position)).size !== media.length) throw new ImportDomainError("ambiguous_state_media_order");
    if (existing && kind === "state") {
      if (media.length !== destinationMedia.length) throw new ImportDomainError("definition_media_destination_conflict");
      for (let index = 0; index < media.length; index++) {
        const target = files.get(String(media[index].data.packageFileId))!, current = destinationMedia[index];
        if (!current || current.position !== media[index].data.position || current.purpose === "derived_preview"
          || current.purpose !== target.purpose || current.scope !== "system" || current.profileId !== target.profileId
          || current.profileRevision !== target.profileRevision || current.namespaceIdentity !== target.namespaceIdentity
          || current.sha256 !== target.sha256 || current.byteSize !== target.byteSize || !current.fileId || !current.locationId)
          throw new ImportDomainError("definition_media_destination_conflict");
        const prior = fileReuses.find(row => row.packageFileId === target.packageFileId);
        if (prior && (prior.fileId !== current.fileId || prior.assetId !== current.assetId || prior.locationId !== current.locationId))
          throw new ImportDomainError("definition_media_destination_conflict");
        if (fileReuses.some(row => row.packageFileId !== target.packageFileId && row.assetId === current.assetId))
          throw new ImportDomainError("definition_media_destination_conflict");
        if (!prior) fileReuses.push({ packageFileId: target.packageFileId, fileId: current.fileId, locationId: current.locationId, assetId: current.assetId });
        Object.assign(target, { destinationFileId: current.fileId, assetId: current.assetId, locationId: current.locationId });
      }
      reusedStates.add(source.sourceId);
    }
    if (existing) reusedDefinitions.add(`${kind}:${source.sourceId}`);
    canonicalFences.push({ kind, hash: source.sourceId, data: existing ? existing.data : { ...source.data, hash: source.sourceId }, existing: !!existing,
      media: existing ? destinationMedia.map(row => ({ assetId: row.assetId, position: row.position })) : [] });
  }
  // Allocate every direct identity before following a single relationship.
  for (const row of pkg.records) {
    const definition = RESEARCH_PACKAGE_CATALOG[row.kind];
    if (row.kind === "fileAlias") identities.register(row.kind, row.sourceId, files.get(String(row.data.packageFileId))!.assetId);
    else if (row.kind === "state" || row.kind === "stepDefinition") identities.register(row.kind, row.sourceId, row.sourceId);
    else if (definition.id.length === 1 && definition.id[0] === "id") identities.register(row.kind, row.sourceId);
  }
  for (const row of pkg.records) {
    const definition = RESEARCH_PACKAGE_CATALOG[row.kind];
    if (identities.has(row.kind, row.sourceId)) continue;
    const parts = definition.id.map(field => {
      const relation = definition.relations?.find(relation => relation.field === field);
      return relation ? identities.get(relation.kind, row.data[field]) : String(row.data[field]);
    });
    identities.register(row.kind, row.sourceId, parts.length === 1 ? parts[0] : stableJson(parts));
  }
  for (const row of pkg.records.filter(row => row.kind === "commentOccurrence")) {
    const group = row.data.operation_group_id;
    if (typeof group === "string" && identities.has("comment", group)) identities.register("group", group, identities.get("comment", group));
  }
  const lookup = new Map(pkg.records.map(row => [`${row.kind}:${row.sourceId}`, row]));
  const rows: ImportDomainRow[] = [];
  for (const source of pkg.records) {
    if (source.kind === "fileAlias" || source.kind === "fileDerivation" || source.kind === "attachmentDerivative" || reusedDefinitions.has(`${source.kind}:${source.sourceId}`)
      || source.kind === "stateAsset" && reusedStates.has(String(source.data.state_hash))) continue;
    const definition = RESEARCH_PACKAGE_CATALOG[source.kind], transformed: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(source.data)) {
      if (field === "metadata" || field === "relationships" || field === "target" || field === "contexts" || field === "excluded_targets" || /PackageFileId$/.test(field) || field === "packageFileId") continue;
      const relation = definition.relations?.find(row => row.field === field);
      if (relation && value !== null) {
        transformed[field] = identities.has(relation.kind, String(value)) ? identities.get(relation.kind, value)
          : relation.external && relation.nullable ? null : (() => { throw new ImportDomainError("missing_domain_dependency"); })();
      } else if (operationFields.has(field) && value !== null) transformed[field] = identities.register("operation", String(value));
      else if (field === "run_group_id" && value !== null) transformed[field] = identities.register("group", String(value));
      else if (field === "operation_group_id" && value !== null) transformed[field] = identities.has("comment", String(value))
        ? identities.get("comment", value) : identities.register("group", String(value));
      else transformed[field] = definition.fields[field].type === "json" && value !== null ? jsonCell(value) : value;
    }
    if (definition.id.length === 1 && !Object.hasOwn(transformed, definition.id[0])) transformed[definition.id[0]] = identities.get(source.kind, source.sourceId);
    for (const [field, column] of Object.entries(fileColumns)) if (Object.hasOwn(source.data, field)) {
      transformed[column] = source.data[field] === null ? null : files.get(String(source.data[field]))!.destinationFileId;
    }
    if (source.kind === "event") {
      const metadata = rewriteImportEventRelationships(source.data.metadata as Record<string, unknown>, source.data.relationships as ImportEventRelationship[], identities);
      transformed.asset_file_id = source.data.packageFileId === null ? null : files.get(String(source.data.packageFileId))!.destinationFileId;
      if (source.data.packageFileId !== null) metadata.assetId = files.get(String(source.data.packageFileId))!.assetId;
      transformed.thumbnail_file_id = source.data.thumbnailPackageFileId === null ? null : files.get(String(source.data.thumbnailPackageFileId))!.destinationFileId;
      if (source.data.thumbnailPackageFileId !== null) metadata.thumbnailAssetId = files.get(String(source.data.thumbnailPackageFileId))!.assetId;
      transformed.metadata_json = jsonCell(metadata); transformed.asset_key = null; delete transformed.file_id;
    }
    if (source.kind === "reference") {
      const target = source.data.target as { kind: ResearchRecordKind; sourceId: string };
      const type = Object.entries(REFERENCE_IMPORT_KINDS).find(([, kind]) => kind === target.kind)?.[0];
      if (!type) throw new ImportDomainError("unknown_reference_kind");
      const exists = lookup.has(`${target.kind}:${target.sourceId}`);
      transformed.target_type = type; transformed.target_id = exists ? identities.get(target.kind, target.sourceId) : identities.register(target.kind, target.sourceId);
      transformed.last_known_contexts_json = jsonCell(rewriteImportReferenceContexts(source.data.contexts, identities));
      // Resolution is evaluated from the destination graph. Foreign claims never
      // register a colliding existing destination row under its foreign ID.
      delete transformed.resolution;
    }
    if (source.kind === "commentItem" || source.kind === "projectAttachment") {
      if (source.data.storage_object_id !== null) transformed.asset_id = identities.get("fileAlias", source.data.storage_object_id);
      transformed.storage_object_id = null;
    }
    if (source.kind === "executionImage") {
      const alias = lookup.get(`fileAlias:${source.data.asset_id}`);
      transformed.filename ??= alias?.data.original_name ?? null;
      transformed.mime_type ??= alias?.data.mime_type ?? null;
      transformed.byte_size ??= alias?.data.byte_size ?? null;
    }
    if (source.kind === "sourceImport") {
      for (const field of ["operation_id", "lease_expires_at", "finalization_id", "recovery_operation_id", "client_request_id", "request_sha256", "request_input_json",
        "request_scope", "storage_profile_id", "storage_profile_revision", "storage_policy_revision", "accepted_result_json", "file_targets_protocol", "role_policy_revision"])
        transformed[field] = null;
    }
    const name = naming.find(row => row.kind === source.kind && row.sourceId === source.sourceId); if (name) transformed[name.field] = name.destination;
    const columns = options.destination.columns[definition.table];
    if (!columns?.length) throw new ImportDomainError("unsupported_destination_schema");
    const data: Record<string, unknown> = {};
    for (const column of columns) {
      const value = Object.hasOwn(transformed, column.name) ? transformed[column.name] : defaultCell(column.defaultValue, options.acceptedAt);
      if (value === null && column.notNull) throw new ImportDomainError("missing_destination_field");
      data[column.name] = value;
    }
    if (Object.keys(transformed).some(field => !Object.hasOwn(data, field))) throw new ImportDomainError("unsupported_destination_schema");
    if (source.kind === "projectEdge" && data.source_item_id === data.target_item_id) throw new ImportDomainError("project_self_edge");
    rows.push({ kind: source.kind, sourceId: source.sourceId, table: definition.table, id: identities.get(source.kind, source.sourceId), data });
  }
  const plan: FrozenImportDomainPlan = { schema: "research-domain-import/1", packageId: pkg.packageId, acceptedAt: options.acceptedAt,
    rows, identities: identities.entries(), naming, roots: pkg.roots.map(root => ({ kind: root.kind, id: identities.get(root.kind, root.id) })),
    namingPreview: { suffix, conflicts: naming.filter(row => row.original !== row.destination).map(row => ({
      kind: row.kind === "recipeFamily" || row.kind === "recipeRevision" ? "template" : row.kind,
      sourceId: row.sourceId, sourceName: row.original, destinationName: row.destination })) },
    canonicalFences, fileReuses, files: [...files.values()], publicationStatements: 0 };
  validateDestinationUniqueness(rows);
  plan.publicationStatements = publicationSql(plan).length;
  if (plan.publicationStatements > MAX_STATEMENTS) throw new ImportDomainError("publication_statement_limit");
  return plan;
}

/** Conservative empty-destination copy admission uses the real closed-schema
 * mapper, including duplicated rows, identity maps, canonical fences, media and
 * alias metadata. It cannot promise compatibility with an existing destination
 * definition: that destination still performs its exact immutable-media and
 * serialized-plan checks before acceptance. Target metadata is the current
 * frozen selection; another installation or later policy is checked again. */
export async function estimateResearchImportPlanBudget(pkg: ResearchPackageV1, options: {
  columns: ImportDestinationSnapshot["columns"];
  targets: ReadonlyArray<Pick<ImportDomainFileTarget, "purpose" | "profileId" | "profileRevision" | "namespaceIdentity">>;
}): Promise<ImportDomainPlanBudget> {
  const strings = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(pkg);
  let counter = 0;
  const randomId = () => {
    let value: string;
    do { value = `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`; } while (strings.has(value));
    return value;
  };
  try {
    const files = pkg.files.map(file => {
      const target = options.targets.find(target => target.purpose === file.purpose);
      if (!target) throw new ImportDomainError("destination_file_inventory_mismatch");
      return { ...target, packageFileId: file.packageFileId, destinationFileId: randomId(), assetId: randomId(), locationId: randomId(),
        sha256: file.sha256, byteSize: file.byteSize, scope: "system" as const };
    });
    const plan = await buildImportDomainPlan(pkg, { files, randomId, acceptedAt: "2000-01-01T00:00:00.000Z", destination: {
      columns: options.columns, names: { sample: [], recipeFamily: [], recipeRevision: [], project: [] }, definitions: [], stateMedia: [],
    } });
    // Reserve every allowed suffix/name conflict and its complete preview
    // record. UTF-8 suffixes can occupy three bytes per code unit. This estimate
    // never writes the synthetic names or creates permanent destination IDs.
    plan.namingPreview.suffix = "\uffff".repeat(32);
    plan.namingPreview.conflicts = [];
    for (const naming of plan.naming) {
      const row = plan.rows.find(row => row.kind === naming.kind && row.sourceId === naming.sourceId)!;
      const remaining = Math.max(0, 1000 - naming.original.length);
      const extra = "\uffff".repeat(Math.min(32, remaining)) + " (import 64)".slice(0, Math.max(0, remaining - 32));
      naming.destination += extra;
      row.data[naming.field] = naming.destination;
      plan.namingPreview.conflicts.push({ kind: naming.kind === "recipeFamily" || naming.kind === "recipeRevision" ? "template" : naming.kind,
        sourceId: naming.sourceId, sourceName: naming.original, destinationName: naming.destination });
    }
    // Recompute the exact chunked publication envelope after name growth. The
    // public count bound alone does not qualify the final transaction.
    plan.publicationStatements = publicationSql(plan).length;
    const estimatedBytes = bytes(stableJson(plan));
    return { supported: estimatedBytes <= RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES, estimatedBytes,
      maximumBytes: RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES, reason: estimatedBytes > RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES ? "import_plan_budget" : null };
  } catch (error) {
    if (!(error instanceof ImportDomainError)) throw error;
    return { supported: false, estimatedBytes: null, maximumBytes: RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES, reason: error.reason };
  }
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = []; let part: T[] = [], size = 2;
  for (const value of values) {
    const length = bytes(JSON.stringify(value)) + 1;
    if (length > MAX_STATEMENT_DATA_BYTES - 2) throw new ImportDomainError("publication_row_size_limit");
    if (size + length > MAX_STATEMENT_DATA_BYTES) { result.push(part); part = []; size = 2; }
    part.push(value); size += length;
  }
  if (part.length) result.push(part); return result;
}
type SqlCommand = { sql: string; values: unknown[] };
function publicationSql(plan: FrozenImportDomainPlan): SqlCommand[] {
  if (plan.schema !== "research-domain-import/1" || !Array.isArray(plan.rows) || plan.rows.length > 1200) throw new ImportDomainError("invalid_frozen_domain_plan");
  const commands: SqlCommand[] = [{ sql: "PRAGMA defer_foreign_keys=ON", values: [] }];
  for (const fence of plan.canonicalFences) {
    const table = quote(RESEARCH_PACKAGE_CATALOG[fence.kind].table);
    if (!fence.existing) commands.push({ sql: `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${table} WHERE hash=?) THEN 1 ELSE json('Canonical definition changed') END`, values: [fence.hash] });
    else {
      const entries = Object.entries(fence.data);
      commands.push({ sql: `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${entries.map(([field]) => `${quote(field)} IS ?`).join(" AND ")})
        THEN 1 ELSE json('Canonical definition changed') END`, values: entries.map(([, value]) => value) });
      if (fence.kind === "state") commands.push({ sql: `SELECT CASE WHEN (SELECT count(*) FROM state_representation_assets WHERE state_hash=?)=json_array_length(?)
        AND NOT EXISTS(SELECT 1 FROM state_representation_assets a WHERE a.state_hash=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected
          WHERE a.asset_id=json_extract(expected.value,'$.assetId') AND a.position=json_extract(expected.value,'$.position')))
        THEN 1 ELSE json('Canonical State media changed') END`, values: [fence.hash, JSON.stringify(fence.media), fence.hash, JSON.stringify(fence.media)] });
    }
  }
  const grouped = new Map<string, ImportDomainRow[]>();
  for (const row of plan.rows) {
    if (RESEARCH_PACKAGE_CATALOG[row.kind]?.table !== row.table || row.kind === "fileAlias" || row.kind === "fileDerivation") throw new ImportDomainError("invalid_frozen_domain_plan");
    const fields = Object.keys(row.data); fields.forEach(quote);
    const key = JSON.stringify([row.table, fields]); const group = grouped.get(key) ?? []; group.push(row); grouped.set(key, group);
  }
  // Declared FK cycles are deferred, while immediate domain/ownership triggers
  // still require parents and immutable definitions first.
  const order: ResearchRecordKind[] = ["stepDefinition", "state", "recipeFamily", "recipeRevision", "templateStep", "sample", "run", "runPlanRevision", "runStep", "runStepPlanLink",
    "comment", "commentItem", "commentTarget", "commentOccurrence", "stateAsset", "stateVerification", "verificationStep", "metrologyReference", "executionImage", "recipeChangeProposal",
    "event", "reference", "project", "projectContent", "projectAttachment", "projectItem", "projectPlacement", "projectEdge", "sourceImport"];
  for (const group of [...grouped.values()].sort((a, b) => order.indexOf(a[0].kind) - order.indexOf(b[0].kind))) {
    const fields = Object.keys(group[0].data);
    const ordered = group[0].kind === "commentItem" ? [...group].sort((a, b) =>
      Number(a.data.kind === "comment_image" && a.data.related_item_id !== null) - Number(b.data.kind === "comment_image" && b.data.related_item_id !== null)) : group;
    for (const part of chunks(ordered.map(row => row.data))) commands.push({ sql: `INSERT INTO ${quote(group[0].table)}(${fields.map(quote).join(",")})
      SELECT ${fields.map(field => `json_extract(value,'$.${field}')`).join(",")} FROM json_each(?) ORDER BY CAST(key AS INTEGER)`, values: [JSON.stringify(part)] });
  }
  if (commands.length > MAX_STATEMENTS) throw new ImportDomainError("publication_statement_limit");
  return commands;
}

/** Source capture remains unchanged; only permanent typed maps are staged. */
export function importDomainIdentityStatements(db: JobSqlDatabase, jobId: string, plan: FrozenImportDomainPlan): JobSqlStatement[] {
  assertImportPlanBudget(plan);
  return chunks(plan.identities).map(part => db.prepare(`INSERT INTO research_package_identity_maps(job_id,entity_kind,source_id,destination_id)
    SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.sourceId'),json_extract(value,'$.destinationId') FROM json_each(?)`).bind(jobId, JSON.stringify(part)));
}

/** Append these statements after verified Files/aliases and fresh actor/runtime/
 * lease fences, before the completed receipt, in the same native primary batch. */
export function prepareImportDomainPublication(db: JobSqlDatabase, plan: FrozenImportDomainPlan): JobSqlStatement[] {
  assertImportPlanBudget(plan);
  const commands = publicationSql(plan);
  if (commands.length !== plan.publicationStatements) throw new ImportDomainError("invalid_frozen_domain_plan");
  return commands.map(command => db.prepare(command.sql).bind(...command.values));
}

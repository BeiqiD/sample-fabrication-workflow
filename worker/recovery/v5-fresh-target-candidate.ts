// Explicit SOURCE-only V5 target construction. No default route, capture,
// migration or runtime mounts this API. Payload publication is a later seam.
import type { Env } from "../types";
import { primaryD1 } from "../d1-primary";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import type { SystemRecoveryStorageMapping } from "../../shared/contracts/system-recovery";
import { validateSystemBackupDocumentsV5, type SystemBackupManifestV5, type SystemBackupRecordsV5 } from "../../shared/contracts/system-backup-v5";
import type { FullExportBlobEntryV28 } from "../../shared/contracts/export-local-file-bytes-v28";
import { recoveryTableSnapshotSql, type RecoveryTableSpec, type SystemRecoveryCell, type SystemRecoveryRow, type SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import { stableJson, sha256Hex } from "../../shared/domain/content-addressing";
import { canonicalR2ProfileNamespace, resolveR2ProfileBinding, type ResolvedR2ProfileBinding } from "../files/r2-profile-bindings";
import { stripReviewedCurrentCloudflarePlatformSchema } from "./current-cloudflare-schema";
import { inspectRecoveryMigrationLedger, recoveryMigrationLedgerStatements } from "./target-migrations";
import { inspectV28CloudflareSchemaCandidate } from "./v28-cloudflare-schema-candidate";
import { V5_RECOVERY_CATALOG_CANDIDATE as catalog, destinationV5RecoveryTablesCandidate } from "./v5-catalog-candidate";

const MAX_STATEMENTS = 128, MAX_GROUP_BYTES = 83 * 1024, DDL_GROUP = 16;
const MAX_CONSTRUCTION_MS = 60_000;
const encoder = new TextEncoder();
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`v5_fresh_target_${reason}`);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(child => freeze(child)); Object.freeze(value);
  }
  return value;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}
const freshId = () => crypto.randomUUID().replaceAll("-", "");

export interface V5R2PayloadMappingCandidate {
  sourceId: string; sourceProfileId: string; source: FullExportBlobEntryV28;
  archivePath: string; fileIds: readonly string[]; byteSize: number; sha256: string;
  destinationProfileId: string; configurationRevision: 1; destinationNamespaceIdentity: string;
  destinationBindingName: string; objectKey: string; bytesPublished: false;
}
export interface V5FreshTargetAdmissionCandidate {
  kind: "v5-fresh-inert-d1-target-admission/1"; checkpointId: "portable-runtime/v28";
  expectedTargetId: string; schemaSha256: string; sourceImageSha256: string;
  destinationInstallationId: string; destinationIncarnation: string;
  atomicRowStatements: number; tables: number; rows: number;
  mappings: readonly V5R2PayloadMappingCandidate[];
  rawMigrationExecution: false; payloadPublication: false; executionEnabled: false;
}
export interface V5FreshTargetConstructionCandidate {
  schema: "v5-fresh-inert-d1-image-construction/1"; checkpointId: "portable-runtime/v28";
  targetId: string; schemaSha256: string; sourceImageSha256: string; destinationImageSha256: string;
  destinationInstallationId: string; tables: number; rows: number;
  targetLedger: "reviewed-code-catalog"; rawMigrationExecution: false;
  accountsDisabled: true; collaborationEnabled: false; localBindingsRestored: false;
  executionEnabled: false; maintenanceState: "fenced";
  payloadPublication: false; recoveryReady: false; deploymentChanged: false;
}
interface RowGroup { spec: RecoveryTableSpec; rows: SystemRecoveryRow[] }
interface R2Destination {
  id: string; namespaceIdentity: string; snapshot: string; binding: ResolvedR2ProfileBinding;
}
interface OwnedAdmission {
  admission: V5FreshTargetAdmissionCandidate; manifest: SystemBackupManifestV5; records: SystemBackupRecordsV5;
  destinationTables: Record<string, SystemRecoveryTable>; rowGroups: RowGroup[];
  destinations: readonly R2Destination[]; sourceMarker: string; claimToken: string;
  construction?: Promise<V5FreshTargetConstructionCandidate>;
}

function rowGroups(tables: Record<string, SystemRecoveryTable>): RowGroup[] {
  const result: RowGroup[] = [];
  for (const spec of catalog.tables) {
    const table = tables[spec.name]; ensure(table, "destination_table_missing");
    let rows: SystemRecoveryRow[] = [], size = 2;
    for (const row of table.rows) {
      const length = encoder.encode(stableJson(row)).byteLength + 1;
      ensure(length < MAX_GROUP_BYTES, "row_budget");
      if (rows.length && size + length > MAX_GROUP_BYTES) { result.push({ spec, rows }); rows = []; size = 2; }
      rows.push(row); size += length;
    }
    if (rows.length) result.push({ spec, rows });
  }
  return result;
}
function insertGroup(db: D1Database, group: RowGroup): D1PreparedStatement {
  const cell = (index: number) => {
    const type = `json_extract(value,'$.cells[${index}].type')`, value = `json_extract(value,'$.cells[${index}].value')`;
    return `CASE ${type} WHEN 'integer' THEN CAST(${value} AS INTEGER) WHEN 'real' THEN CAST(${value} AS REAL) WHEN 'blob' THEN unhex(${value}) WHEN 'text' THEN ${value} ELSE NULL END`;
  };
  const columns = group.spec.withoutRowid ? [...group.spec.columns] : ["rowid", ...group.spec.columns];
  const values = group.spec.withoutRowid ? group.spec.columns.map((_, index) => cell(index))
    : ["CAST(json_extract(value,'$.rowid') AS INTEGER)", ...group.spec.columns.map((_, index) => cell(index))];
  const sql = `INSERT INTO ${quote(group.spec.name)} (${columns.map(quote).join(",")}) SELECT ${values.join(",")} FROM json_each(?)`;
  ensure(encoder.encode(sql).byteLength < MAX_GROUP_BYTES, "sql_budget");
  return db.prepare(sql).bind(stableJson(group.rows));
}
async function schema(db: D1Database): Promise<ExportSchemaObject[]> {
  const result = await db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name").all<ExportSchemaObject>();
  ensure(result.success, "schema_unavailable"); return result.results;
}
async function readTable(db: D1Database, spec: RecoveryTableSpec): Promise<SystemRecoveryTable> {
  const rows: SystemRecoveryRow[] = [], sql = recoveryTableSnapshotSql(spec);
  for (let offset = 0;; offset += 16) {
    const result = await db.prepare(`${sql} LIMIT 16 OFFSET ?`).bind(offset).all<{ rowid: string | null; cells: string }>();
    ensure(result.success, "table_unavailable");
    rows.push(...result.results.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) as SystemRecoveryCell[] })));
    ensure(rows.length <= 16_384, "row_inventory_budget");
    if (result.results.length < 16) return { columns: [...spec.columns], rows };
  }
}
function sameTable(left: SystemRecoveryTable, right: SystemRecoveryTable): boolean {
  return stableJson(left.columns) === stableJson(right.columns)
    && stableJson(left.rows.map(stableJson).sort()) === stableJson(right.rows.map(stableJson).sort());
}

/** Installation metadata plus binding resolution, with no R2 request. Neither
 * an uploaded descriptor nor a same-looking object key supplies this authority. */
async function r2Destination(env: Env, source: D1Database, id: string): Promise<R2Destination> {
  const result = await source.prepare(`SELECT p.id,p.adapter_type,p.namespace_identity,p.configuration_source,
    p.credential_reference,p.configuration_revision,p.state,p.created_at,
    r.state AS runtime_state,r.registered_at,r.activated_at,r.retired_at
    FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id WHERE p.id=?`)
    .bind(id).all<Record<string, unknown>>();
  ensure(result.success && result.results.length === 1, "r2_destination_unavailable");
  const row = result.results[0];
  ensure(row.id === id && row.adapter_type === "r2" && row.configuration_source === "bootstrap"
    && row.credential_reference === null && row.configuration_revision === 1 && row.state === "historical"
    && row.runtime_state === "read_write" && typeof row.created_at === "string"
    && row.registered_at === row.created_at && typeof row.activated_at === "string" && row.retired_at === null,
  "r2_destination_not_admitted");
  const namespaceIdentity = canonicalR2ProfileNamespace(row.namespace_identity);
  const binding = resolveR2ProfileBinding(env, { id, configurationRevision: 1, namespaceIdentity });
  return { id, namespaceIdentity, binding, snapshot: stableJson(row) };
}

/** Fresh-only explicit candidate. Admission reads metadata; construction writes
 * only the supplied isolated RECOVERY_DB. It never copies/publishes bytes,
 * enables authority, changes a source binding or admits an existing application. */
export function createWorkerV5FreshTargetCandidate(env: Env) {
  const sourceBinding = env.DB, targetBinding = env.RECOVERY_DB, targetId = env.RECOVERY_TARGET_ID;
  const admissions = new WeakMap<V5FreshTargetAdmissionCandidate, OwnedAdmission>();
  function bindings(expected: string) {
    ensure(env.DB === sourceBinding && env.RECOVERY_DB === targetBinding && env.RECOVERY_TARGET_ID === targetId
      && targetBinding && targetBinding !== sourceBinding && targetId === expected, "binding_changed_or_alias");
    return { source: primaryD1(sourceBinding), target: primaryD1(targetBinding) };
  }
  async function sourceMarker(source: D1Database): Promise<string> {
    const row = await source.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1").first<{ installation_id: string }>();
    ensure(row && /^[0-9a-f]{32}$/.test(row.installation_id), "source_installation_unavailable"); return row.installation_id;
  }
  async function fresh(target: D1Database) {
    const inspected = stripReviewedCurrentCloudflarePlatformSchema(await schema(target));
    ensure(inspected.applicationObjects.length === 0, "target_not_empty");
    const ledger = await inspectRecoveryMigrationLedger(target, false, catalog.migrations);
    ensure(!ledger.complete, "target_ledger_not_empty");
    const probe = await target.prepare("SELECT hex(unhex('000102FF')) AS probe").first<{ probe: string }>();
    ensure(probe?.probe === "000102FF", "exact_blob_restore_unsupported");
    return ledger;
  }
  async function admit(input: {
    manifest: unknown; records: unknown; expectedTargetId: string; mapping: readonly SystemRecoveryStorageMapping[];
  }): Promise<V5FreshTargetAdmissionCandidate> {
    const expectedTargetId = input.expectedTargetId;
    ensure(text(expectedTargetId, 128) && /^[A-Za-z0-9_-]+$/.test(expectedTargetId), "target_identity");
    // Own caller data before any asynchronous validator or metadata read.
    const copied = structuredClone({ manifest: input.manifest, records: input.records, mapping: input.mapping });
    const checked = await validateSystemBackupDocumentsV5(copied.manifest, copied.records);
    const manifest = checked.manifest, records = checked.records;
    ensure(manifest.completeness === "complete" && manifest.files.every(file => file.outcome === "packaged"), "complete_backup_required");
    ensure(Array.isArray(copied.mapping) && copied.mapping.length <= 100, "mapping_inventory");
    const { source, target } = bindings(expectedTargetId), marker = await sourceMarker(source);
    await fresh(target);
    const destinationInstallationId = freshId(), destinationIncarnation = freshId(), claimToken = freshId();
    const normalize = (value: string) => value.toLowerCase().replaceAll("-", "");
    ensure(destinationInstallationId !== destinationIncarnation && destinationInstallationId !== marker
      && destinationInstallationId !== normalize(manifest.sourceInstallationId)
      && (records.sourceMigrationLedger.kind !== "node-reviewed-migrations/1"
        || destinationInstallationId !== normalize(records.sourceMigrationLedger.installationId)), "fresh_identity_collision");
    const destinationTables = destinationV5RecoveryTablesCandidate(records,
      { installationId: destinationInstallationId, incarnation: destinationIncarnation, clock: new Date().toISOString() });
    const groups = rowGroups(destinationTables);
    ensure(groups.length + 2 <= MAX_STATEMENTS, "atomic_image_budget");
    const mappings = new Map<string, SystemRecoveryStorageMapping>(), destinations = new Map<string, R2Destination>();
    for (const value of copied.mapping) {
      ensure(value && typeof value === "object" && Reflect.ownKeys(value).length === 3
        && Object.keys(value).sort().join(",") === "configurationRevision,destinationProfileId,sourceProfileId"
        && text(value.sourceProfileId, 256) && text(value.destinationProfileId, 256) && value.configurationRevision === 1
        && !mappings.has(value.sourceProfileId), "mapping_not_closed_or_duplicate");
      mappings.set(value.sourceProfileId, value);
      if (!destinations.has(value.destinationProfileId)) destinations.set(value.destinationProfileId,
        await r2Destination(env, source, value.destinationProfileId));
    }
    const used = new Set<string>(), payloads: V5R2PayloadMappingCandidate[] = [];
    for (const file of manifest.files) {
      const profileId = file.source.storageProfileId ?? `legacy:${file.source.storeKind}:${file.source.provider}`;
      if (file.source.provider === "local") ensure(file.source.storeKind === "file" && file.source.storageProfileId !== null,
        "local_source_profile_required");
      const selected = mappings.get(profileId); ensure(selected, "explicit_mapping_missing");
      used.add(profileId); const destination = destinations.get(selected.destinationProfileId); ensure(destination, "destination_missing");
      const prior = records.content.tables.storage_profiles.find(profile => profile.id === destination.id);
      ensure(!prior || prior.adapter_type === "r2" && prior.namespace_identity === destination.namespaceIdentity
        && prior.configuration_revision === 1, "destination_identity_collision");
      ensure(file.path !== null && file.byteSize !== null && file.sha256 !== null, "payload_inventory");
      const digest = await sha256Hex(stableJson({ sourceId: file.id, source: file.source,
        destinationProfileId: destination.id, namespaceIdentity: destination.namespaceIdentity, incarnation: destinationIncarnation }));
      payloads.push({ sourceId: file.id, sourceProfileId: profileId, source: structuredClone(file.source), archivePath: file.path,
        fileIds: [...file.fileIds], byteSize: file.byteSize, sha256: file.sha256, destinationProfileId: destination.id,
        configurationRevision: 1, destinationNamespaceIdentity: destination.namespaceIdentity,
        destinationBindingName: destination.binding.bindingName, objectKey: `fp5-recovery/${destinationIncarnation}/${digest}`, bytesPublished: false });
    }
    ensure(used.size === mappings.size, "unused_mapping");
    const admission = freeze<V5FreshTargetAdmissionCandidate>({ kind: "v5-fresh-inert-d1-target-admission/1",
      checkpointId: "portable-runtime/v28", expectedTargetId, schemaSha256: catalog.schemaSha256,
      sourceImageSha256: await sha256Hex(stableJson(records.image)), destinationInstallationId, destinationIncarnation,
      atomicRowStatements: groups.length + 2, tables: catalog.tables.length,
      rows: Object.values(destinationTables).reduce((sum, table) => sum + table.rows.length, 0), mappings: payloads,
      rawMigrationExecution: false, payloadPublication: false, executionEnabled: false });
    admissions.set(admission, { admission, manifest: freeze(manifest), records: freeze(records),
      destinationTables: freeze(destinationTables), rowGroups: freeze(groups), destinations: [...destinations.values()], sourceMarker: marker, claimToken });
    return admission;
  }
  function owned(admission: V5FreshTargetAdmissionCandidate): OwnedAdmission {
    const value = admissions.get(admission); ensure(value, "admission_not_owned"); return value;
  }
  function claimGuard(target: D1Database, record: OwnedAdmission): D1PreparedStatement {
    return target.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_target_claim
      WHERE singleton=1 AND target_id=? AND job_id=? AND incarnation=? AND challenge=? AND schema_sha256=?
      AND image_sha256=? AND owner_token=? AND generation=0 AND runtime_incarnation=? AND status='installing'
      AND julianday(lease_expires_at)>julianday('now')) THEN 1 ELSE json('V5 construction ownership changed') END`)
      .bind(record.admission.expectedTargetId, record.claimToken, record.admission.destinationIncarnation, record.claimToken,
        catalog.schemaSha256, record.admission.sourceImageSha256, record.claimToken, record.admission.destinationIncarnation);
  }
  async function verifyImage(target: D1Database, record: OwnedAdmission, claimPresent: boolean): Promise<string> {
    await inspectV28CloudflareSchemaCandidate(await schema(target));
    const observed: Record<string, SystemRecoveryTable> = {};
    for (const spec of catalog.tables) {
      if (claimPresent && spec.name === "system_recovery_target_claim") continue;
      const table = await readTable(target, spec);
      ensure(sameTable(table, record.destinationTables[spec.name]), `typed_image_changed:${spec.name}`);
      observed[spec.name] = table;
    }
    const keys = await target.prepare("PRAGMA foreign_key_check").all<Record<string, unknown>>();
    ensure(keys.success && keys.results.length === 0, "foreign_keys_invalid");
    const integrity = await target.prepare("PRAGMA quick_check").all<Record<string, unknown>>();
    ensure(integrity.success && integrity.results.length === 1 && Object.values(integrity.results[0])[0] === "ok", "integrity_invalid");
    return sha256Hex(stableJson(observed));
  }
  async function constructOwned(record: OwnedAdmission, current: () => Promise<boolean>, signal?: AbortSignal): Promise<V5FreshTargetConstructionCandidate> {
    const started = Date.now(), deadline = started + MAX_CONSTRUCTION_MS;
    const { source, target } = bindings(record.admission.expectedTargetId);
    async function available() {
      ensure(!signal?.aborted && Date.now() < deadline && await current() === true
        && !signal?.aborted && Date.now() < deadline, "construction_authority_or_budget");
      bindings(record.admission.expectedTargetId);
      ensure(await sourceMarker(source) === record.sourceMarker, "source_identity_changed");
      for (const destination of record.destinations) {
        const now = await r2Destination(env, source, destination.id);
        ensure(now.snapshot === destination.snapshot && now.binding.bucket === destination.binding.bucket
          && now.binding.bindingName === destination.binding.bindingName
          && now.binding.rawMappings === destination.binding.rawMappings
          && now.binding.bootstrapNamespace === destination.binding.bootstrapNamespace, "destination_binding_changed");
      }
      ensure(!signal?.aborted && Date.now() < deadline && await current() === true
        && !signal?.aborted && Date.now() < deadline, "construction_authority_or_budget");
      bindings(record.admission.expectedTargetId);
    }
    async function batch(statements: D1PreparedStatement[], guarded = true) {
      await available(); ensure(statements.length + (guarded ? 1 : 0) <= MAX_STATEMENTS, "statement_budget");
      const results = await target.batch([...(guarded ? [claimGuard(target, record)] : []), ...statements]);
      ensure(results.every(result => result.success), "construction_batch_failed");
    }
    await available(); const initialLedger = await fresh(target);
    const claim = catalog.schemaStatements.find(object => object.type === "table" && object.name === "system_recovery_target_claim");
    ensure(claim, "claim_schema_missing");
    const first = [target.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sqlite_schema
      WHERE name NOT IN('_cf_KV','_cf_METADATA','d1_migrations','sqlite_autoindex_d1_migrations_1','sqlite_sequence'))
      THEN 1 ELSE json('V5 target is not fresh') END`),
      ...(initialLedger.present ? [target.prepare("SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM d1_migrations) THEN 1 ELSE json('V5 target ledger is not fresh') END")] : []),
      target.prepare(claim.sql), target.prepare(`INSERT INTO system_recovery_target_claim
      (singleton,target_id,job_id,incarnation,challenge,schema_sha256,image_sha256,status,cursor_json,owner_token,generation,runtime_incarnation,lease_expires_at)
      VALUES(1,?,?,?,?,?,?,'installing','{}',?,0,?,?)`).bind(record.admission.expectedTargetId, record.claimToken,
        record.admission.destinationIncarnation, record.claimToken, catalog.schemaSha256, record.admission.sourceImageSha256,
        record.claimToken, record.admission.destinationIncarnation, new Date(deadline).toISOString())];
    await batch(first, false);
    const definitions = catalog.schemaStatements.filter(object => object.type !== "trigger" && object.name !== claim.name);
    for (const kind of ["table", "index", "view"] as const) {
      const objects = definitions.filter(object => object.type === kind);
      for (let index = 0; index < objects.length; index += DDL_GROUP) await batch(objects.slice(index, index + DDL_GROUP).map(object => target.prepare(object.sql)));
    }
    await batch([target.prepare("PRAGMA defer_foreign_keys=ON"), ...record.rowGroups.map(group => insertGroup(target, group))]);
    const triggers = catalog.schemaStatements.filter(object => object.type === "trigger");
    for (let index = 0; index < triggers.length; index += DDL_GROUP) await batch(triggers.slice(index, index + DDL_GROUP).map(object => target.prepare(object.sql)));
    await available(); await claimGuard(target, record).first(); await verifyImage(target, record, true);
    // Only the reviewed target catalog produces its ledger, after exact DDL,
    // typed rows and FK/integrity verification. Source receipts are evidence.
    await batch([...(await recoveryMigrationLedgerStatements(target, catalog.migrations)),
      target.prepare("DELETE FROM system_recovery_target_claim WHERE singleton=1 AND challenge=?").bind(record.claimToken)]);
    await available(); await inspectRecoveryMigrationLedger(target, true, catalog.migrations);
    const destinationImageSha256 = await verifyImage(target, record, false);
    await available();
    return freeze<V5FreshTargetConstructionCandidate>({ schema: "v5-fresh-inert-d1-image-construction/1", checkpointId: "portable-runtime/v28",
      targetId: record.admission.expectedTargetId, schemaSha256: catalog.schemaSha256, sourceImageSha256: record.admission.sourceImageSha256,
      destinationImageSha256, destinationInstallationId: record.admission.destinationInstallationId,
      tables: record.admission.tables, rows: record.admission.rows, targetLedger: "reviewed-code-catalog", rawMigrationExecution: false,
      accountsDisabled: true, collaborationEnabled: false, localBindingsRestored: false, executionEnabled: false, maintenanceState: "fenced",
      payloadPublication: false, recoveryReady: false, deploymentChanged: false });
  }
  function construct(admission: V5FreshTargetAdmissionCandidate, current: () => Promise<boolean>, signal?: AbortSignal) {
    const record = owned(admission);
    // Preserve the same first Promise/rejection. An incomplete target is never
    // erased or replayed by another call with the same issued admission.
    return record.construction ??= constructOwned(record, current, signal);
  }
  return Object.freeze({ admit, construct });
}

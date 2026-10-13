// Explicit SOURCE-only fresh V5 native LOCAL-to-R2 byte construction.
// No default route, capture, migration, executor or runtime mounts this API.
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
import type { ExportRow, ExportTables } from "../../shared/contracts/export";
import { admitV5SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission-candidate";
import { openStoreArchiveEntry, type ArchiveSource, type ArchiveIndexEntry } from "../../shared/domain/research-archive";
import { planV5LocalR2FilesCandidate, verifyV5PayloadImageCandidate, type V5PayloadImageChangeCandidate } from "./v5-local-r2-plan-candidate";
import { recoveryDestinationProfileStatements, recoveryFilePublicationStatements, recoveryFileEvidenceRows,
  type RecoveryDestinationProfile, type RecoveryPlannedFile } from "./target-files";
import { validateSystemRecoveryEvidenceHistoryV28 } from "../../shared/contracts/export-system-recovery-evidence-v28";
import { SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS } from "../../shared/contracts/export-system-recovery-evidence";
import { writeVerifiedBytes } from "../files/byte-writer";
import { verifyStoredBytes } from "../files/byte-verification";
import { r2ByteReader } from "../files/storage-adapters/r2-reader";
import { r2ShadowByteWriter } from "../files/storage-adapters/r2-shadow-writer";
import { cloudflareSha256 } from "../files/storage-adapters/cloudflare-sha256";
import { FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL } from "../../shared/contracts/export-file-authority";
import { FILE_SHADOW_HEAD_INTEGRITY_SQL } from "../../shared/contracts/export-file-shadow";
import { FILE_SHADOW_DEPENDENCY_SPECS } from "../../shared/contracts/file-shadow-schema";
import { nativeV28SnapshotSql, buildFullExportV28FromSnapshot } from "../export-v28-core";
import { portableBusinessSchemaV28, createFullExportV28 } from "../../shared/contracts/export-portable-runtime-v28";
import { protectedLocalHistoryFromV5Image, validateSystemRecoveryImageV5 } from "../../shared/contracts/system-backup-v5";
import { validateSystemBackupContentImageV28 } from "../../shared/contracts/system-backup-v28-content";


const MAX_STATEMENTS = 128, MAX_GROUP_BYTES = 83 * 1024, DDL_GROUP = 16;
const MAX_CONSTRUCTION_MS = 60_000;
const encoder = new TextEncoder();
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`v5_local_r2_payload_${reason}`);
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
export interface V5LocalR2PayloadAdmissionCandidate {
  kind: "v5-local-r2-fresh-payload-admission/1"; checkpointId: "portable-runtime/v28";
  expectedTargetId: string; schemaSha256: string; sourceImageSha256: string;
  destinationInstallationId: string; destinationIncarnation: string;
  atomicRowStatements: number; tables: number; rows: number;
  mappings: readonly V5R2PayloadMappingCandidate[];
  rawMigrationExecution: false; payloadPublication: false; executionEnabled: false;
}
export interface V5LocalR2PayloadConstructionCandidate {
  schema: "v5-local-r2-fresh-payload-construction/1"; checkpointId: "portable-runtime/v28";
  targetId: string; schemaSha256: string; sourceImageSha256: string; destinationImageSha256: string;
  archiveSha256: string; publishedFiles: number; bytesPublished: number; persistedAttempts: true; jobAdmission: false;
  fullV28EnvelopeValidated: true; immutableShadowHistoryPreserved: true;
  destinationInstallationId: string; tables: number; rows: number;
  targetLedger: "reviewed-code-catalog"; rawMigrationExecution: false;
  accountsDisabled: true; collaborationEnabled: false; localBindingsRestored: false;
  executionEnabled: false; maintenanceState: "fenced";
  payloadPublication: true; recoveryReady: false; deploymentChanged: false;
}
interface RowGroup { spec: RecoveryTableSpec; rows: SystemRecoveryRow[] }
interface R2Destination {
  id: string; namespaceIdentity: string; snapshot: string; binding: ResolvedR2ProfileBinding; profile: RecoveryDestinationProfile;
}
interface OwnedAdmission {
  admission: V5LocalR2PayloadAdmissionCandidate; manifest: SystemBackupManifestV5; records: SystemBackupRecordsV5;
  destinationTables: Record<string, SystemRecoveryTable>; rowGroups: RowGroup[];
  destinations: readonly R2Destination[]; sourceMarker: string; claimToken: string;
  archive: { source: ArchiveSource; original: ArchiveSource; read: ArchiveSource["read"]; open: ArchiveSource["open"];
    sha256: string; entries: readonly ArchiveIndexEntry[] };
  files: readonly RecoveryPlannedFile[]; appends: Record<string, ExportRow[]>; changes: V5PayloadImageChangeCandidate[];
  construction?: Promise<V5LocalR2PayloadConstructionCandidate>;
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
  const profile: RecoveryDestinationProfile = { id, adapterType: "r2", namespaceIdentity, configurationRevision: 1,
    configurationSource: "bootstrap", credentialReference: null, createdAt: row.created_at,
    runtime: { state: "read_only", registered_at: row.created_at, activated_at: null, retired_at: null },
    metadataSha256: await sha256Hex(stableJson(row)) };
  return { id, namespaceIdentity, binding, snapshot: stableJson(row), profile };
}

/** Explicit fresh-only candidate. The owner admits an entire V5 archive,
 * constructs only its isolated RECOVERY_DB and conditionally publishes verified
 * LOCAL members to explicit installation-owned R2 profiles. It never activates
 * execution, changes a source binding, admits a served target or reports ready. */
export function createWorkerV5LocalR2PayloadCandidate(env: Env) {
  const sourceBinding = env.DB, targetBinding = env.RECOVERY_DB, targetId = env.RECOVERY_TARGET_ID;
  const admissions = new WeakMap<V5LocalR2PayloadAdmissionCandidate, OwnedAdmission>();
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
    archive: ArchiveSource; expectedArchiveSha256: string; expectedTargetId: string; mapping: readonly SystemRecoveryStorageMapping[];
    signal?: AbortSignal;
  }): Promise<V5LocalR2PayloadAdmissionCandidate> {
    const expectedTargetId = input.expectedTargetId, expectedArchiveSha256 = input.expectedArchiveSha256;
    const originalArchive = input.archive, read = originalArchive.read, open = originalArchive.open;
    const archiveSource: ArchiveSource = { byteSize: originalArchive.byteSize, read: read.bind(originalArchive),
      ...(open ? { open: open.bind(originalArchive) } : {}) };
    const mapping = structuredClone(input.mapping);
    ensure(/^[a-f0-9]{64}$/.test(expectedArchiveSha256), "original_archive_digest");
    const archive = await admitV5SystemBackupArchiveCandidate(archiveSource, { expectedSha256: expectedArchiveSha256, signal: input.signal });
    ensure(text(expectedTargetId, 128) && /^[A-Za-z0-9_-]+$/.test(expectedTargetId), "target_identity");
    // Own caller data before any asynchronous validator or metadata read.
    const copied = structuredClone({ manifest: archive.manifest, records: archive.records, mapping });
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
    const admission = freeze<V5LocalR2PayloadAdmissionCandidate>({ kind: "v5-local-r2-fresh-payload-admission/1",
      checkpointId: "portable-runtime/v28", expectedTargetId, schemaSha256: catalog.schemaSha256,
      sourceImageSha256: await sha256Hex(stableJson(records.image)), destinationInstallationId, destinationIncarnation,
      atomicRowStatements: groups.length + 2, tables: catalog.tables.length,
      rows: Object.values(destinationTables).reduce((sum, table) => sum + table.rows.length, 0), mappings: payloads,
      rawMigrationExecution: false, payloadPublication: false, executionEnabled: false });
    const files = await planV5LocalR2FilesCandidate(records, manifest, payloads,
      [...destinations.values()].map(destination => destination.profile), destinationIncarnation);
    for (const file of files) ensure(recoveryFilePublicationStatements(target, file,
      { byteSize: file.byteSize, sha256: file.sha256 }, new Date().toISOString()).length + 3 <= MAX_STATEMENTS,
    "atomic_publication_budget");
    admissions.set(admission, { admission, manifest: freeze(manifest), records: freeze(records),
      destinationTables: freeze(destinationTables), rowGroups: freeze(groups), destinations: [...destinations.values()], sourceMarker: marker, claimToken,
      archive: { source: archiveSource, original: originalArchive, read, open, sha256: expectedArchiveSha256, entries: freeze(archive.entries) },
      files: freeze(files), appends: {}, changes: [] });
    return admission;
  }
  function owned(admission: V5LocalR2PayloadAdmissionCandidate): OwnedAdmission {
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
    const objects = await schema(target);
    const inspection = await inspectV28CloudflareSchemaCandidate(objects);
    const applicationTables = inspection.applicationObjects.filter(object => object.type === "table").map(object => object.name).sort();
    ensure(stableJson(applicationTables) === stableJson(catalog.tables.map(table => table.name).sort()), "consistency_catalog_coverage");
    const observed: Record<string, SystemRecoveryTable> = {};
    for (const spec of catalog.tables) {
      if (claimPresent && spec.name === "system_recovery_target_claim") continue;
      observed[spec.name] = await readTable(target, spec);
    }
    verifyV5PayloadImageCandidate(observed, record.destinationTables, record.appends, record.changes);
    const keys = await target.prepare("PRAGMA foreign_key_check").all<Record<string, unknown>>();
    ensure(keys.success && keys.results.length === 0, "foreign_keys_invalid");
    // The complete V28 schema exceeds workerd's SQLite VDBE compiler budget
    // for a whole quick_check. Check every reviewed application/ledger/sequence
    // table and its indexes individually, plus SQLite's schema/freelist check.
    // Exact schema admission above permits only the two separately reviewed
    // Cloudflare platform tables to be omitted from native partial checks.
    // Cross-table page ownership/unused pages require a whole check on the
    // exact closed native file; the original qualification supplies that proof.
    const checkedTables = ["sqlite_schema", ...objects.filter(object => object.type === "table"
      && object.name !== "_cf_KV" && object.name !== "_cf_METADATA").map(object => object.name)].sort();
    ensure(new Set(checkedTables).size === checkedTables.length, "consistency_table_coverage");
    for (const name of checkedTables) {
      const integrity = await target.prepare(`PRAGMA quick_check(${quote(name)})`).all<Record<string, unknown>>();
      ensure(integrity.success && integrity.results.length === 1 && Object.values(integrity.results[0])[0] === "ok",
        `table_integrity_invalid:${name}`);
    }
    return sha256Hex(stableJson(observed));
  }
  function freshRegistryRowid(target: D1Database, table: "storage_profiles" | "file_locations") {
    // Fresh construction has no installed rowid-claim triggers yet. Admit the
    // exact next SQLite rowid before any byte transport and recheck atomically
    // with its append; a previously claimed/deleted rowid is never reused.
    return target.prepare(`SELECT CASE WHEN (SELECT COALESCE(MAX(rowid),0) FROM ${quote(table)})<9223372036854775807
      AND NOT EXISTS(SELECT 1 FROM file_registry_rowid_claims WHERE registry_name=?
        AND claimed_rowid=(SELECT COALESCE(MAX(rowid),0)+1 FROM ${quote(table)}))
      THEN 1 ELSE json('V5 fresh registry rowid was already claimed') END`).bind(table);
  }
  function append(record: OwnedAdmission, table: string, row: ExportRow) {
    (record.appends[table] ??= []).push(structuredClone(row));
  }
  async function publishFiles(target: D1Database, source: D1Database, record: OwnedAdmission,
    available: () => Promise<void>, batch: (statements: D1PreparedStatement[], guarded?: boolean) => Promise<void>, signal?: AbortSignal) {
    await available();
    await admitV5SystemBackupArchiveCandidate(record.archive.source, { expectedSha256: record.archive.sha256, signal });
    await available();
    for (const destination of record.destinations) {
      const profile = destination.profile, prior = record.records.content.tables.storage_profiles.find(row => row.id === profile.id);
      const profileRow: ExportRow = { id: profile.id, adapter_type: "r2", namespace_identity: profile.namespaceIdentity,
        configuration_source: "bootstrap", credential_reference: null, configuration_revision: 1, state: "historical", created_at: profile.createdAt };
      const runtimeRow: ExportRow = { storage_profile_id: profile.id, state: "read_only", registered_at: profile.createdAt,
        activated_at: profile.runtime!.activated_at, retired_at: null };
      if (prior) {
        ensure(stableJson(prior) === stableJson(profileRow) && stableJson(record.records.content.tables.storage_profile_runtime
          .find(row => row.storage_profile_id === profile.id)) === stableJson(runtimeRow), "destination_history_collision");
      } else {
        const histories = (["storage_profiles", "storage_profile_runtime"] as const).map(table => {
          const row = table === "storage_profiles" ? profileRow : runtimeRow, spec = FILE_SHADOW_DEPENDENCY_SPECS[table];
          const dependencyKey = stableJson(spec.keyColumns.map(column => row[column]));
          ensure(!record.records.content.tables.file_shadow_dependency_versions.some(version =>
            version.dependency_kind === table && version.dependency_key === dependencyKey), "destination_dependency_history_collision");
          return { dependency_kind: table, dependency_key: dependencyKey, revision: 1, present: 1,
            snapshot_json: stableJson(Object.fromEntries(spec.snapshotColumns.map(column => [column, row[column]]))) };
        });
        await batch([freshRegistryRowid(target, "storage_profiles"), ...recoveryDestinationProfileStatements(target, [profile]),
          ...histories.map(row => target.prepare("INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json) VALUES(?,?,?,?,?)")
            .bind(row.dependency_kind, row.dependency_key, row.revision, row.present, row.snapshot_json))]);
        append(record, "storage_profiles", profileRow); append(record, "storage_profile_runtime", runtimeRow);
        for (const row of histories) append(record, "file_shadow_dependency_versions", row);
      }
    }
    for (const file of record.files) {
      const entry = record.archive.entries.find(entry => entry.path === file.archivePath);
      const destination = record.destinations.find(destination => destination.id === file.destinationProfileId);
      ensure(entry && entry.kind === "payload" && entry.byteSize === file.byteSize && entry.sha256 === file.sha256 && destination,
        "original_payload_entry");
      const attempt: ExportRow = { job_id: record.claimToken, logical_id: file.id, source_blob_id: file.sourceId,
        file_id: file.fileId, location_id: file.locationId, profile_id: file.destinationProfileId,
        namespace: file.destinationNamespaceIdentity, object_key: file.objectKey, purpose: file.purpose,
        byte_size: file.byteSize, sha256: file.sha256, state: "pending", owner_token: null, generation: null,
        incarnation: record.admission.destinationIncarnation, verified_at: null };
      await batch([target.prepare(`INSERT INTO system_recovery_target_files(job_id,logical_id,source_blob_id,file_id,location_id,
        profile_id,namespace,object_key,purpose,byte_size,sha256,incarnation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(record.claimToken, file.id, file.sourceId, file.fileId, file.locationId, file.destinationProfileId,
          file.destinationNamespaceIdentity, file.objectKey, file.purpose, file.byteSize, file.sha256, record.admission.destinationIncarnation)]);
      async function providerCurrent() {
        await available(); await claimGuard(target, record).first(); await available();
      }
      const rawReader = r2ByteReader(destination.binding.bucket), rawWriter = r2ShadowByteWriter({
        async put(key, body, options) {
          ensure(key === file.objectKey, "destination_key_changed"); await providerCurrent();
          const result = await destination!.binding.bucket.put(key, body, { ...options, onlyIf: { etagDoesNotMatch: "*" } });
          ensure(result !== null, "destination_key_already_exists"); return result;
        },
      });
      const reader = { async read(key: string) { ensure(key === file.objectKey, "destination_key_changed");
        await providerCurrent(); const result = await rawReader.read(key);
        try { await providerCurrent(); } catch (error) {
          if (result.outcome === "available") try { await result.body.cancel(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "Original V5 read fence and body close failed"); }
          throw error;
        }
        return result;
      } };
      await available(); await freshRegistryRowid(target, "file_locations").first(); await available();
      const body = await openStoreArchiveEntry(record.archive.source, entry, { signal });
      let putStarted = false;
      try {
        const verified = await writeVerifiedBytes({ reader, createHash: cloudflareSha256, writer: { accepts: rawWriter.accepts,
          async write(input) {
            ensure(!putStarted, "original_put_replay"); await providerCurrent();
            await batch([target.prepare("UPDATE system_recovery_target_files SET state='write_started',owner_token=?,generation=0 WHERE job_id=? AND logical_id=? AND state='pending'")
              .bind(record.claimToken, record.claimToken, file.id),
            target.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_target_files WHERE job_id=? AND logical_id=? AND state='write_started' AND owner_token=? AND generation=0) THEN 1 ELSE json('V5 payload ownership changed') END")
              .bind(record.claimToken, file.id, record.claimToken)]);
            putStarted = true; await providerCurrent(); await rawWriter.write(input);
          },
        } }, { body, key: file.objectKey, byteSize: file.byteSize, sha256: file.sha256, contentType: file.contentType, filename: file.filename });
        await available(); const now = new Date().toISOString();
        await batch([target.prepare("UPDATE system_recovery_target_files SET state='verified',verified_at=? WHERE job_id=? AND logical_id=? AND state='write_started' AND owner_token=? AND generation=0")
          .bind(now, record.claimToken, file.id, record.claimToken),
        target.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_target_files WHERE job_id=? AND logical_id=? AND state='verified' AND verified_at=? AND owner_token=? AND generation=0) THEN 1 ELSE json('V5 readback receipt changed') END")
          .bind(record.claimToken, file.id, now, record.claimToken)]);
        const statements = recoveryFilePublicationStatements(target, file, verified, now);
        ensure(statements.length + 3 <= MAX_STATEMENTS, "atomic_publication_budget");
        await batch([freshRegistryRowid(target, "file_locations"), ...statements, target.prepare("UPDATE system_recovery_target_files SET state='published' WHERE job_id=? AND logical_id=? AND state='verified' AND verified_at=?")
          .bind(record.claimToken, file.id, now)]);
        append(record, "file_locations", { id: file.locationId, file_id: file.fileId, storage_profile_id: file.destinationProfileId,
          object_key: file.objectKey, state: "unresolved", created_at: now });
        append(record, "file_location_publications", { location_id: file.locationId, file_id: file.fileId, storage_profile_id: file.destinationProfileId,
          object_key: file.objectKey, verified_byte_size: file.byteSize, verified_sha256: file.sha256, verification_method: "full_read_sha256",
          verification_operation_id: "fp5:" + file.id, verified_at: now, published_at: now });
        for (const [table, rows] of Object.entries(recoveryFileEvidenceRows(file, now))) for (const row of rows) append(record, table, row);
        if (file.publishAsActive) record.changes.push({ table: "file_publications", keys: { file_id: file.fileId }, column: "active_location_id", value: file.locationId });
        append(record, "system_recovery_target_files", { ...attempt, state: "published", owner_token: record.claimToken, generation: 0, verified_at: now });
      } catch (error) {
        // A rejected acknowledgement may follow a committed conditional PUT.
        // Save uncertainty under the exact original owner, never retry/delete.
        // Original work stays the first error even if settlement cannot finish.
        try {
          bindings(record.admission.expectedTargetId);
          const results = await target.batch([target.prepare(`UPDATE system_recovery_target_files SET state='unknown'
            WHERE job_id=? AND logical_id=? AND state='write_started' AND owner_token=? AND generation=0
              AND EXISTS(SELECT 1 FROM system_recovery_target_claim WHERE singleton=1 AND owner_token=? AND generation=0)`)
            .bind(record.claimToken, file.id, record.claimToken, record.claimToken),
            target.prepare("UPDATE system_recovery_target_claim SET cursor_json=? WHERE singleton=1 AND owner_token=? AND generation=0")
              .bind(stableJson({ phase: "files", originalRejected: true, logicalId: file.id, putStarted }), record.claimToken)]);
          ensure(results.every(result => result.success), "original_failure_settlement");
        } catch (settlement) { throw new AggregateError([error, settlement], "Original V5 payload work and uncertainty settlement failed"); }
        throw error;
      }
    }
    // The first destination construction occurs before trusted triggers are
    // installed. Preserve historical claims, add only exact new registry rowids.
    await batch([target.prepare(`INSERT INTO file_registry_rowid_claims(registry_name,claimed_rowid)
      SELECT 'storage_profiles',rowid FROM storage_profiles WHERE NOT EXISTS(SELECT 1 FROM file_registry_rowid_claims c WHERE c.registry_name='storage_profiles' AND c.claimed_rowid=storage_profiles.rowid)
      UNION ALL SELECT 'file_locations',rowid FROM file_locations WHERE NOT EXISTS(SELECT 1 FROM file_registry_rowid_claims c WHERE c.registry_name='file_locations' AND c.claimed_rowid=file_locations.rowid)`)]);
    for (const table of ["storage_profiles", "file_locations"]) {
      const spec = catalog.tables.find(spec => spec.name === table); ensure(spec, "registry_table");
      const actual = await readTable(target, spec), idIndex = spec.columns.indexOf("id");
      for (const approved of record.appends[table] ?? []) {
        const row = actual.rows.find(row => row.cells[idIndex].type === "text" && row.cells[idIndex].value === approved.id);
        ensure(row && row.rowid !== null, "new_registry_rowid");
        append(record, "file_registry_rowid_claims", { registry_name: table, claimed_rowid: row.rowid });
      }
    }
    // All old shadow occurrences, closures, heads and dependency rows remain
    // byte-exact. This first slice rejects current heads before construction;
    // a later bound-File slice must append proper successor history instead.
    // Source is read-only custody/authority; no source database statement above
    // is a write. The captured source reference is rechecked before returning.
    ensure(source === primaryD1(sourceBinding), "source_binding_changed");
  }
  async function verifyPayloadBytes(target: D1Database, record: OwnedAdmission, available: () => Promise<void>) {
    for (const file of record.files) {
      const destination = record.destinations.find(destination => destination.id === file.destinationProfileId);
      ensure(destination, "destination_missing"); const raw = r2ByteReader(destination.binding.bucket);
      const reader = { async read(key: string) {
        ensure(key === file.objectKey, "destination_key_changed"); await available(); await claimGuard(target, record).first();
        await available(); const result = await raw.read(key);
        try { await available(); } catch (error) {
          if (result.outcome === "available") try { await result.body.cancel(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "Original final V5 read fence and close failed"); }
          throw error;
        }
        return result;
      } };
      await verifyStoredBytes(reader, file.objectKey, file, cloudflareSha256); await available();
    }
  }
  async function verifyPublicationGraph(target: D1Database, record: OwnedAdmission) {
    const names = new Set(["files", "storage_profiles", "file_locations", "file_location_publications", ...Object.keys(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS)]);
    const tables: ExportTables = {};
    for (const spec of catalog.tables.filter(spec => names.has(spec.name))) {
      const actual = await readTable(target, spec);
      tables[spec.name] = actual.rows.map(row => Object.fromEntries(spec.columns.map((column, index) => {
        const cell = row.cells[index];
        ensure(cell.type !== "blob" && (cell.type !== "integer" || Number.isSafeInteger(Number(cell.value))), "evidence_scalar");
        return [column, cell.type === "null" ? null : cell.type === "integer" || cell.type === "real" ? Number(cell.value) : cell.value];
      })));
    }
    const history = validateSystemRecoveryEvidenceHistoryV28(tables);
    ensure(record.files.every(file => history.publishedLocations.has(file.locationId)), "published_mapping_evidence");
    ensure((await target.prepare(FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL).first<{ invalid_count: number }>())?.invalid_count === 0, "registry_claims_invalid");
    ensure((await target.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).first<{ invalid_count: number }>())?.invalid_count === 0, "derived_shadow_heads_invalid");
    // A classified typed image alone is insufficient for V28 rebackup. Admit
    // the entire current business envelope and its protected LOCAL history from
    // one original primary batch, before the destination ledger is sealed.
    const contentSql = nativeV28SnapshotSql(), nonlocal = catalog.tables.filter(spec => !spec.local);
    const snapshot = await target.batch([...contentSql, ...nonlocal.map(recoveryTableSnapshotSql)].map(sql => target.prepare(sql)));
    ensure(snapshot.length === contentSql.length + nonlocal.length && snapshot.every(result => result.success), "full_v28_snapshot");
    const imageTables = Object.fromEntries(nonlocal.map((spec, index) => [spec.name, { columns: [...spec.columns],
      rows: snapshot[contentSql.length + index].results.map(value => {
        const row = value as { rowid: string | null; cells: string }; return { rowid: row.rowid, cells: JSON.parse(row.cells) };
      }) }]));
    const protectedHistory = protectedLocalHistoryFromV5Image({ ...record.records.image, tables: imageTables });
    let applicationObjects: ExportSchemaObject[] | undefined;
    const business = await buildFullExportV28FromSnapshot(snapshot.slice(0, contentSql.length), { backupHoldOwner: null,
      protectedLocalHistory: protectedHistory, async projectSchema(objects) {
        const inspected = await inspectV28CloudflareSchemaCandidate(objects);
        applicationObjects = inspected.applicationObjects; return portableBusinessSchemaV28(applicationObjects);
      } });
    ensure(applicationObjects, "full_v28_schema");
    const content = await createFullExportV28(business, applicationObjects, protectedHistory);
    const image = validateSystemRecoveryImageV5({ version: 5, kind: "system-recovery-image", checkpointId: catalog.checkpointId,
      schemaSha256: catalog.schemaSha256, sourceSnapshotClock: content.artifacts.sourceSchema.value.snapshotClock, tables: imageTables });
    await validateSystemBackupContentImageV28(content, image);
  }
  async function constructOwned(record: OwnedAdmission, current: () => Promise<boolean>, signal?: AbortSignal): Promise<V5LocalR2PayloadConstructionCandidate> {
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
      ensure(record.archive.original.byteSize === record.archive.source.byteSize
        && record.archive.original.read === record.archive.read && record.archive.original.open === record.archive.open,
      "original_archive_custody_changed");
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
    await publishFiles(target, source, record, available, batch, signal);
    const triggers = catalog.schemaStatements.filter(object => object.type === "trigger");
    for (let index = 0; index < triggers.length; index += DDL_GROUP) await batch(triggers.slice(index, index + DDL_GROUP).map(object => target.prepare(object.sql)));
    await available(); await claimGuard(target, record).first(); await verifyImage(target, record, true);
    await verifyPublicationGraph(target, record); await verifyPayloadBytes(target, record, available);
    await admitV5SystemBackupArchiveCandidate(record.archive.source, { expectedSha256: record.archive.sha256, signal });
    await available();
    // Only the reviewed target catalog produces its ledger, after exact DDL,
    // preserved typed rows, classified append/mapping proof and FK/table checks.
    // Source receipts are evidence; this never marks a recovery job ready.
    await batch([...(await recoveryMigrationLedgerStatements(target, catalog.migrations)),
      target.prepare("DELETE FROM system_recovery_target_claim WHERE singleton=1 AND challenge=?").bind(record.claimToken)]);
    await available(); await inspectRecoveryMigrationLedger(target, true, catalog.migrations);
    const destinationImageSha256 = await verifyImage(target, record, false);
    await verifyPublicationGraph(target, record);
    await available();
    await admitV5SystemBackupArchiveCandidate(record.archive.source, { expectedSha256: record.archive.sha256, signal });
    await available();
    return freeze<V5LocalR2PayloadConstructionCandidate>({ schema: "v5-local-r2-fresh-payload-construction/1", checkpointId: "portable-runtime/v28",
      targetId: record.admission.expectedTargetId, schemaSha256: catalog.schemaSha256, sourceImageSha256: record.admission.sourceImageSha256,
      destinationImageSha256, destinationInstallationId: record.admission.destinationInstallationId,
      archiveSha256: record.archive.sha256, publishedFiles: record.files.length,
      bytesPublished: record.files.reduce((sum, file) => sum + file.byteSize, 0), persistedAttempts: true, jobAdmission: false,
      fullV28EnvelopeValidated: true, immutableShadowHistoryPreserved: true,
      tables: record.admission.tables,
      rows: record.admission.rows + Object.values(record.appends).reduce((sum, rows) => sum + rows.length, 0), targetLedger: "reviewed-code-catalog", rawMigrationExecution: false,
      accountsDisabled: true, collaborationEnabled: false, localBindingsRestored: false, executionEnabled: false, maintenanceState: "fenced",
      payloadPublication: true, recoveryReady: false, deploymentChanged: false });
  }
  function construct(admission: V5LocalR2PayloadAdmissionCandidate, current: () => Promise<boolean>, signal?: AbortSignal) {
    const record = owned(admission);
    // Preserve the same first Promise/rejection. An incomplete target is never
    // erased or replayed by another call with the same issued admission.
    return record.construction ??= constructOwned(record, current, signal);
  }
  return Object.freeze({ admit, construct });
}

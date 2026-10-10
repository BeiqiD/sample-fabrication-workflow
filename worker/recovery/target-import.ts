import type { Env } from "../types";
import { primaryD1 } from "../d1-primary";
import { stableJson, sha256Hex } from "../../shared/domain/content-addressing";
import type { SystemBackupFile } from "../../shared/contracts/system-backup";
import type { SystemRecoveryStorageMapping } from "../../shared/contracts/system-recovery";
import { recoveryCellBinding, type RecoveryTableSpec, type SystemRecoveryRow } from "../../shared/contracts/system-recovery-image";
import { RECOVERY_SCHEMA_STATEMENTS, RECOVERY_TABLES } from "./trusted-schema";
import { selectReviewedRecoveryCatalog, validateRecoverySourceImage, recoveryDestinationTable,
  type VersionedRecoveryRecords, type VersionedRecoveryManifest } from "./versioned-catalog";
import { validateSystemBackupDocumentsV2 } from "../../shared/contracts/system-backup-v2";
import { inspectCurrentCloudflareSchema, stripReviewedCurrentCloudflarePlatformSchema } from "./current-cloudflare-schema";
import { isRecoverySeedTable, readRecoveryTable, recoveryIdentifier, assertRecoveredCapabilitiesInert } from "./protected-settings";
import { planRecoveryFiles, recoveryDestinationProfileStatements, recoveryFilePublicationStatements, writeRecoveryFile,
  type RecoveryDestinationProfile, type RecoveryPlannedFile } from "./target-files";
import { verifyRecoveryTarget, type RecoveryVerification } from "./verification";
import { createSystemRecoveryReport, type SystemRecoveryReport } from "./report";
import { openShadowProfile } from "../files/shadow-profile";
import { verifyStoredBytes } from "../files/byte-verification";
import { resolveR2ProfileBinding } from "../files/r2-profile-bindings";
import { inspectRecoveryMigrationLedger, inspectRecoveryPlatformSchema, recoveryMigrationLedgerStatements } from "./target-migrations";
import { canonicalFileAuthoritySchemaSql } from "../../shared/contracts/export-file-authority";

const MAX_ATOMIC_STATEMENTS = 128, MAX_GROUP_BYTES = 83 * 1024, DDL_GROUP = 16;
const encoder = new TextEncoder();
type TargetEnvironment = Env & { RECOVERY_DB?: D1Database; RECOVERY_TARGET_ID?: string };
type TargetPhase = "schema" | "rows" | "files" | "reinstall" | "verify" | "ready";
interface TargetCursor { phase: TargetPhase; schemaIndex: number; fileIndex: number; empty: boolean; dropped: boolean }
interface TargetClaim {
  singleton: number; target_id: string; job_id: string; incarnation: string; challenge: string;
  schema_sha256: string; image_sha256: string; status: string; cursor_json: string; verified_at: string | null;
  owner_token: string | null; generation: number; runtime_incarnation: string | null; lease_expires_at: string | null;
}
export interface RecoveryTargetInput {
  jobId: string; incarnation: string; ownerToken: string; generation: number; expectedTargetId: string;
  records: VersionedRecoveryRecords; manifest: VersionedRecoveryManifest; mapping: SystemRecoveryStorageMapping[];
  mode: "historical" | "planned"; current: () => Promise<boolean>;
  runtimeIncarnation?: string; leaseExpiresAt?: string;
  openPayload: (file: SystemBackupFile, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
  signal?: AbortSignal;
}
export type RecoveryTargetPreviewInput = Pick<RecoveryTargetInput,
  "jobId" | "incarnation" | "expectedTargetId" | "records" | "manifest" | "mapping" | "mode">;
export interface RecoveryTargetStepResult {
  phase: TargetPhase; completedFiles: number; bytesDone: number; done: boolean; report?: SystemRecoveryReport;
}
export class RecoveryTargetError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RecoveryTargetError"; }
}
function ensure(value: unknown, code: string): asserts value { if (!value) throw new RecoveryTargetError(code); }
const quote = recoveryIdentifier;
const TRANSPORT_TUPLE_SQL = `SELECT b.*,r.namespace_json,r.credential_ref AS configuration_credential_ref,
  e.envelope_revision AS current_envelope_revision,e.envelope_version,e.key_id,e.nonce,e.ciphertext
  FROM system_storage_native_bindings b
  JOIN system_storage_configuration_revisions r ON r.profile_id=b.candidate_profile_id AND r.revision=b.candidate_revision
  JOIN system_storage_credential_payloads e ON e.credential_ref=b.credential_ref
  WHERE b.storage_profile_id=?`;
async function transportFence(env: TargetEnvironment, profile: Pick<RecoveryDestinationProfile,"id"|"adapterType"|"namespaceIdentity"|"configurationRevision">,
  tuple?: Record<string, unknown> | null) {
  if (profile.adapterType === "r2") {
    const binding = resolveR2ProfileBinding(env, { id: profile.id, configurationRevision: 1, namespaceIdentity: profile.namespaceIdentity }, { allowLegacyBootstrap: true });
    return sha256Hex(stableJson({ bindingName: binding.bindingName, namespaceIdentity: binding.namespaceIdentity,
      declarations: binding.rawMappings ?? null, bootstrapNamespace: binding.bootstrapNamespace ?? null }));
  }
  const value = tuple === undefined ? await primaryD1(env.DB).prepare(TRANSPORT_TUPLE_SQL).bind(profile.id).first<Record<string,unknown>>() : tuple;
  ensure(value, "recovery_mapping_unavailable");
  // Only the digest of the encrypted envelope participates in this fence.
  // No credentials or local native binding are copied to the recovery target.
  return sha256Hex(stableJson(value));
}
function id(value: string) { ensure(typeof value === "string" && /^[A-Za-z0-9_:.-]{1,256}$/.test(value), "invalid_target_identity"); }
function imageGroups(records: VersionedRecoveryRecords) {
  const catalog = selectReviewedRecoveryCatalog(records);
  const groups: Array<{ spec: RecoveryTableSpec; rows: SystemRecoveryRow[] }> = [];
  for (const spec of catalog.tables.filter(table => !table.local)) {
    const rows = recoveryDestinationTable(records, spec.name).rows; ensure(rows, "missing_image_table");
    let group: SystemRecoveryRow[] = [], bytes = 2;
    for (const row of rows) {
      const length = encoder.encode(stableJson(row)).length + 1;
      ensure(length <= MAX_GROUP_BYTES, "atomic_row_budget");
      if (group.length && bytes + length > MAX_GROUP_BYTES) { groups.push({ spec, rows: group }); group = []; bytes = 2; }
      group.push(row); bytes += length;
    }
    if (group.length) groups.push({ spec, rows: group });
  }
  return groups;
}
function groupInsert(database: D1Database, spec: RecoveryTableSpec, rows: SystemRecoveryRow[]) {
  const cell = (index: number) => {
    const type = `json_extract(value,'$.cells[${index}].type')`, value = `json_extract(value,'$.cells[${index}].value')`;
    return `CASE ${type} WHEN 'integer' THEN CAST(${value} AS INTEGER) WHEN 'real' THEN CAST(${value} AS REAL) WHEN 'blob' THEN unhex(${value}) WHEN 'text' THEN ${value} ELSE NULL END`;
  };
  const columns = spec.withoutRowid ? [...spec.columns] : ["rowid", ...spec.columns];
  const values = spec.withoutRowid ? spec.columns.map((_, index) => cell(index))
    : ["CAST(json_extract(value,'$.rowid') AS INTEGER)", ...spec.columns.map((_, index) => cell(index))];
  const sql = `INSERT INTO ${quote(spec.name)} (${columns.map(quote).join(",")}) SELECT ${values.join(",")} FROM json_each(?)`;
  ensure(encoder.encode(sql).length < MAX_GROUP_BYTES, "atomic_sql_budget");
  return database.prepare(sql).bind(stableJson(rows));
}
function singleRowInsert(database: D1Database, spec: RecoveryTableSpec, row: SystemRecoveryRow) {
  const cells = row.cells.map(recoveryCellBinding), columns = [...spec.columns];
  if (!spec.withoutRowid) { columns.unshift("rowid"); cells.unshift({ expression: "CAST(? AS INTEGER)", value: row.rowid }); }
  return database.prepare(`INSERT INTO ${quote(spec.name)} (${columns.map(quote).join(",")}) VALUES (${cells.map(cell => cell.expression).join(",")})`)
    .bind(...cells.map(cell => cell.value));
}
async function schemaObjects(database: D1Database) {
  const result = await database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND tbl_name NOT IN('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY type,name")
    .all<{ type: string; name: string; tableName: string; sql: string }>();
  ensure(result.success, "target_schema_unavailable"); return result.results;
}
async function marker(database: D1Database): Promise<string | null> {
  const table = await database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='system_recovery_runtime'").first();
  if (!table) return null;
  return (await database.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1").first<{ installation_id: string }>())?.installation_id ?? null;
}
async function sourceInstallation(database: D1Database): Promise<string | null> {
  const table = await database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='research_package_source_identity'").first();
  if (!table) return null;
  return (await database.prepare("SELECT installation_id FROM research_package_source_identity WHERE singleton=1").first<{ installation_id: string }>())?.installation_id ?? null;
}
export async function inspectRecoveryTargetFreshness(env: TargetEnvironment, expectedTargetId: string, records?: VersionedRecoveryRecords) {
  const catalog = records ? selectReviewedRecoveryCatalog(records) : undefined;
  ensure(env.RECOVERY_DB && env.RECOVERY_TARGET_ID === expectedTargetId && env.RECOVERY_DB !== env.DB, "recovery_target_unavailable");
  const target = primaryD1(env.RECOVERY_DB), source = primaryD1(env.DB);
  const [sourceMarker, targetMarker, sourceIdentity, targetIdentity] = await Promise.all([
    marker(source), marker(target), sourceInstallation(source), sourceInstallation(target),
  ]);
  ensure(!sourceMarker || targetMarker !== sourceMarker, "recovery_target_alias");
  ensure(!sourceIdentity || targetIdentity !== sourceIdentity, "recovery_target_alias");
  const objects = await schemaObjects(target);
  await inspectRecoveryPlatformSchema(target);
  await inspectRecoveryMigrationLedger(target, false, catalog?.migrations);
  if (catalog?.imageVersion === 2) {
    const all = await target.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name")
      .all<import("../../shared/contracts/export").ExportSchemaObject>();
    ensure(all.success, "target_schema_unavailable");
    if (!objects.length) {
      ensure(stripReviewedCurrentCloudflarePlatformSchema(all.results).applicationObjects.length === 0, "target_schema_not_reviewed");
      return { empty: true, target };
    }
    await inspectCurrentCloudflareSchema(all.results);
  }
  if (!objects.length) return { empty: true, target };
  const schemaTokens = (entries: readonly { type: string; name: string; tableName: string; sql: string }[]) =>
    entries.map(entry => ({ ...entry, sql: canonicalFileAuthoritySchemaSql(entry.sql) }));
  ensure(stableJson(schemaTokens(objects)) === stableJson(schemaTokens(catalog?.schemaStatements ?? RECOVERY_SCHEMA_STATEMENTS)), "target_schema_not_reviewed");
  for (const spec of catalog?.tables ?? RECOVERY_TABLES) ensure(isRecoverySeedTable(spec.name, await readRecoveryTable(target, spec.name, catalog), catalog), "target_not_fresh");
  const blobs = await target.prepare("SELECT hex(unhex('000102FF')) AS probe").first<{ probe: string }>();
  ensure(blobs?.probe === "000102FF", "native_exact_blob_restore_unsupported");
  return { empty: false, target };
}
async function destinationProfiles(env: TargetEnvironment, mapping: SystemRecoveryStorageMapping[], records: VersionedRecoveryRecords): Promise<RecoveryDestinationProfile[]> {
  const ids = [...new Set(mapping.map(value => value.destinationProfileId))];
  if (!ids.length) return [];
  const db = primaryD1(env.DB), placeholders = ids.map(() => "?").join(",");
  // All admitted nonsecret registration/runtime/history values are frozen at
  // one primary cutoff. Neither credential payloads nor local bindings enter
  // the target metadata closure.
  const results = await db.batch([
    db.prepare(`SELECT * FROM storage_profiles WHERE id IN(${placeholders}) ORDER BY id`).bind(...ids),
    db.prepare(`SELECT * FROM storage_profile_runtime WHERE storage_profile_id IN(${placeholders}) ORDER BY storage_profile_id`).bind(...ids),
    db.prepare(`SELECT * FROM storage_profile_admissions WHERE native_profile_id IN(${placeholders}) ORDER BY native_profile_id`).bind(...ids),
    db.prepare(`SELECT * FROM storage_profile_activations WHERE storage_profile_id IN(${placeholders}) ORDER BY storage_profile_id,binding_revision,operation_id`).bind(...ids),
    db.prepare(`SELECT * FROM file_shadow_dependency_versions WHERE dependency_kind IN('storage_profiles','storage_profile_runtime') AND json_extract(dependency_key,'$[0]') IN(${placeholders}) ORDER BY dependency_kind,dependency_key,revision`).bind(...ids),
    db.prepare(`SELECT * FROM file_shadow_profile_enablements WHERE storage_profile_id IN(${placeholders}) ORDER BY storage_profile_id`).bind(...ids),
    ...ids.map(profileId => db.prepare(TRANSPORT_TUPLE_SQL).bind(profileId)),
  ]);
  ensure(results.every(result => result.success), "recovery_mapping_unavailable");
  const values = results.map(result => result.results as Array<Record<string, string | number | null>>);
  return Promise.all(ids.map(async profileId => {
    const row = values[0].find(row => row.id === profileId), runtime = values[1].find(row => row.storage_profile_id === profileId);
    ensure(row && runtime && (row.adapter_type === "r2" || row.adapter_type === "s3") && row.configuration_revision === 1 && runtime.state === "read_write", "recovery_mapping_unavailable");
    const alreadyRecorded = records.content.tables.storage_profiles.some(profile => profile.id === profileId);
    const metadataRows = alreadyRecorded ? [] : [
      ...values[2].filter(row => row.native_profile_id === profileId).map(row => ({ table: "storage_profile_admissions" as const, row })),
      ...values[3].filter(row => row.storage_profile_id === profileId).map(row => ({ table: "storage_profile_activations" as const, row })),
      ...values[4].filter(row => JSON.parse(String(row.dependency_key))[0] === profileId).map(row => ({ table: "file_shadow_dependency_versions" as const, row })),
      ...values[5].filter(row => row.storage_profile_id === profileId).map(row => ({ table: "file_shadow_profile_enablements" as const, row })),
    ];
    const descriptor = { id: profileId, adapterType: row.adapter_type as "r2" | "s3", namespaceIdentity: String(row.namespace_identity), configurationRevision: 1,
      configurationSource: row.adapter_type === "r2" ? "bootstrap" as const : "system" as const, credentialReference: null,
      createdAt: String(row.created_at), runtime: { state: String(runtime.state), registered_at: String(runtime.registered_at),
        activated_at: runtime.activated_at === null ? null : String(runtime.activated_at), retired_at: runtime.retired_at === null ? null : String(runtime.retired_at) },
      metadataRows, metadataSha256: await sha256Hex(stableJson({ profile: row, runtime, metadataRows })) };
    return { ...descriptor, transportFenceSha256: await transportFence(env, descriptor, values[6 + ids.indexOf(profileId)][0] ?? null) };
  }));
}
function safeChunks(text: string) {
  const chunks: string[] = []; let chunk = "", bytes = 0;
  for (const character of text) {
    const length = encoder.encode(character).length;
    if (bytes + length > 48 * 1024 && chunk) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += character; bytes += length;
  }
  if (chunk) chunks.push(chunk); return chunks;
}
function claimGuard(database: D1Database, input: RecoveryTargetInput, imageSha256: string) {
  return database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_target_claim WHERE singleton=1 AND target_id=? AND job_id=? AND incarnation=? AND schema_sha256=? AND image_sha256=? AND status<>'failed'
    AND owner_token=? AND generation=? AND runtime_incarnation=? AND julianday(lease_expires_at)>julianday('now')) THEN 1 ELSE json('Recovery target ownership changed') END`)
    .bind(input.expectedTargetId, input.jobId, input.incarnation, selectReviewedRecoveryCatalog(input.records).schemaSha256, imageSha256,
      input.ownerToken, input.generation, input.runtimeIncarnation ?? input.incarnation);
}
function atomicBudget(records: VersionedRecoveryRecords) {
  const catalog = selectReviewedRecoveryCatalog(records);
  const groups = imageGroups(records);
  const seedDeletes = catalog.tables.filter(spec => !spec.local && catalog.seedTableRows[spec.name]?.rows.length).length;
  const localSeeds = catalog.tables.filter(spec => spec.local && !spec.name.startsWith("system_recovery_")).reduce((total, spec) => total + catalog.seedTableRows[spec.name].rows.length, 0);
  const chunks = safeChunks(stableJson(records.image));
  const commands = 5 + seedDeletes + groups.length + localSeeds + chunks.length;
  ensure(commands <= MAX_ATOMIC_STATEMENTS, "atomic_restore_budget");
  return { groups, chunks, commands };
}
/** Archive production remains useful when the bounded website restore cannot
 * atomically publish this row graph. This check admits no target or provider. */
export function recoveryTargetRestoreBudget(records:VersionedRecoveryRecords) {
  try {
    validateRecoverySourceImage(records);
    return {available:true,reason:null,atomicStatements:atomicBudget(records).commands} as const;
  }catch(error){
    return {available:false,reason:error instanceof RecoveryTargetError?error.code:'recovery_image_not_admitted',atomicStatements:0} as const;
  }
}
export function createRecoveryTargetEngine(env: TargetEnvironment) {
  const targetBinding = env.RECOVERY_DB, sourceBinding = env.DB;
  async function prepare(input: RecoveryTargetPreviewInput) {
    id(input.jobId); id(input.incarnation); id(input.expectedTargetId);
    const catalog = selectReviewedRecoveryCatalog(input.records);
    validateRecoverySourceImage(input.records);
    ensure(input.manifest.schema === (catalog.imageVersion === 2 ? "system-backup/2" : "system-backup/1"), "recovery_version_pair");
    if (input.records.schema === "system-backup-records/2") await validateSystemBackupDocumentsV2(input.manifest, input.records);
    ensure(input.manifest.completeness === "complete" && input.manifest.files.every(file => file.outcome === "packaged"), "partial_backup_not_complete_recovery");
    const budget = atomicBudget(input.records);
    let profiles: RecoveryDestinationProfile[] | undefined;
    if (env.RECOVERY_DB && await env.RECOVERY_DB.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='system_recovery_target_provenance'").first()) {
      const saved = (await env.RECOVERY_DB.prepare("SELECT chunk,image_sha256 FROM system_recovery_target_provenance WHERE job_id=? ORDER BY ordinal")
        .bind(`${input.jobId}#destination-plan`).all<{ chunk: string; image_sha256: string }>()).results;
      if (saved.length) {
        const json = saved.map(row => row.chunk).join(""); ensure(saved.every(row => row.image_sha256 === saved[0].image_sha256)
          && await sha256Hex(json) === saved[0].image_sha256, "destination_metadata_provenance_changed");
        profiles = JSON.parse(json);
      }
    }
    profiles ??= await destinationProfiles(env, input.mapping, input.records);
    const metadataText = stableJson(profiles);
    ensure(encoder.encode(metadataText).length <= 1024 * 1024 && safeChunks(metadataText).length + 1 <= MAX_ATOMIC_STATEMENTS, "destination_metadata_budget");
    const files = await planRecoveryFiles(input.records, input.manifest.files, input.mapping, profiles, input.incarnation);
    ensure(files.length <= 100 && files.reduce((total, file) => total + file.byteSize, 0) <= 96 * 1024 * 1024, "recovery_file_budget");
    return { catalog, budget, profiles, files, imageSha256: await sha256Hex(stableJson(input.records.image)) };
  }
  async function preview(input: RecoveryTargetPreviewInput) {
    try {
      const plan = await prepare(input); await inspectRecoveryTargetFreshness(env, input.expectedTargetId, input.records);
      return { available: true as const, reason: null, atomicStatements: plan.budget.commands, files: plan.files.length,
        bytes: plan.files.reduce((total, file) => total + file.byteSize, 0), imageSha256: plan.imageSha256 };
    } catch (error) { return { available: false as const, reason: error instanceof RecoveryTargetError ? error.code : "recovery_preflight_failed", atomicStatements: 0, files: 0, bytes: 0, imageSha256: null }; }
  }
  async function existingClaim(target: D1Database) {
    if (!await target.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='system_recovery_target_claim'").first()) return null;
    return target.prepare("SELECT * FROM system_recovery_target_claim WHERE singleton=1").first<TargetClaim>();
  }
  async function current(input: RecoveryTargetInput, target: D1Database, imageSha256: string) {
    ensure(!input.signal?.aborted && await input.current(), "recovery_actor_or_lease_changed");
    ensure(env.DB===sourceBinding,"recovery_source_binding_changed");
    ensure(env.RECOVERY_DB && env.RECOVERY_DB === targetBinding && env.RECOVERY_TARGET_ID === input.expectedTargetId, "recovery_target_changed");
    await claimGuard(target, input, imageSha256).first();
    const collision = await primaryD1(env.DB).prepare("SELECT challenge FROM system_recovery_target_claim WHERE singleton=1").first<{ challenge: string }>();
    const claimed = await existingClaim(target);
    ensure(claimed && collision?.challenge !== claimed.challenge, "recovery_target_alias");
  }
  async function persist(target: D1Database, input: RecoveryTargetInput, imageSha256: string, cursor: TargetCursor, status: string) {
    await current(input, target, imageSha256);
    await target.batch([claimGuard(target, input, imageSha256), target.prepare("UPDATE system_recovery_target_claim SET status=?,cursor_json=? WHERE singleton=1")
      .bind(status, stableJson(cursor))]);
  }
  async function boundedWrites(target: D1Database, input: RecoveryTargetInput, imageSha256: string, statements: D1PreparedStatement[]) {
    for (let index = 0; index < statements.length; index += 96) {
      await current(input, target, imageSha256);
      await target.batch([claimGuard(target, input, imageSha256), ...statements.slice(index, index + 96)]);
    }
  }
  async function providerCurrent(input: RecoveryTargetInput, target: D1Database, imageSha256: string,
    file: RecoveryPlannedFile, profiles: readonly RecoveryDestinationProfile[]) {
    await current(input, target, imageSha256);
    const frozen = profiles.find(profile => profile.id === file.destinationProfileId);
    ensure(frozen && frozen.transportFenceSha256 && await transportFence(env, frozen) === frozen.transportFenceSha256, "recovery_mapping_changed");
  }
  async function verifyTargetBytes(input: RecoveryTargetInput, target: D1Database, plan: Awaited<ReturnType<typeof prepare>>) {
    for (const file of plan.files) {
      await providerCurrent(input, target, plan.imageSha256, file, plan.profiles);
      const storage = await openShadowProfile(env, { profileId: file.destinationProfileId, configurationRevision: file.configurationRevision }, "read", {
        signal: input.signal, beforeRequest: async () => {
          try { await providerCurrent(input, target, plan.imageSha256, file, plan.profiles); return true; } catch { return false; }
        },
      });
      ensure(storage.storage.namespaceIdentity === file.destinationNamespaceIdentity, "recovery_mapping_changed");
      await verifyStoredBytes(storage.reader, file.objectKey, file, storage.createHash);
    }
  }
  async function claim(input: RecoveryTargetInput, plan: Awaited<ReturnType<typeof prepare>>) {
    ensure(env.RECOVERY_DB && env.RECOVERY_TARGET_ID === input.expectedTargetId, "recovery_target_unavailable");
    const target = primaryD1(env.RECOVERY_DB), prior = await existingClaim(target);
    if (prior) {
      ensure(prior.target_id === input.expectedTargetId && prior.job_id === input.jobId && prior.incarnation === input.incarnation
        && prior.schema_sha256 === plan.catalog.schemaSha256 && prior.image_sha256 === plan.imageSha256, "recovery_target_already_claimed");
      ensure(await input.current(), "recovery_actor_or_lease_changed");
      ensure(prior.generation <= input.generation, "stale_recovery_target_generation");
      await target.prepare(`UPDATE system_recovery_target_claim SET owner_token=?,generation=?,runtime_incarnation=?,lease_expires_at=? WHERE singleton=1
        AND job_id=? AND incarnation=? AND generation<=? AND (generation<? OR owner_token=? OR lease_expires_at IS NULL OR julianday(lease_expires_at)<=julianday('now'))`)
        .bind(input.ownerToken, input.generation, input.runtimeIncarnation ?? input.incarnation,
          input.leaseExpiresAt ?? new Date(Date.now() + 60_000).toISOString(), input.jobId, input.incarnation, input.generation, input.generation, input.ownerToken).run();
      await current(input, target, plan.imageSha256); return { target, cursor: JSON.parse(prior.cursor_json) as TargetCursor };
    }
    const fresh = await inspectRecoveryTargetFreshness(env, input.expectedTargetId, input.records);
    ensure(await input.current(), "recovery_actor_or_lease_changed");
    if (fresh.empty) {
      const local = plan.catalog.schemaStatements.filter(object => object.type === "table" && ["system_recovery_runtime", "system_recovery_target_claim", "system_recovery_target_provenance"].includes(object.name));
      ensure(local.length === 3, "reviewed_target_claim_missing");
      await target.batch(local.map(object => target.prepare(object.sql)));
      await target.prepare("INSERT INTO system_recovery_runtime VALUES(1,0,lower(hex(randomblob(16))),lower(hex(randomblob(16))),NULL,?)")
        .bind(new Date().toISOString()).run();
    }
    const challenge = crypto.randomUUID(), cursor: TargetCursor = { phase: "schema", schemaIndex: 0, fileIndex: 0, empty: fresh.empty, dropped: false };
    await target.prepare("INSERT INTO system_recovery_target_claim(singleton,target_id,job_id,incarnation,challenge,schema_sha256,image_sha256,status,cursor_json,owner_token,generation,runtime_incarnation,lease_expires_at) VALUES(1,?,?,?,?,?,?,'claimed',?,?,?,?,?)")
      .bind(input.expectedTargetId, input.jobId, input.incarnation, challenge, plan.catalog.schemaSha256, plan.imageSha256, stableJson(cursor),
        input.ownerToken, input.generation, input.runtimeIncarnation ?? input.incarnation, input.leaseExpiresAt ?? new Date(Date.now() + 60_000).toISOString()).run();
    await current(input, target, plan.imageSha256); return { target, cursor };
  }
  async function step(input: RecoveryTargetInput): Promise<RecoveryTargetStepResult> {
    const plan = await prepare(input), { target, cursor } = await claim(input, plan);
    const metadataText = stableJson(plan.profiles), metadataHash = await sha256Hex(metadataText), metadataChunks = safeChunks(metadataText);
    ensure(encoder.encode(metadataText).length <= 1024 * 1024 && metadataChunks.length + 1 <= MAX_ATOMIC_STATEMENTS, "destination_metadata_budget");
    if (cursor.phase === "schema" && cursor.schemaIndex === 0) await target.batch([claimGuard(target, input, plan.imageSha256), ...metadataChunks.map((chunk, ordinal) => target.prepare(`INSERT INTO system_recovery_target_provenance(job_id,ordinal,image_sha256,chunk,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(job_id,ordinal) DO NOTHING`).bind(`${input.jobId}#destination-plan`, ordinal, metadataHash, chunk, new Date().toISOString()))]);
    const completedSources = () => input.manifest.files.filter(source => plan.files.filter(file => file.sourceId === source.id)
      .every(file => plan.files.indexOf(file) < cursor.fileIndex));
    const completeBytes = () => completedSources().reduce((total, file) => total + (file.byteSize ?? 0), 0);
    const result = (done = false, report?: SystemRecoveryReport): RecoveryTargetStepResult => ({ phase: cursor.phase, completedFiles: completedSources().length, bytesDone: completeBytes(), done, ...(report ? { report } : {}) });
    await current(input, target, plan.imageSha256);
    if (cursor.phase === "schema") {
      const objects = cursor.empty ? [
        ...plan.catalog.schemaStatements.filter(object => object.type === "table" && !["system_recovery_runtime", "system_recovery_target_claim", "system_recovery_target_provenance"].includes(object.name)),
        ...plan.catalog.schemaStatements.filter(object => object.type === "index"), ...plan.catalog.schemaStatements.filter(object => object.type === "view"),
      ] : plan.catalog.schemaStatements.filter(object => object.type === "trigger").map(object => ({ ...object, sql: `DROP TRIGGER ${quote(object.name)}` }));
      const group = objects.slice(cursor.schemaIndex, cursor.schemaIndex + DDL_GROUP);
      cursor.schemaIndex += group.length;
      if (cursor.schemaIndex >= objects.length) { cursor.phase = "rows"; cursor.schemaIndex = 0; cursor.dropped = true; }
      await target.batch([claimGuard(target, input, plan.imageSha256), ...group.map(object => target.prepare(object.sql)),
        target.prepare("UPDATE system_recovery_target_claim SET status='installing',cursor_json=? WHERE singleton=1").bind(stableJson(cursor))]); return result();
    }
    if (cursor.phase === "rows") {
      const probe = await target.prepare("SELECT hex(unhex('000102FF')) AS probe").first<{ probe: string }>();
      ensure(probe?.probe === "000102FF", "native_exact_blob_restore_unsupported");
      const statements = [claimGuard(target, input, plan.imageSha256), target.prepare("PRAGMA defer_foreign_keys=ON")];
      if (!cursor.empty) for (const spec of plan.catalog.tables.filter(table => !table.local && plan.catalog.seedTableRows[table.name]?.rows.length)) statements.push(target.prepare(`DELETE FROM ${quote(spec.name)}`));
      for (const group of plan.budget.groups) statements.push(groupInsert(target, group.spec, group.rows));
      if (cursor.empty) for (const spec of plan.catalog.tables.filter(table => table.local && !table.name.startsWith("system_recovery_"))) {
        for (const row of recoveryDestinationTable(input.records, spec.name).rows) statements.push(singleRowInsert(target, spec, row));
      }
      if (cursor.empty) statements.push(target.prepare("INSERT INTO system_recovery_maintenance(singleton,state,generation,updated_at) VALUES(1,'fenced',0,?)").bind(new Date().toISOString()));
      else statements.push(target.prepare("UPDATE system_recovery_maintenance SET state='fenced',updated_at=? WHERE singleton=1").bind(new Date().toISOString()));
      if (!input.records.image.tables.file_registry_rowid_claims) statements.push(target.prepare(`INSERT INTO file_registry_rowid_claims(registry_name,claimed_rowid)
        SELECT 'storage_profiles',rowid FROM storage_profiles UNION ALL SELECT 'files',rowid FROM files
        UNION ALL SELECT 'file_locations',rowid FROM file_locations UNION ALL SELECT 'legacy_file_mappings',rowid FROM legacy_file_mappings`));
      const now = new Date().toISOString();
      plan.budget.chunks.forEach((chunk, ordinal) => statements.push(target.prepare("INSERT INTO system_recovery_target_provenance(job_id,ordinal,image_sha256,chunk,created_at) VALUES(?,?,?,?,?)")
        .bind(input.jobId, ordinal, plan.imageSha256, chunk, now)));
      cursor.phase = "files";
      statements.push(target.prepare("UPDATE system_recovery_target_claim SET status='files',cursor_json=? WHERE singleton=1").bind(stableJson(cursor)));
      ensure(statements.length <= MAX_ATOMIC_STATEMENTS, "atomic_restore_budget"); await target.batch(statements);
      await assertRecoveredCapabilitiesInert(target, plan.catalog); return result();
    }
    if (cursor.phase === "files") {
      if (cursor.fileIndex === 0) {
        const statements = recoveryDestinationProfileStatements(target, plan.profiles);
        await boundedWrites(target, input, plan.imageSha256, statements);
      }
      const file = plan.files[cursor.fileIndex];
      if (!file) { cursor.phase = "reinstall"; cursor.schemaIndex = 0; await persist(target, input, plan.imageSha256, cursor, "verifying"); return result(); }
      await restoreFile(target, input, plan.imageSha256, file, plan.profiles);
      cursor.fileIndex++; await persist(target, input, plan.imageSha256, cursor, "files"); return result();
    }
    if (cursor.phase === "reinstall") {
      if (cursor.schemaIndex === 0) await finalizeMappings(target, input, plan.files, plan.imageSha256);
      const triggers = plan.catalog.schemaStatements.filter(object => object.type === "trigger"), group = triggers.slice(cursor.schemaIndex, cursor.schemaIndex + DDL_GROUP);
      cursor.schemaIndex += group.length;
      if (cursor.schemaIndex >= triggers.length) { cursor.phase = "verify"; cursor.schemaIndex = 0; }
      await target.batch([claimGuard(target, input, plan.imageSha256), ...group.map(object => target.prepare(object.sql)),
        target.prepare("UPDATE system_recovery_target_claim SET status='verifying',cursor_json=? WHERE singleton=1").bind(stableJson(cursor))]); return result();
    }
    await verifyTargetBytes(input, target, plan);
    const verified = await verifyRecoveryTarget(target, input.records, plan.files, plan.profiles, input.jobId, plan.imageSha256);
    await current(input, target, plan.imageSha256);
    const ledger = await recoveryMigrationLedgerStatements(target, plan.catalog.migrations);
    if (ledger.length) await target.batch([claimGuard(target,input,plan.imageSha256),...ledger]);
    await inspectRecoveryMigrationLedger(target,true,plan.catalog.migrations);
    const report = await reportFor(input, verified);
    cursor.phase = "ready";
    await target.batch([claimGuard(target, input, plan.imageSha256), target.prepare("UPDATE system_recovery_target_claim SET status='ready',cursor_json=?,verified_at=? WHERE singleton=1")
      .bind(stableJson(cursor), new Date().toISOString())]); return result(true, report);
  }
  async function reportFor(input: RecoveryTargetInput, proof: RecoveryVerification) {
    return createSystemRecoveryReport({ targetId: input.expectedTargetId, jobId: input.jobId, incarnation: input.incarnation,
      manifest: input.manifest, records: input.records, mode: input.mode, differences: proof.differences, targetProof: proof.checkpoint });
  }
  async function verify(input: RecoveryTargetInput) {
    const plan = await prepare(input), { target, cursor } = await claim(input, plan);
    ensure(cursor.phase === "ready", "target_not_ready");
    await inspectRecoveryMigrationLedger(target,true,plan.catalog.migrations);
    await verifyTargetBytes(input, target, plan);
    const proof = await verifyRecoveryTarget(target, input.records, plan.files, plan.profiles, input.jobId, plan.imageSha256);
    await current(input, target, plan.imageSha256); return reportFor(input, proof);
  }
  async function restoreFile(target: D1Database, input: RecoveryTargetInput, imageSha256: string, file: RecoveryPlannedFile, profiles: readonly RecoveryDestinationProfile[]) {
    const source = input.manifest.files.find(value => value.id === file.sourceId); ensure(source, "recovery_payload_missing");
    await current(input, target, imageSha256);
    await target.batch([claimGuard(target, input, imageSha256), target.prepare(`INSERT INTO system_recovery_target_files(job_id,logical_id,source_blob_id,file_id,location_id,profile_id,namespace,object_key,purpose,byte_size,sha256,incarnation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,logical_id) DO NOTHING`)
      .bind(input.jobId, file.id, file.sourceId, file.fileId, file.locationId, file.destinationProfileId, file.destinationNamespaceIdentity,
        file.objectKey, file.purpose, file.byteSize, file.sha256, input.incarnation)]);
    const row = await target.prepare("SELECT * FROM system_recovery_target_files WHERE job_id=? AND logical_id=?").bind(input.jobId, file.id)
      .first<{ state: string; object_key: string; owner_token: string | null; generation: number | null; verified_at: string | null }>();
    ensure(row?.object_key === file.objectKey, "recovery_file_identity_conflict");
    if (row.state === "published") return;
    if (["write_started", "unknown"].includes(row.state)) {
      // A lost acknowledgement can be resolved by verified reads. The original
      // key is never replayed, even when the uncertain object is absent.
      await current(input, target, imageSha256);
      const storage = await openShadowProfile(env, { profileId: file.destinationProfileId, configurationRevision: file.configurationRevision }, "read", {
        signal: input.signal, beforeRequest: async () => {
          try { await providerCurrent(input, target, imageSha256, file, profiles); return true; } catch { return false; }
        },
      });
      ensure(storage.storage.namespaceIdentity === file.destinationNamespaceIdentity, "recovery_mapping_changed");
      await verifyStoredBytes(storage.reader, file.objectKey, file, storage.createHash);
      await current(input, target, imageSha256);
      await target.batch([claimGuard(target, input, imageSha256), target.prepare("UPDATE system_recovery_target_files SET state='verified',verified_at=? WHERE job_id=? AND logical_id=? AND state IN('write_started','unknown')")
        .bind(new Date().toISOString(), input.jobId, file.id)]);
      row.state = "verified";
    }
    ensure(row.state === "pending" || row.state === "verified", "recovery_write_outcome_unknown");
    if (row.state !== "verified") {
      const signal = input.signal ?? new AbortController().signal;
      const body = await input.openPayload(source, signal);
      try {
        await writeRecoveryFile(env, file, body, { signal, current: async () => {
          try { await providerCurrent(input, target, imageSha256, file, profiles); return true; } catch { return false; }
        }, writeStarted: async () => {
          await current(input, target, imageSha256);
          await target.batch([claimGuard(target, input, imageSha256), target.prepare("UPDATE system_recovery_target_files SET state='write_started',owner_token=?,generation=? WHERE job_id=? AND logical_id=? AND state='pending'")
            .bind(input.ownerToken, input.generation, input.jobId, file.id), target.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_target_files WHERE job_id=? AND logical_id=? AND state='write_started' AND owner_token=? AND generation=?) THEN 1 ELSE json('Recovery file ownership changed') END")
            .bind(input.jobId, file.id, input.ownerToken, input.generation)]);
          return true;
        } });
      } catch (error) {
        await target.prepare("UPDATE system_recovery_target_files SET state='unknown' WHERE job_id=? AND logical_id=? AND state='write_started' AND owner_token=? AND generation=?")
          .bind(input.jobId, file.id, input.ownerToken, input.generation).run(); throw error;
      }
      await current(input, target, imageSha256);
      await target.batch([claimGuard(target, input, imageSha256), target.prepare("UPDATE system_recovery_target_files SET state='verified',verified_at=? WHERE job_id=? AND logical_id=? AND state='write_started' AND owner_token=? AND generation=?")
        .bind(new Date().toISOString(), input.jobId, file.id, input.ownerToken, input.generation)]);
    }
    await current(input, target, imageSha256);
    const receipt = await target.prepare("SELECT verified_at FROM system_recovery_target_files WHERE job_id=? AND logical_id=? AND state='verified'")
      .bind(input.jobId, file.id).first<{ verified_at: string }>();
    ensure(receipt?.verified_at && Number.isFinite(Date.parse(receipt.verified_at)), "recovery_readback_receipt_missing");
    await boundedWrites(target, input, imageSha256, recoveryFilePublicationStatements(target, file, { byteSize: file.byteSize, sha256: file.sha256 }, receipt.verified_at));
    await target.batch([claimGuard(target, input, imageSha256),
      target.prepare("UPDATE system_recovery_target_files SET state='published' WHERE job_id=? AND logical_id=? AND state='verified'").bind(input.jobId, file.id)]);
  }
  async function finalizeMappings(target: D1Database, input: RecoveryTargetInput, files: RecoveryPlannedFile[], imageSha256: string) {
    await current(input, target, imageSha256);
    const now = new Date().toISOString();
    await target.batch([claimGuard(target, input, imageSha256), target.prepare("PRAGMA defer_foreign_keys=ON"),
      ...(files.length ? [target.prepare("UPDATE file_authority_control SET mode='active',activated_at=COALESCE(activated_at,?),updated_at=? WHERE singleton=1 AND mode<>'active'").bind(now, now)] : []),
      ...(files.length ? [target.prepare(`INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at)
        SELECT 1,c.epoch,?,a.activated_at FROM file_shadow_control c JOIN file_authority_control a ON a.singleton=c.singleton
        WHERE c.singleton=1 AND a.mode='active' AND NOT EXISTS(SELECT 1 FROM file_shadow_enablements)`)
        .bind(`fp5-recovery:${input.incarnation}`)] : []),
      target.prepare("DELETE FROM file_registry_rowid_claims"), target.prepare(`INSERT INTO file_registry_rowid_claims(registry_name,claimed_rowid)
        SELECT 'storage_profiles',rowid FROM storage_profiles UNION ALL SELECT 'files',rowid FROM files
        UNION ALL SELECT 'file_locations',rowid FROM file_locations UNION ALL SELECT 'legacy_file_mappings',rowid FROM legacy_file_mappings`),
      // Materialize the reviewed projection once. D1 otherwise duplicates its
      // thirteen dependency-rich branches in both correlated subqueries.
      target.prepare(`WITH sources AS MATERIALIZED(SELECT consumer_kind,consumer_id,consumer_sub_id,file_slot,source_json FROM file_shadow_sources)
        UPDATE file_shadow_occurrences SET source_json=(SELECT s.source_json FROM sources s WHERE s.consumer_kind=file_shadow_occurrences.consumer_kind AND s.consumer_id=file_shadow_occurrences.consumer_id AND s.consumer_sub_id=file_shadow_occurrences.consumer_sub_id AND s.file_slot=file_shadow_occurrences.file_slot)
        WHERE id IN(SELECT occurrence_id FROM file_shadow_heads WHERE present=1) AND EXISTS(SELECT 1 FROM sources s WHERE s.consumer_kind=file_shadow_occurrences.consumer_kind AND s.consumer_id=file_shadow_occurrences.consumer_id AND s.consumer_sub_id=file_shadow_occurrences.consumer_sub_id AND s.file_slot=file_shadow_occurrences.file_slot)`),
      target.prepare("UPDATE file_shadow_heads SET source_json=(SELECT o.source_json FROM file_shadow_occurrences o WHERE o.id=file_shadow_heads.occurrence_id) WHERE present=1"),
    ]);
    ensure(files.every(file => file.objectKey.startsWith(`fp5-recovery/${input.incarnation}/`)), "recovery_namespace_isolation");
  }
  return { preview, step, verify };
}

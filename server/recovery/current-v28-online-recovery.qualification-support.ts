import { expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { validateFileUploadResult } from '../../shared/contracts/r2-upload.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { recoveryTableSnapshotSql, type SystemRecoveryTable } from '../../shared/contracts/system-recovery-image.ts';
import { PORTABLE_RUNTIME_RECOVERY_TABLES } from '../../shared/contracts/portable-runtime-v28-recovery-catalog.ts';
import { PORTABLE_RUNTIME_SEED_TABLE_ROWS } from '../../worker/recovery/portable-runtime-v28-trusted-schema.ts';
import { createNodeDevelopmentPrototype } from '../node-application.ts';
import { createPasswordHasher } from '../auth/passwords.ts';
import { loadNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration,
  type NodeConfiguredRecoveryArtifacts } from '../node-runtime-config.ts';
import { V26_NODE_INSTALLATION_CATALOG } from '../installation-catalog-v26.ts';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations.ts';
import { executeCollaborationV28OperatorCandidate } from '../operations/collaboration-v28-operator-candidate.ts';
import { prepareGenuineLocalFileV26Baseline, type GenuineLocalFileV26Baseline } from
  '../collaboration/current-final-fabublox-genuine-process.qualification-support.ts';
import { CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased, canonicalFileClient,
  canonicalFilePrivateOrigin, consumeCanonicalFileClient, listenCanonicalFileApplication,
  withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';

export const CURRENT_V28_RECOVERY_FILE_TABLES = Object.freeze([
  'assets', 'files', 'file_locations', 'file_location_publications', 'file_publications',
  'file_acceptance_candidates', 'r2_upload_requests',
] as const);
export const CURRENT_V28_RECOVERY_TEMPLATE_TABLES = Object.freeze([
  'recipe_families', 'template_versions', 'template_steps', 'step_definitions',
] as const);
export const CURRENT_V28_RECOVERY_PHYSICAL_TABLES = Object.freeze([
  'storage_profiles', 'storage_profile_runtime', 'local_storage_profile_registrations', 'local_storage_profile_checks',
  'local_storage_profile_admissions', 'local_storage_profile_bindings',
  'local_storage_profile_activations', 'system_storage_native_bindings',
] as const);
export interface CurrentV28RecoveryTypedRow { readonly rowid: string | null; readonly cells: string }
export type CurrentV28RecoveryTypedSource = Readonly<Record<string, readonly CurrentV28RecoveryTypedRow[]>>;
export interface CurrentV28OnlineRecoverySource {
  readonly baseline: GenuineLocalFileV26Baseline;
  readonly sourceFileId: string;
  readonly sourceAssetId: string;
  readonly payloadBytes: number;
  readonly payloadSha256: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly expectedTypedSource: CurrentV28RecoveryTypedSource;
  readonly expectedTypedPhysicalBindings: CurrentV28RecoveryTypedSource;
  readonly recoveryArtifacts: Readonly<NodeConfiguredRecoveryArtifacts>;
  writeRecoveryConfiguration(origin: string, enabled?: boolean): Promise<string>;
  loadRecoveryConfiguration(origin: string): Promise<LoadedNodeRuntimeConfiguration>;
}
function ensure(value: unknown): asserts value {
  if (!value) throw new Error('Genuine current V28 Recovery source qualification is unavailable');
}
function ordered(rows: CurrentV28RecoveryTypedRow[]): readonly CurrentV28RecoveryTypedRow[] {
  return Object.freeze(rows.sort((a, b) => stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0)
    .map(row => Object.freeze(row)));
}
export function currentV28RecoveryImageRows(table: SystemRecoveryTable): readonly CurrentV28RecoveryTypedRow[] {
  return ordered(table.rows.map(row => ({ rowid: row.rowid, cells: stableJson(row.cells) })));
}
export function currentV28RecoveryTypedRows(native: DatabaseSync,
  names: readonly string[] = [...CURRENT_V28_RECOVERY_FILE_TABLES, ...CURRENT_V28_RECOVERY_TEMPLATE_TABLES]): CurrentV28RecoveryTypedSource {
  return Object.freeze(Object.fromEntries(names.map(name => {
    const specification = PORTABLE_RUNTIME_RECOVERY_TABLES.find(table => table.name === name);
    ensure(specification);
    const rows = native.prepare(recoveryTableSnapshotSql(specification)).all().map(row => {
      ensure((row.rowid === null || typeof row.rowid === 'string') && typeof row.cells === 'string');
      const cells: unknown = JSON.parse(row.cells);
      return { rowid: row.rowid, cells: stableJson(cells) };
    });
    return [name, ordered(rows)];
  })));
}
function assertNoUnsettledSourceWriters(native: DatabaseSync): void {
  expect(native.prepare('SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL').get()?.n).toBe(0);
  const settled = native.prepare(`SELECT 1 settled WHERE
    NOT EXISTS(SELECT 1 FROM file_shadow_attempts WHERE state IN('write_started','unknown'))
    AND NOT EXISTS(SELECT 1 FROM file_migration_attempts WHERE state IN('write_started','unknown'))
    AND NOT EXISTS(SELECT 1 FROM research_package_attempts WHERE state IN('write_started','unknown'))
    AND NOT EXISTS(SELECT 1 FROM r2_upload_requests WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM import_file_acceptances WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM system_storage_candidate_checks
      WHERE status='running' OR cleanup_outcome='running' OR write_outcome='unknown')
    AND NOT EXISTS(SELECT 1 FROM system_recovery_attempts WHERE state IN('started','unknown'))`).get();
  expect(settled?.settled).toBe(1);
}

/** Read-only precondition check. This helper never creates a fence or substitutes
 * stopped fixture SQL for the production source-open/drain/fence owner. The
 * caller must first obtain the persisted window from the genuine operator. */
export function assertCurrentV28OnlineRecoverySourceFenced(native: DatabaseSync): Readonly<{ generation: number; token: string }> {
  assertNoUnsettledSourceWriters(native);
  for (const table of ['file_authority_runtime_guard', 'file_shadow_runtime_guard', 'file_job_runtime_guard'])
    expect(native.prepare(`SELECT enabled FROM ${table} WHERE singleton=1`).get()?.enabled).toBe(0);
  const window = native.prepare('SELECT state,generation,token FROM system_recovery_maintenance WHERE singleton=1').get();
  ensure(window?.state === 'fenced' && typeof window.generation === 'number' && Number.isSafeInteger(window.generation)
    && window.generation >= 1 && typeof window.token === 'string' && window.token.length > 0);
  return Object.freeze({ generation: window.generation, token: window.token });
}

/** Call inside the one retainedCanonicalFileCase. Fresh reviewed installation,
 * genuine offline account/admin/profile operations and real ordinary HTTP are
 * the only positive source setup. No account/auth/File/business rows, executor
 * flags, maintenance state or fence token are written as fixture trust proof. */
export async function prepareCurrentV28OnlineRecoverySource(): Promise<CurrentV28OnlineRecoverySource> {
  const baseline = await prepareGenuineLocalFileV26Baseline();
  const bytes = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=', 'base64'));
  const payloadSha256 = createHash('sha256').update(bytes).digest('hex'), uploadRequestId = randomUUID();
  const accepted = await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
    const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
    expect(assertInstallationAdmission(native, admission).installationId).toBe(baseline.installationId);
    const origin = await canonicalFilePrivateOrigin(owner), configurationPath = join(baseline.root, 'online-recovery-upload-source.json');
    await writeFile(configurationPath, JSON.stringify({ format: 'node-loopback-development-v1',
      dataDirectory: baseline.dataDirectory, expectedInstallationId: baseline.installationId, publicOrigin: origin,
      clientDirectory: baseline.clientDirectory, localVolumes: baseline.descriptors,
      enableLocalFile: true, enableLocalJobs: false }), { flag: 'wx', mode: 0o600 });
    const configuration = loadNodeRuntimeConfiguration(configurationPath, { filesystemRootOwnerUid: baseline.rootOwnerUid });
    owner.applicationAttempted = true;
    owner.originalApplication = Promise.resolve().then(() => createNodeDevelopmentPrototype({
      database: core, nativeDatabase: native, writerLease: lease, admission, hasher: createPasswordHasher(),
      identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, now: Date.now, publicOrigin: origin,
      clientDirectory: baseline.clientDirectory, localFileConfiguration: configuration,
      httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 },
    }));
    owner.application = await owner.originalApplication;
    await listenCanonicalFileApplication(owner, origin);
    const client = canonicalFileClient(owner, origin), session = await client.login('operator');
    const headers = { 'content-type': 'image/png', 'x-filename': 'genuine-online-recovery-original.png',
      'x-upload-request-id': uploadRequestId };
    const original = await client.raw('/api/assets', 'POST', session, bytes, headers);
    expect(original.response.status).toBe(201);
    const result = validateFileUploadResult(await consumeCanonicalFileClient(original.client, 'json'));
    ensure(result.key === null);
    expect(result.storageKind).toBe('native'); expect(result.key).toBeNull(); expect(result.deduplicated).toBe(false);
    const replay = await client.raw('/api/assets', 'POST', session, bytes, headers);
    expect(replay.response.status).toBe(200);
    expect(validateFileUploadResult(await consumeCanonicalFileClient(replay.client, 'json'))).toEqual(result);
    const delivered = await client.raw(result.url, 'GET', session);
    expect(delivered.response.status).toBe(200);
    const body = await consumeCanonicalFileClient(delivered.client, 'arrayBuffer'); ensure(body instanceof ArrayBuffer);
    expect(new Uint8Array(body)).toEqual(bytes);
    expect(createHash('sha256').update(new Uint8Array(body)).digest('hex')).toBe(payloadSha256);
    return result;
  }); // Every original client EOF, whole-app/native close and Linux lease ACK precedes upgrade.
  assertCanonicalFileOwnersReleased();
  const beforeUpgrade = await withCanonicalFileDatabase(baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
    assertNoUnsettledSourceWriters(native);
    expect(native.prepare('SELECT count(*) n FROM file_locations').get()?.n).toBe(1);
    expect(native.prepare('SELECT actor_email,ingress,purpose,request_scope,status FROM r2_upload_requests WHERE client_request_id=?')
      .get(uploadRequestId)).toEqual({ actor_email: baseline.operatorActor, ingress: 'ordinary_image',
      purpose: 'embedded_content', request_scope: 'system', status: 'ready' });
    const rows = currentV28RecoveryTypedRows(native), physical = currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES);
    for (const table of CURRENT_V28_RECOVERY_TEMPLATE_TABLES)
      expect(rows[table]).toEqual(currentV28RecoveryImageRows(PORTABLE_RUNTIME_SEED_TABLE_ROWS[table]!));
    for (const table of ['samples', 'runs']) expect(native.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
    return { rows, physical };
  }));
  const upgrade = await executeCollaborationV28OperatorCandidate({ kind: 'upgrade-metadata', databasePath: baseline.path,
    filesystemRootOwnerUid: baseline.rootOwnerUid });
  expect(upgrade.installationId).toBe(baseline.installationId); expect(upgrade.checkpointId).toBe('portable-runtime/v28');
  const source = await withCanonicalFileDatabase(baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
    expect(assertInstallationAdmission(native, admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE))
      .installationId).toBe(baseline.installationId);
    assertNoUnsettledSourceWriters(native);
    expect(currentV28RecoveryTypedRows(native)).toEqual(beforeUpgrade.rows);
    expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(beforeUpgrade.physical);
    expect(native.prepare(`SELECT a.principal_id,a.enabled FROM local_accounts a JOIN local_admin_grants g
      ON g.principal_id=a.principal_id WHERE a.principal_id=?`).get(baseline.principalId))
      .toEqual({ principal_id: baseline.principalId, enabled: 1 });
    for (const table of ['samples', 'runs', 'collaboration_members', 'collaboration_identities', 'collaboration_grants'])
      expect(native.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
    expect(native.prepare('SELECT count(*) n FROM local_storage_profile_bindings').get()?.n).toBe(2);
    for (const [index, profileId] of [baseline.internalProfileId, baseline.originalsProfileId].entries())
      expect(native.prepare(`SELECT installation_id,root_binding_id,state,access FROM local_storage_profile_bindings
        WHERE storage_profile_id=?`).get(profileId)).toEqual({ installation_id: baseline.installationId,
        root_binding_id: baseline.descriptors[index]!.rootBindingId, state: 'available', access: 'read_write' });
    return { rows: currentV28RecoveryTypedRows(native), physical: currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES) };
  }));
  assertCanonicalFileOwnersReleased();
  const recoveryArtifacts = Object.freeze({ root: join(baseline.root, 'private-system-recovery-artifacts'), rootBindingId: randomUUID() });
  await mkdir(recoveryArtifacts.root, { mode: 0o700 });
  for (const directory of ['objects', 'staging']) await mkdir(join(recoveryArtifacts.root, directory), { mode: 0o700 });
  await writeFile(join(recoveryArtifacts.root, 'namespace.json'), JSON.stringify({ format: 'local-byte-namespace-v1', namespace: {
    volumeId: baseline.installationId, rootId: recoveryArtifacts.rootBindingId,
    profileId: 'system-recovery-private', namespaceRevision: 1,
  } }), { flag: 'wx', mode: 0o600 });
  async function writeRecoveryConfiguration(origin: string, enabled = true): Promise<string> {
    // Provision configuration only. Neither selection nor this file writes a
    // fence, grants, persisted executor flags or historical job state.
    const configurationPath = join(baseline.root, `online-recovery-runtime-${randomUUID()}.json`);
    await writeFile(configurationPath, JSON.stringify({ format: 'node-loopback-development-v1',
      dataDirectory: baseline.dataDirectory, expectedInstallationId: baseline.installationId, publicOrigin: origin,
      clientDirectory: baseline.clientDirectory, localVolumes: baseline.descriptors,
      enableLocalFile: false, enableLocalJobs: false,
      ...(enabled ? { enableLocalRecovery: true, recoveryArtifacts } : {}),
    }), { flag: 'wx', mode: 0o600 });
    return configurationPath;
  }
  return Object.freeze({ baseline, sourceFileId: accepted.fileId, sourceAssetId: accepted.id,
    payloadBytes: bytes.byteLength, payloadSha256, bytes, expectedTypedSource: source.rows,
    expectedTypedPhysicalBindings: source.physical, recoveryArtifacts, writeRecoveryConfiguration,
    async loadRecoveryConfiguration(origin: string): Promise<LoadedNodeRuntimeConfiguration> {
      return loadNodeRuntimeConfiguration(await writeRecoveryConfiguration(origin), {
        filesystemRootOwnerUid: baseline.rootOwnerUid, runtimeProfile: 'v28-recovery' });
    },
  });
}

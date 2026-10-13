import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { PORTABLE_RUNTIME_RECOVERY_TABLES } from '../../shared/contracts/portable-runtime-v28-recovery-catalog.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { checkedSystemRecoveryReceipt, checkedSystemRecoveryJobStatus, checkedSystemRecoveryPreview,
  checkedSystemRecoveryMaintenanceStatus, checkedSystemRecoveryMaintenanceReceipt } from '../../shared/contracts/system-recovery.ts';
import { loadNodeRuntimeConfiguration, assertNodeRuntimeConfiguration } from '../node-runtime-config.ts';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource } from '../migrations.ts';
import { CANONICAL_FILE_PASSWORD, assertCanonicalFileOwnersReleased, canonicalFilePrivateOrigin,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { prepareCurrentV28OnlineRecoverySource, currentV28RecoveryImageRows, currentV28RecoveryTypedRows,
  CURRENT_V28_RECOVERY_PHYSICAL_TABLES } from './current-v28-online-recovery.qualification-support.ts';
import { loginCurrentRecoveryCli, recoveryCliJson, recoveryCliBytes } from './current-v28-recovery-cli.qualification-support.ts';
import { prepareCurrentRecoveryTarget } from './current-v28-recovery-target.qualification-support.ts';
import { disabledProtectedAccountTable } from './restore-v28-candidate.ts';

// These immutable inputs retain their ACTUAL original producer qualification.
// They are never relabelled as a current consumer binary/archive generation.
const PRODUCER_HEAD = '62ac1d54dcfd2bff6381f2bbfbe4276df1bf3ddc';
const PRODUCER_TREE = '856ee17cd6434efb07403833c0266b1dacc218c4';
const ARCHIVE_SHA256 = '82fc04947297df401ac3a80b6ad171659850871ce7b9d5c114a79b505af8aa24';
const PINS = {
  producer: { sha256: 'c1a977d75e4019b32872f0d9b1078d5bfe54add084044f6a96718164678a6f38', bytes: 5722 },
  node: { sha256: '9084bb4e0bb08c3f126af7881e6ba6fcc7d70aee9de2a48722ec2692244422cb', bytes: 650 },
  d1: { sha256: '0155fd6ab7ee6fc9b32a4cc8a90ff910964ba549157b04ecf0f9e717d39017e1', bytes: 4134 },
  capture: { sha256: '75a75b8fda0bbad93711229cdeaa2220c0dbe6d34217e12bf23f191451326c2e', bytes: 6190 },
} as const;
const RESERVE = 603_979_776n, SOURCE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
let distribution: string, output: string, consumerHead: string, manifestSha256: string;
function ensure(value: unknown, reason = 'original_r2_v5_online_target_unavailable'): asserts value {
  if (!value) throw new Error(reason);
}
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function pinned(path: string, sha256: string, size: number) {
  ensure(isAbsolute(path) && resolve(path) === path && await realpath(path) === path);
  const before = await lstat(path, { bigint: true });
  ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size === BigInt(size)
    && (before.mode & 0o7777n) === 0o600n && typeof process.geteuid === 'function' && before.uid === BigInt(process.geteuid()));
  const raw = await readFile(path), after = await lstat(path, { bigint: true });
  expect([after.dev,after.ino,after.uid,after.mode,after.nlink,after.size,after.mtimeNs,after.ctimeNs])
    .toEqual([before.dev,before.ino,before.uid,before.mode,before.nlink,before.size,before.mtimeNs,before.ctimeNs]);
  expect(raw.byteLength).toBe(size); expect(digest(raw)).toBe(sha256); return { path, sha256, size, raw };
}
async function originalInput() {
  const archive = process.env.CURRENT_R2_V5_ONLINE_ARCHIVE ?? '', producerPath = process.env.CURRENT_R2_V5_ONLINE_PRODUCER_RECEIPT ?? '';
  const archiveInput = await pinned(archive, ARCHIVE_SHA256, 1863610), parent = dirname(archive);
  const producerInput = await pinned(producerPath, PINS.producer.sha256, PINS.producer.bytes);
  const nodeInput = await pinned(join(parent, 'original-node-restore-receipt.json'), PINS.node.sha256, PINS.node.bytes);
  const d1Input = await pinned(join(parent, 'closed-native-file-consistency.json'), PINS.d1.sha256, PINS.d1.bytes);
  const captureInput = await pinned(join(parent, 'original-native-response.json'), PINS.capture.sha256, PINS.capture.bytes);
  const producer = object(JSON.parse(producerInput.raw.toString('utf8'))), results = object(producer.actualResults);
  expect(producer).toMatchObject({ kind: 'current-v28-post-restore-original-owned-stage/1', stage: 'worker-v5-held',
    head: PRODUCER_HEAD, tree: PRODUCER_TREE, status: 'PASS', exitCode: 0, originalChildWaited: true, ownedClosureProven: true, noFixtureRemoval: true });
  expect(producer.outerExpired).not.toBe(true); expect(producer.firstFailure).toBeUndefined();
  ensure(Array.isArray(producer.finalGroupSnapshot)); expect(producer.finalGroupSnapshot.every(row => object(row).activeOrOwnershipUnproven === false)).toBe(true);
  expect(results).toMatchObject({ actualTotal: 1, actualPassed: 1, actualFailed: 0, actualPending: 0,
    reporterSuccess: true, exactOriginalSelection: true, pass: true });
  expect(results.titles).toEqual(['captures the original held native R2 V28 V5 archive and restores exact recovery evidence into a fresh coherent Node distribution']);
  const node = object(JSON.parse(nodeInput.raw.toString('utf8'))), d1 = object(JSON.parse(d1Input.raw.toString('utf8')));
  expect(object(producer.actualHeldNodeRestore)).toMatchObject({ originalProofSha256: PINS.node.sha256, originalProofBytes: PINS.node.bytes,
    archiveFormat: 'v5', actualBytes: 68, exactTypedRows: true, restoredOriginalLocalEvidence: true, canonicalFileIdsPreserved: true, automaticActivation: false });
  ensure(Array.isArray(producer.actualClosedNativeProofs)); expect(producer.actualClosedNativeProofs).toHaveLength(1);
  expect(object(producer.actualClosedNativeProofs[0])).toMatchObject({ originalProofSha256: PINS.d1.sha256, originalProofBytes: PINS.d1.bytes });
  expect(d1).toMatchObject({ schema: 'closed-original-native-d1-readonly-consistency/1', originalNativeDisposed: true,
    wholeQuickCheck: true, foreignKeys: true, durableMainAndWalUnchanged: true, physicalPathsAndInodesUnchanged: true });
  expect(node).toMatchObject({ kind: 'offline-v28-inert-restore/1', archiveFormat: 'v5', sourceArchiveSha256: ARCHIVE_SHA256,
    destinationCheckpoint: 'portable-runtime/v28', sourceLedger: 'cloudflare-observed-migrations/1', executionEnabled: false,
    exactTypedRows: true, restoredOriginalLocalEvidence: true, canonicalFileIdsPreserved: true, actualBytes: 68 });
  const captureReply = object(JSON.parse(captureInput.raw.toString('utf8'))), capture = object(captureReply.capture);
  expect(capture).toMatchObject({ format: 'v5', sha256: ARCHIVE_SHA256, byteSize: 1863610, sourceCheckpoint: 'portable-runtime/v28',
    sourceLedger: 'observed-reviewed-construction', migrationExecutionClaimed: false, ledger: 'cloudflare-observed-migrations/1', ledgerEntries: 26,
    files: 1, bytes: 68, relocations: 1, activeHolds: 2, heldReadCount: 3, executionEnabled: false, recoveryReady: false,
    origin: { format: 'native', schemaVersion: 28, capturePolicy: 'atomic-primary-with-byte-holds/1' } });
  expect(capture.sourceInstallationId).toBe(captureReply.targetInstallationId);
  ensure(Array.isArray(d1.installations)); expect(d1.installations).toContain(capture.sourceInstallationId);
  const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive), {
    ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: ARCHIVE_SHA256 });
  expect(admitted.format).toBe('v5'); expect(admitted.manifest.completeness).toBe('complete'); expect(admitted.manifest.files).toHaveLength(1);
  expect(admitted.records.origin.capturePolicy).toBe('atomic-primary-with-byte-holds/1');
  expect(admitted.records.content.backupHoldOwner).toBe(admitted.records.backupId); expect(admitted.records.backupId).toBe(capture.backupId);
  expect(admitted.records.sourceMigrationLedger.kind).toBe('cloudflare-observed-migrations/1');
  const member = admitted.manifest.files[0]!;
  expect(member).toMatchObject({ outcome: 'packaged', byteSize: 68, sha256: node.sha256, source: { provider: 'r2', byteAuthority: 'file_location' } });
  expect(admitted.records.content.tables.recovery_file_evidence).toHaveLength(1);
  const originalLocal = object(JSON.parse(String(admitted.records.content.tables.recovery_file_evidence[0]!.source_locator_json)));
  expect(originalLocal).toMatchObject({ provider: 'local', storeKind: 'file' });
  for (const name of ['local_storage_profile_registrations', 'local_storage_profile_activations'])
    expect(admitted.records.image.tables[name]!.rows.length).toBeGreaterThan(0);
  const values = [archiveInput,producerInput,nodeInput,d1Input,captureInput];
  return { archive, archiveInput, values, admitted, member, producer, capture, node };
}

beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? ''; output = process.env.CURRENT_R2_V5_ONLINE_NODE_RECEIPT ?? '';
  // Root's original current-consumer wrapper supplies its ACTUAL candidate
  // compiler head. This does not change the separately pinned62ac producer.
  consumerHead = process.env.CURRENT_R2_V5_ONLINE_CONSUMER_HEAD ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && /^[a-f0-9]{40}$/.test(consumerHead)
    && isAbsolute(parent) && resolve(parent) === parent);
  for (const path of [parent,tmpdir()]) { const free = statfsSync(path, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE); }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true }); manifestSha256 = manifest.manifestSha256;
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
  const inputs = object(JSON.parse(await readFile(join(distribution, 'source-inputs.json'), 'utf8'))).inputs; ensure(Array.isArray(inputs));
  for (const relative of ['server/main.ts','server/recovery/node-system-recovery-v28-application.ts','server/recovery/node-v28-archive-stages.ts',
    'server/recovery/node-v28-target-stages.ts','server/recovery/node-v28-recovery-target.ts','server/recovery/local-volume-byte-destination-v28.ts',
    'shared/contracts/system-backup-v5.ts','shared/contracts/system-backup-v5-archive-admission.ts']) {
    const raw = await readFile(join(SOURCE_ROOT,relative)), selected = inputs.map(object).find(value => value.path === relative); ensure(selected);
    expect(selected.bytes).toBe(raw.byteLength); expect(selected.sha256).toBe(digest(raw));
  }
}, 20_000);

describe('retained original genuine held R2 V5 through current online Node fresh target', () => {
  it('refuses planned recovery for a different source window and prepares an explicit historical inert Node image from the original native R2 held archive without cutover or activation',
    () => retainedCanonicalFileCase(async () => {
      const input = await originalInput(), source = await prepareCurrentV28OnlineRecoverySource(), target = await prepareCurrentRecoveryTarget(source);
      const origin = await withCanonicalFileDatabase(source.baseline.path, owner => canonicalFilePrivateOrigin(owner));
      assertCanonicalFileOwnersReleased();
      const uploadId = await target.withCli(distribution,origin,async owner => {
        const session = await loginCurrentRecoveryCli(owner,origin,'operator',CANONICAL_FILE_PASSWORD);
        expect((await recoveryCliJson(owner,origin,'/api/system-recovery/executor','POST',{enabled:true},session)).status).toBe(200);
        const initial = checkedSystemRecoveryMaintenanceStatus((await recoveryCliJson(owner,origin,'/api/system-recovery/maintenance','GET',undefined,session)).value);
        expect(initial.state).toBe('open');
        const enter = await recoveryCliJson(owner,origin,'/api/system-recovery/maintenance','POST',{
          requestId:randomUUID(),action:'enter',expectedGeneration:initial.generation},session);
        expect(enter.status).toBe(200); const entered = checkedSystemRecoveryMaintenanceReceipt(enter.value);
        const finalize = await recoveryCliJson(owner,origin,'/api/system-recovery/maintenance','POST',{
          requestId:randomUUID(),action:'finalize',expectedGeneration:entered.status.generation},session);
        expect(finalize.status).toBe(200); expect(checkedSystemRecoveryMaintenanceReceipt(finalize.value).status).toMatchObject({state:'fenced',backupJobId:null,checkpoint:null});
        const accepted = await recoveryCliJson(owner,origin,'/api/system-recovery/uploads','POST',{
          requestId:randomUUID(),byteSize:input.archiveInput.size,sha256:ARCHIVE_SHA256},session);
        expect(accepted.status).toBe(202); const id = checkedSystemRecoveryReceipt(accepted.value).job.id;
        const put = await recoveryCliBytes(owner,origin,`/api/system-recovery/jobs/${id}/upload`,'PUT',new Uint8Array(input.archiveInput.raw),session);
        expect(put.status).toBe(200); expect(checkedSystemRecoveryJobStatus(JSON.parse(Buffer.from(put.bytes).toString('utf8')))).toMatchObject({kind:'upload',state:'queued',phase:'validate'});
        return id;
      });
      await target.withDispatcher(async app => { expect(await app.dispatchRecoveryJobsOnce()).toEqual({jobId:uploadId,outcome:'preview'}); });
      const recoveryId = await target.withCli(distribution,origin,async owner => {
        const session = await loginCurrentRecoveryCli(owner,origin,'operator',CANONICAL_FILE_PASSWORD);
        const preview = await recoveryCliJson(owner,origin,`/api/system-recovery/jobs/${uploadId}/preview`,'GET',undefined,session);
        expect(preview.status).toBe(200); expect(checkedSystemRecoveryPreview(preview.value)).toMatchObject({canRecover:true,canCutover:false,
          archive:{schema:'system-backup/5',sha256:ARCHIVE_SHA256,complete:true,legacy:false},counts:{files:1,availableFiles:1,unavailableFiles:0,bytes:68}});
        const planned = await recoveryCliJson(owner,origin,'/api/system-recovery/recoveries','POST',{
          requestId:randomUUID(),uploadJobId:uploadId,expectedTargetId:target.descriptor.targetId,mapping:[],mode:'planned',
          acknowledgeLaterChanges:false,acknowledgePartial:false},session);
        expect(planned.status).toBe(409);
        const accepted = await recoveryCliJson(owner,origin,'/api/system-recovery/recoveries','POST',{
          requestId:randomUUID(),uploadJobId:uploadId,expectedTargetId:target.descriptor.targetId,mapping:[],mode:'historical',
          acknowledgeLaterChanges:true,acknowledgePartial:false},session);
        expect(accepted.status).toBe(202); return checkedSystemRecoveryReceipt(accepted.value).job.id;
      });
      await target.withDispatcher(async (app,_client,native) => {
        const checkpoint = object(JSON.parse(String(native.prepare('SELECT checkpoint_json FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.checkpoint_json)));
        expect(checkpoint.plannedSourceWindow).toBeUndefined();
        expect(native.prepare("SELECT count(*) n FROM system_recovery_jobs WHERE kind='backup'").get()?.n).toBe(0);
        for (let count=0;;count++) {
          ensure(count<64); const step=await app.dispatchRecoveryJobsOnce(); expect(step.jobId).toBe(recoveryId); expect(step.outcome).not.toBe('paused');
          if(step.outcome==='target_ready')break;
        }
        expect(native.prepare('SELECT state FROM system_recovery_target_files WHERE job_id=?').all(recoveryId)).toEqual([{state:'published'}]);
        // The current Node SOURCE ledger owns new inert local byte-copy
        // evidence. It does not relabel the archived canonical R2 publication
        // or grant the destination a LOCAL/R2 provider binding.
        const localCopy = native.prepare(`SELECT logical_id,file_id,profile_id,namespace,object_key,byte_size,sha256,state
          FROM system_recovery_target_files WHERE job_id=?`).all(recoveryId);
        expect(localCopy).toHaveLength(1);
        expect(localCopy[0]).toEqual({logical_id:input.member.id,file_id:input.member.fileIds[0],
          profile_id:`node-recovery-inert-profile:${target.descriptor.targetId}`,namespace:stableJson(checkpoint.targetNamespace),
          object_key:`node-v28-target/${target.descriptor.targetId}/${recoveryId}/${input.member.id}`,byte_size:68,sha256:input.member.sha256,state:'published'});
        expect(native.prepare("SELECT status,json_extract(cursor_json,'$.pending') pending FROM system_recovery_target_claim WHERE job_id=?").get(recoveryId))
          .toEqual({status:'ready',pending:0});
      });
      const preparedReport = await target.withCli(distribution,origin,async owner => {
        const session=await loginCurrentRecoveryCli(owner,origin,'operator',CANONICAL_FILE_PASSWORD);
        const reply=await recoveryCliJson(owner,origin,`/api/system-recovery/jobs/${recoveryId}`,'GET',undefined,session);expect(reply.status).toBe(200);
        const state=checkedSystemRecoveryJobStatus(reply.value); expect(state).toMatchObject({kind:'recovery',state:'completed',phase:'ready',
          progress:{completedFiles:1,totalFiles:1,bytesDone:68,bytesTotal:68},result:{ready:true,cutover:false,targetId:target.descriptor.targetId}});
        ensure(state.result?.checkpoint);
        const reportReply=await recoveryCliJson(owner,origin,`/api/system-recovery/jobs/${recoveryId}/report`,'GET',undefined,session);expect(reportReply.status).toBe(200);
        const report=object(reportReply.value); expect(report).toMatchObject({schema:'system-recovery-public-report/1',jobId:recoveryId,
          targetId:target.descriptor.targetId,mode:'historical',historicalLaterChangesLost:true,sourceImageSha256:input.admitted.manifest.sourceCheckpoint,
          targetCheckpoint:state.result.checkpoint,counts:{files:1,bytes:68},
          execution:{shadow:false,authority:false,fileJobs:false,recoveryJobs:false,cleanup:false,oldJobReplay:false},
          handoff:{automaticBindingChange:false,operatorRequired:true,sourceRetainedReadOnly:true}});
        // Prepared report only. No cutover route or destination executable is invoked.
        expect((await recoveryCliJson(owner,origin,`/api/system-recovery/jobs/${recoveryId}/control`,'POST',{action:'cleanup'},session)).status).toBe(409);
        expect((await recoveryCliJson(owner,origin,'/api/system-recovery/executor','POST',{enabled:false},session)).status).toBe(200);
        return report;
      });
      assertCanonicalFileOwnersReleased();
      const destinationInstallationId=await withCanonicalFileDatabase(join(target.destination,'database.sqlite'),async(_owner,lease,native)=>lease.withWriter(async()=>{
        const destination=admitInstallationRecoverySource(native,V28_NODE_INSTALLATION_CATALOG_CANDIDATE).receipt;
        expect(destination.checkpointId).toBe('portable-runtime/v28');expect(destination.installationId).not.toBe(source.baseline.installationId);
        expect(destination.installationId).not.toBe(input.capture.sourceInstallationId);expect(destination.installationId).not.toBe(input.node.destinationInstallationId);
        const specs=PORTABLE_RUNTIME_RECOVERY_TABLES.filter(spec=>!spec.local), rows=currentV28RecoveryTypedRows(native,specs.map(spec=>spec.name));
        for(const spec of specs){const original=input.admitted.records.image.tables[spec.name];ensure(original);
          expect(rows[spec.name],spec.name).toEqual(currentV28RecoveryImageRows(spec.name==='local_accounts'?disabledProtectedAccountTable(original):original));}
        for(const name of ['file_shadow_runtime_guard','file_authority_runtime_guard','file_job_runtime_guard','system_recovery_runtime'])
          expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
        for(const name of ['local_identity_installation','local_admin_grants','local_sessions','local_login_throttle',
          'local_storage_profile_checks','local_storage_profile_admissions','local_storage_profile_bindings','system_storage_native_bindings',
          'file_job_cleanup_grants','system_research_package_cleanup_grants','system_recovery_jobs','system_recovery_target_claim','system_recovery_target_files',
          'collaboration_members','collaboration_identities','collaboration_resources','collaboration_grants'])
          expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n,name).toBe(0);
        expect(native.prepare('SELECT count(*) n FROM local_accounts WHERE enabled<>0').get()?.n).toBe(0);
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('fenced');
        expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(native.prepare('PRAGMA integrity_check').all()).toEqual([{integrity_check:'ok'}]);
        return destination.installationId;
      }));
      const entry=input.admitted.entries.find(value=>value.path===input.member.path);ensure(entry&&input.member.path);
      const payload=await readFile(join(target.destination,input.member.path));expect(payload.byteLength).toBe(68);expect(digest(payload)).toBe(input.member.sha256);
      expect(new Uint8Array(payload)).toEqual(new Uint8Array(input.archiveInput.raw.subarray(entry.dataOffset,entry.dataOffset+entry.byteSize)));
      const mappings=object(JSON.parse(await readFile(join(target.destination,'inert-local-volume-mappings.json'),'utf8')));
      expect(mappings).toMatchObject({mappings:[],executionEnabled:false,installationBindingsRestored:false});
      const inventory=object(JSON.parse(await readFile(join(target.destination,'source-byte-inventory.json'),'utf8')));
      expect(inventory).toMatchObject({schema:'offline-system-recovery-bytes/1',backupId:input.admitted.records.backupId,sourceArchiveSha256:ARCHIVE_SHA256});
      expect(inventory.files).toEqual(input.admitted.manifest.files.map(file=>({...file,localPath:file.path})));
      const report=object(JSON.parse(await readFile(join(target.destination,'recovery-report.json'),'utf8')));
      expect(report).toMatchObject({sourceArchiveSha256:ARCHIVE_SHA256,destinationInstallationId,payloads:1,payloadBytes:68,
        verifiedInertLocalVolumePayloads:0,executionEnabled:false,nativeBindingsRestored:false,maintenanceState:'fenced',deploymentChanged:false});
      const configurationPath=join(source.baseline.root,'r2-held-inert-target-selected-v28-metadata.json');
      await writeFile(configurationPath,JSON.stringify({format:'node-loopback-restored-v28-v1',databaseFile:'database.sqlite',dataDirectory:target.destination,
        expectedInstallationId:destinationInstallationId,publicOrigin:origin,clientDirectory:source.baseline.clientDirectory,enableLocalFile:false,enableLocalJobs:false}),{flag:'wx',mode:0o600});
      const configuration=assertNodeRuntimeConfiguration(loadNodeRuntimeConfiguration(configurationPath,{filesystemRootOwnerUid:source.baseline.rootOwnerUid,runtimeProfile:'v28-metadata'}));
      expect(configuration.enableLocalFile).toBe(false);expect(configuration.enableLocalJobs).toBe(false);expect(configuration.enableLocalRecovery).toBe(false);
      expect(configuration.localVolumes).toEqual([]);expect(configuration.recoveryTarget).toBeUndefined();
      await withCanonicalFileDatabase(source.baseline.path,async(_owner,lease,native)=>lease.withWriter(async()=>{
        expect(currentV28RecoveryTypedRows(native)).toEqual(source.expectedTypedSource);
        expect(currentV28RecoveryTypedRows(native,CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('fenced');
        expect(native.prepare('SELECT enabled FROM system_recovery_runtime WHERE singleton=1').get()?.enabled).toBe(0);
        const result=object(JSON.parse(String(native.prepare('SELECT result_json FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.result_json)));
        expect(result).toMatchObject({ready:true,cutover:false});
        expect(native.prepare('SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL').get()?.n).toBe(0);
      }));
      assertCanonicalFileOwnersReleased();
      for(const value of input.values)await pinned(value.path,value.sha256,value.size);
      expect(digest(await readFile(join(distribution,'manifest.json')))).toBe(manifestSha256);
      await writeFile(output,stableJson({schema:'original-native-r2-held-v5-current-online-node-prepared-target/1',
        originalProducerHead:PRODUCER_HEAD,originalProducerTree:PRODUCER_TREE,originalProducerStageReceiptSha256:PINS.producer.sha256,
        originalNodeProofSha256:PINS.node.sha256,originalClosedD1ProofSha256:PINS.d1.sha256,originalCaptureProofSha256:PINS.capture.sha256,
        currentConsumerHeadFromOriginalRootWrapper:consumerHead,currentConsumerDistributionManifestSha256:manifestSha256,
        sourceArchiveSha256:ARCHIVE_SHA256,sourceLedger:'cloudflare-observed-migrations/1',capturePolicy:'atomic-primary-with-byte-holds/1',
        sourceBackupHoldOwner:input.admitted.records.content.backupHoldOwner,originalLocalRecoveryEvidencePreserved:true,
        exactProtectedHistoryTypedRowsAndRowids:true,allOriginalR2PayloadsVerified:true,payloadBytes:68,payloadSha256:input.member.sha256,
        newInertNodeLocalByteCopyEvidence:true,archivedCanonicalR2PublicationUnchanged:true,newCanonicalLocalProviderAuthority:false,
        uploadId,recoveryId,destinationInstallationId,preparedReport,plannedDifferentSourceWindowRefused:true,explicitHistoricalAcknowledgement:true,
        originalSourceAndTargetOwnerFirstClosesAcknowledged:true,sourceCanonicalAndPhysicalBindingsUnchanged:true,
        destinationFencedAndDefaultOff:true,destinationLocalAuthorityEmpty:true,cutoverInvoked:false,automaticActivation:false,
        sameAppBusinessDrainQualified:false,elapsedRecoveryCadenceQualified:false,fullApplicationRecoveryQualified:false}),{flag:'wx',mode:0o600});
    }),120_000);
});

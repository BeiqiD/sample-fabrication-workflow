// Explicit browser HTTP fixtures. These exercise the real client and its checked
// DTOs; they do not qualify a Node host, executor, archive, target or activation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as contract from '../../../shared/contracts/system-recovery.ts';

export const archiveBytes = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
export const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex');
const at = '2026-10-15T12:00:00.000Z', checkpoint = 'b'.repeat(64);
const base = '/api/system-recovery';
const principalId = 'local_00000000-0000-4000-8000-000000000001';
const csrf = 'a'.repeat(43);
function job(kind, state, id, requestId) {
  return contract.checkedSystemRecoveryJobStatus({ id, requestId, kind, state,
    phase: state === 'preview' || kind === 'recovery' && state === 'completed' ? 'ready' : state === 'completed' ? 'done' : 'snapshot',
    acceptedAt: at, updatedAt: at, reason: null,
    progress: { completedFiles: state === 'completed' ? 1 : 0, totalFiles: 1, bytesDone: state === 'completed' ? archiveBytes.length : 0, bytesTotal: archiveBytes.length },
    output: null, result: kind === 'recovery' ? { targetId: 'isolated-target', ready: true, cutover: false, checkpoint } : null });
}
export function createSupportedRecoveryFixture({ runtime = 'node', target = true, loseResumeAck = false } = {}) {
  assert(['node', 'worker'].includes(runtime));
  const journal = [], receipts = new Map(), maintenanceReceipts = new Map(), resumeReceipts = new Map();
  let jobs = [], uploads = new Map(), enabled = true, revoked = false;
  let maintenance = { state: 'open', generation: 0, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 };
  const policy = runtime === 'node'
    ? { recoveryMapping: 'inert-preserve', backupMaintenance: 'always', maintenanceWithoutTarget: true, recoveryCleanup: false, sourceResume: true }
    : { recoveryMapping: 'explicit-profile', backupMaintenance: 'planned-only', maintenanceWithoutTarget: false, recoveryCleanup: true, sourceResume: false };
  function capability() {
    return contract.checkedSystemRecoveryCapabilities({ supported: true, canManage: !revoked, enabled, stale: false, lastHeartbeatAt: at,
      cadenceSeconds: 120, maxStepMs: 60000, reason: enabled ? null : 'executor_disabled',
      target: { configured: target, id: target ? 'isolated-target' : null, mode: 'fresh' },
      maintenance: { state: maintenance.state, checkpoint: maintenance.checkpoint }, policy });
  }
  function preview() {
    return contract.checkedSystemRecoveryPreview({ schema: 'system-recovery-preview/1',
      archive: { schema: 'system-backup/1', byteSize: archiveBytes.length, sha256: archiveSha256, complete: true, legacy: false, recoveryPoint: at },
      counts: { tables: 103, rows: 400, files: 1, bytes: 16, availableFiles: 1, unavailableFiles: 0 },
      files: [{ id: 'file-original', purpose: 'research_source', byteSize: 16, status: 'packaged', reason: null, sourceProfileId: 'source-r2' }],
      profiles: [{ id: 'source-r2', adapterType: 'r2', namespaceIdentity: 'original-source-namespace' }],
      protectedSettings: { included: true, credentialRecovery: 'quarantined', warnings: ['credential_quarantined'] }, oldJobs: { paused: 3, automaticReplay: false },
      target: { id: target ? 'isolated-target' : null, available: target, reason: target ? null : 'recovery_target_missing' },
      source: { maintenanceRequired: true, checkpoint: null, mode: 'historical' }, canRecover: target, canCutover: false, reasons: [] });
  }
  function remember(value) { jobs = [value, ...jobs.filter(item => item.id !== value.id)]; return value; }
  const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  async function handle(request, response) {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname, method = request.method;
    if (!pathname.startsWith('/api/')) return false;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), input = bytes.length && request.headers['content-type'] !== 'application/zip' ? JSON.parse(bytes.toString('utf8')) : undefined;
    const entry = { method, path: pathname, ...(input === undefined ? {} : { input }), ...(bytes.length && input === undefined ? { byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } : {}) };
    journal.push(entry);
    if (pathname === '/api/auth/session') {
      json(response, { principal: { id: principalId, actor: `local-account:${principalId}`, capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf }); return true;
    }
    if (method !== 'GET') assert.equal(request.headers['x-sfw-csrf'], csrf, 'Actual Node client must attach its session CSRF.');
    if (revoked) { entry.responseStatus = 403; json(response, { error: 'administrator_required' }, 403); return true; }
    if (pathname === `${base}/capabilities`) { json(response, capability()); return true; }
    if (pathname === `${base}/maintenance` && method === 'GET') { json(response, contract.checkedSystemRecoveryMaintenanceStatus(maintenance)); return true; }
    if (pathname.startsWith(`${base}/maintenance/requests/`)) {
      const receipt = maintenanceReceipts.get(decodeURIComponent(pathname.split('/').at(-1))); json(response, receipt ?? {}, receipt ? 200 : 404); return true;
    }
    if (pathname === `${base}/maintenance` && method === 'POST') {
      const checked = contract.checkedSystemRecoveryMaintenanceInput(input);
      assert.equal(checked.expectedGeneration, maintenance.generation);
      maintenance = { ...maintenance, state: checked.action === 'enter' ? 'draining' : checked.action === 'finalize' ? 'fenced' : 'open',
        generation: maintenance.generation + (checked.action === 'finalize' ? 0 : 1), token: checked.action === 'release' ? null : maintenance.token || checked.requestId,
        checkpoint: checked.action === 'finalize' ? maintenance.checkpoint : null,
        backupJobId: checked.action === 'finalize' ? maintenance.backupJobId : null };
      const receipt = contract.checkedSystemRecoveryMaintenanceReceipt({ ...checked, status: maintenance });
      entry.maintenanceStatus = receipt.status;
      maintenanceReceipts.set(checked.requestId, receipt); json(response, receipt); return true;
    }
    if (pathname === `${base}/backup-preview`) {
      const available = runtime !== 'node' || maintenance.state === 'fenced';
      await new Promise(resolve => setTimeout(resolve, 80));
      json(response, contract.checkedSystemRecoveryBackupPreview({ schema: 'system-backup-preview/1', available, reasons: available ? [] : ['source_not_fenced'],
        includesProtectedSettings: true, credentialsRequireKeyring: true,
        bounds: { archiveBytes: 104857600, payloadBytes: 100663296, metadataBytes: 4194304, files: 100, maxStepMs: 60000 },
        maintenance: { state: maintenance.state, checkpoint: maintenance.checkpoint } })); return true;
    }
    if (pathname === `${base}/jobs` && method === 'GET') { json(response, { jobs }); return true; }
    if (pathname === `${base}/jobs` && method === 'POST') {
      const checked = contract.checkedSystemRecoveryBackupInput(input); assert(runtime !== 'node' || maintenance.state === 'fenced');
      const accepted = remember(job('backup', 'completed', 'backup-original', checked.requestId));
      const receipt = contract.checkedSystemRecoveryReceipt({ requestId: checked.requestId, job: accepted, reused: false }); receipts.set(checked.requestId, receipt);
      maintenance = { ...maintenance, checkpoint, backupJobId: accepted.id }; json(response, receipt, 202); return true;
    }
    if (pathname === `${base}/uploads` && method === 'POST') {
      const checked = contract.checkedSystemRecoveryUploadInput(input); assert.equal(checked.byteSize, archiveBytes.length); assert.equal(checked.sha256, archiveSha256);
      const accepted = remember(job('upload', 'awaiting_upload', 'upload-original', checked.requestId)); uploads.set(accepted.id, checked);
      const receipt = contract.checkedSystemRecoveryReceipt({ requestId: checked.requestId, job: accepted, reused: false }); receipts.set(checked.requestId, receipt); json(response, receipt, 202); return true;
    }
    if (pathname === `${base}/jobs/upload-original/upload` && method === 'PUT') {
      assert.deepEqual(bytes, archiveBytes); json(response, remember(job('upload', 'preview', 'upload-original', uploads.get('upload-original').requestId))); return true;
    }
    if (pathname === `${base}/jobs/upload-original/upload-intent`) { json(response, uploads.get('upload-original')); return true; }
    if (pathname.endsWith('/preview') && method === 'GET') { json(response, preview()); return true; }
    if (pathname === `${base}/recoveries` && method === 'POST') {
      const checked = contract.checkedSystemRecoveryImportInput(input); assert(target); assert.equal(checked.uploadJobId, 'upload-original');
      if (runtime === 'node') assert.deepEqual(checked.mapping, []);
      else assert.deepEqual(checked.mapping, [{ sourceProfileId: 'source-r2', destinationProfileId: 'destination-r2', configurationRevision: 7 }]);
      const accepted = remember(job('recovery', 'completed', 'recovery-original', checked.requestId));
      const receipt = contract.checkedSystemRecoveryReceipt({ requestId: checked.requestId, job: accepted, reused: false }); receipts.set(checked.requestId, receipt); json(response, receipt, 202); return true;
    }
    if (pathname.startsWith(`${base}/requests/`) && method === 'GET') {
      const receipt = receipts.get(decodeURIComponent(pathname.split('/').at(-1))); json(response, receipt ?? {}, receipt ? 200 : 404); return true;
    }
    if (pathname === `${base}/executor` && method === 'POST') { assert.equal(typeof input.enabled, 'boolean'); enabled = input.enabled; json(response, capability()); return true; }
    if (pathname === `${base}/source-resume` && method === 'POST') {
      const checked = contract.checkedSystemRecoverySourceResumeInput(input); assert(!enabled); assert.equal(maintenance.state, 'open');
      const release = maintenanceReceipts.get(checked.releaseRequestId); assert.equal(release.action, 'release'); assert.equal(release.status.generation, checked.expectedGeneration);
      assert(jobs.some(item => item.id === checked.backupJobId && item.kind === 'backup' && item.state === 'completed'));
      const receipt = contract.checkedSystemRecoverySourceResumeReceipt({ ...checked, schema: 'node-original-source-resume/1',
        sourceInstallationId: 'source-installation', incarnation: 'source-incarnation', sourceCheckpoint: checkpoint, resumedAt: at,
        enabled: true, shadowEnabled: false, jobsEnabled: false, noBindingCutover: true, noJobReplay: true });
      resumeReceipts.set(checked.requestId, receipt);
      if (loseResumeAck) {
        // Headers prevent Chromium's transparent retry of a connection closed
        // before any HTTP response. The persisted receipt exists, but its body
        // is intentionally incomplete so the page retains its original intent.
        entry.responseStatus = 200; entry.ackBodyTruncated = true;
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '10000', 'cache-control': 'no-store' });
        response.flushHeaders(); response.write('{"schema":'); response.socket.end(); return true;
      }
      json(response, receipt); return true;
    }
    if (pathname.startsWith(`${base}/source-resume/requests/`) && method === 'GET') {
      const receipt = resumeReceipts.get(decodeURIComponent(pathname.split('/').at(-1))); json(response, receipt ?? {}, receipt ? 200 : 404); return true;
    }
    if (pathname.startsWith(`${base}/jobs/`) && method === 'GET') {
      const accepted = jobs.find(item => item.id === decodeURIComponent(pathname.split('/').at(-1))); json(response, accepted ?? {}, accepted ? 200 : 404); return true;
    }
    entry.unexpected = true; json(response, { error: 'unexpected_browser_fixture_route' }, 404); return true;
  }
  return { handle, journal, revoke() { revoked = true; }, snapshot() { return { runtime, target, policy, jobs, maintenance, enabled }; } };
}

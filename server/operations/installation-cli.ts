import { executeInstallationUpgrade, parseInstallationUpgradeCommand } from './installation-operator';
import { executeInstallationInspection, parseInstallationInspectionCommand } from './installation-inspection';
import { parseV28GroupInstallationCommand, V28_GROUP_INSTALLATION_USAGE } from './v28-group-installation-command.ts';

const USAGE = 'Usage: local-installation upgrade --database <canonical-private-db> [--filesystem-root-owner-uid UID]\nStop the local development server first. An exact V25 or V26 installation and its empty private .writer-lock file must already exist. This metadata operation reads no password and creates no administrator or File/provider authority.\n';
async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(USAGE + 'Usage: local-installation inspect --database <canonical-private-db> [--filesystem-root-owner-uid UID]\nInspection requires an exact current V26/24 installation and prints only installationId, catalogId and checkpointId after the stopped writer closes and releases. It never installs or upgrades a schema.\n' + V28_GROUP_INSTALLATION_USAGE
      + 'Usage: local-installation release-restored-maintenance --runtime-profile v28 --database <private-restored-database.sqlite> --principal local_UUID --installation UUID --request-id UUID --expected-generation N [--filesystem-root-owner-uid UID]\nExplicit stopped restored-target release only. No automatic Group/File/Jobs/domain activation; uncertain outcomes require the same request ID.\n'
      + 'Usage: local-installation capture-local-backup --runtime-profile v28 --configuration <private-capture.json> --archive <new-private-archive.zip> --installation UUID [--filesystem-root-owner-uid UID]\nExplicit stopped V5 capture only. Source File/profile authority must already exist; partial archives are reported truthfully and cannot be restored as complete.\n'); return;
  }
  if (process.argv[2] === 'capture-local-backup') {
    const { parseV28MaintenanceCaptureCommand } = await import('./v28-maintenance-capture-command.ts');
    const { executeLocalV28MaintenanceCaptureCandidate } = await import('./local-v28-maintenance-capture-operator-candidate.ts');
    const command = parseV28MaintenanceCaptureCommand(process.argv.slice(2));
    // The original capture result is returned only after its owned byte/FD,
    // opening, Native and Linux writer first-close chain has acknowledged.
    const original = executeLocalV28MaintenanceCaptureCandidate(command);
    const receipt = await original;
    process.stdout.write(JSON.stringify(receipt) + '\n'); return;
  }
  if (process.argv[2] === 'release-restored-maintenance') {
    const { parseRestoredV28MaintenanceReleaseCommand, executeRestoredV28MaintenanceRelease } = await import('./restored-v28-maintenance-release-operator.ts');
    const command = parseRestoredV28MaintenanceReleaseCommand(process.argv.slice(2));
    const original = executeRestoredV28MaintenanceRelease(command);
    const receipt = await original;
    process.stdout.write(JSON.stringify(receipt) + '\n'); return;
  }
  if (process.argv[2] === 'enroll-local-member' || process.argv[2] === 'set-enforcement') {
    const selected = parseV28GroupInstallationCommand(process.argv.slice(2));
    const { executeCollaborationV28OperatorCandidate } = await import('./collaboration-v28-operator-candidate.ts');
    const receipt = await executeCollaborationV28OperatorCandidate(selected);
    process.stdout.write(JSON.stringify(receipt) + '\n'); return;
  }
  if (process.argv[2] === 'inspect') {
    const inspection = parseInstallationInspectionCommand(process.argv.slice(2));
    const receipt = await executeInstallationInspection(inspection);
    process.stdout.write(JSON.stringify(receipt) + '\n'); return;
  }
  const command = parseInstallationUpgradeCommand(process.argv.slice(2));
  await executeInstallationUpgrade(command);
  process.stdout.write('Offline installation upgrade completed.\n');
}
void main().catch(() => {
  // No raw SQL/cause, path, credential or untrusted argument diagnostics.
  if (process.argv[2] === 'capture-local-backup') {
    process.stderr.write('Stopped local V28 backup capture unavailable; retain the original outcome before considering another capture.\n');
    process.exitCode = 1; return;
  }
  if (process.argv[2] === 'release-restored-maintenance') {
    process.stderr.write('Stopped restored V28 maintenance release unavailable; reconcile the same request ID.\n'); process.exitCode = 1; return;
  }
  if (process.argv[2] === 'enroll-local-member' || process.argv[2] === 'set-enforcement') {
    process.stderr.write('Offline collaboration operation unavailable.\n'); process.exitCode = 1; return;
  }
  process.stderr.write(process.argv[2] === 'inspect' ? 'Offline installation inspection unavailable.\n' : 'Offline installation upgrade unavailable.\n'); process.exitCode = 1;
});

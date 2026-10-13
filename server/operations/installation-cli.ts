import { executeInstallationUpgrade, parseInstallationUpgradeCommand } from './installation-operator';
import { executeInstallationInspection, parseInstallationInspectionCommand } from './installation-inspection';
import { parseV28GroupInstallationCommand, V28_GROUP_INSTALLATION_USAGE } from './v28-group-installation-command.ts';

const USAGE = 'Usage: local-installation upgrade --database <canonical-private-db> [--filesystem-root-owner-uid UID]\nStop the local development server first. An exact V25 or V26 installation and its empty private .writer-lock file must already exist. This metadata operation reads no password and creates no administrator or File/provider authority.\n';
async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(USAGE + 'Usage: local-installation inspect --database <canonical-private-db> [--filesystem-root-owner-uid UID]\nInspection requires an exact current V26/24 installation and prints only installationId, catalogId and checkpointId after the stopped writer closes and releases. It never installs or upgrades a schema.\n' + V28_GROUP_INSTALLATION_USAGE); return;
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
  if (process.argv[2] === 'enroll-local-member' || process.argv[2] === 'set-enforcement') {
    process.stderr.write('Offline collaboration operation unavailable.\n'); process.exitCode = 1; return;
  }
  process.stderr.write(process.argv[2] === 'inspect' ? 'Offline installation inspection unavailable.\n' : 'Offline installation upgrade unavailable.\n'); process.exitCode = 1;
});

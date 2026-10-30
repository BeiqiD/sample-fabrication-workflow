import { canonicalIdentityText } from '../../shared/contracts/request-subject.ts';
import type { CollaborationOperatorV28Command } from './collaboration-v28-operator-candidate.ts';

export class V28GroupInstallationCommandError extends Error {
  constructor() { super('The explicit V28 collaboration command is unavailable.'); this.name = 'V28GroupInstallationCommandError'; }
}
export const V28_GROUP_INSTALLATION_USAGE = 'Usage: local-installation enroll-local-member --runtime-profile v28 --database <canonical-private-db> --principal local_UUID --display-name <name> --workspace-role <member|membershipAdministrator> --can-create-samples <true|false> --expected-control-revision <revision> [--filesystem-root-owner-uid UID]\nUsage: local-installation set-enforcement --runtime-profile v28 --database <canonical-private-db> --enforcement <disabled|enabled> --expected-control-revision <revision> [--filesystem-root-owner-uid UID]\nThese explicit commands require an already installed V28 destination and a stopped real writer. Enrollment requires disabled Group enforcement; enablement requires an actual active membership administrator. They create no session, root grant, File/Job activation or maintenance release. Receipts become available only after the original stopped owner closes.\n';
type Selected = Extract<CollaborationOperatorV28Command, { kind: 'enroll-local-member' | 'set-enforcement' }>;
function reject(): never { throw new V28GroupInstallationCommandError(); }

/** This parser chooses an existing code-owned stopped operation only. No actor,
 * issuer, catalog, SQL, executable, secret or recovery-release option exists. */
export function parseV28GroupInstallationCommand(argv: readonly string[]): Selected {
  if (!Array.isArray(argv) || argv.length > 17 || (argv.length - 1) % 2
    || argv.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) reject();
  const kind = argv[0];
  if (kind !== 'enroll-local-member' && kind !== 'set-enforcement') reject();
  const names = kind === 'enroll-local-member'
    ? ['--principal', '--display-name', '--workspace-role', '--can-create-samples'] : ['--enforcement'];
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!, value = argv[index + 1]!;
    if (!['--runtime-profile', '--database', '--filesystem-root-owner-uid', '--expected-control-revision', ...names].includes(name)
      || fields.has(name)) reject();
    fields.set(name, value);
  }
  if (fields.get('--runtime-profile') !== 'v28') reject();
  const databasePath = fields.get('--database');
  if (!databasePath || databasePath.length > 4000) reject();
  const revision = fields.get('--expected-control-revision');
  if (!revision || !/^[1-9][0-9]{0,15}$/.test(revision) || !Number.isSafeInteger(Number(revision))
    || Number(revision) >= Number.MAX_SAFE_INTEGER) reject();
  const expectedControlRevision = Number(revision), root = fields.get('--filesystem-root-owner-uid');
  if (root !== undefined && (!/^(?:0|[1-9][0-9]{0,9})$/.test(root) || Number(root) > 0xffff_ffff)) reject();
  const owner = root === undefined ? {} : { filesystemRootOwnerUid: Number(root) };
  if (kind === 'set-enforcement') {
    const enforcement = fields.get('--enforcement');
    if (enforcement !== 'disabled' && enforcement !== 'enabled') reject();
    return Object.freeze({ kind, databasePath, expectedControlRevision, enforcement, ...owner });
  }
  const principalId = fields.get('--principal'), displayName = fields.get('--display-name');
  const workspaceRole = fields.get('--workspace-role'), samples = fields.get('--can-create-samples');
  if (!principalId || !/^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(principalId)
    || !canonicalIdentityText(displayName, 200) || workspaceRole !== 'member' && workspaceRole !== 'membershipAdministrator'
    || samples !== 'true' && samples !== 'false') reject();
  return Object.freeze({ kind, databasePath, principalId, displayName, workspaceRole,
    canCreateSamples: samples === 'true', expectedControlRevision, ...owner });
}

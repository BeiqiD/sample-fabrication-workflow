import { DatabaseSync } from 'node:sqlite';
import { createInstalledLocalIdentity } from '../auth/identity';
import { createPasswordHasher } from '../auth/passwords';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations';
import { createSqliteCapability, type SqliteCapability } from '../sqlite';
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from './writer-lease';
import { assertOperatorPassword } from './operator-password';

// Raw code-owned catalog only. Current migrations owns immutable static
// validation/expected-schema reuse; Native and current authority admissions
// below remain fresh on every operation/constructor/KDF fence.
const reviewedV28Catalog = V28_NODE_INSTALLATION_CATALOG_CANDIDATE;

export class V28OrdinaryAccountOperatorError extends Error {
  constructor() { super('The offline identity operation is unavailable.'); this.name = 'V28OrdinaryAccountOperatorError'; }
}
export type V28OrdinaryAccountOperatorCommand = Readonly<{
  databasePath: string; filesystemRootOwnerUid?: number;
  kind: 'provision-account'; username: string;
}>;
// These limits serve only this stopped-writer offline composition. No sessions
// are issued, and a runtime's supported session policy belongs to its composer.
const OFFLINE_POLICY = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });
interface OperatorOwner { lease?: LinuxWriterLease; native?: DatabaseSync; quarantined: boolean }
const operatorOwners = new Set<OperatorOwner>();

export function v28OrdinaryAccountOperatorProcessState(): Readonly<{ activeOperations: number; quarantinedOperations: number }> {
  return Object.freeze({ activeOperations: [...operatorOwners].filter(owner => !owner.quarantined).length,
    quarantinedOperations: [...operatorOwners].filter(owner => owner.quarantined).length });
}

/** SOURCE-ONLY ordinary account command; no password argv/environment,
 * bootstrap/schema installation or administrator/membership/resource grants. */
export function parseV28OrdinaryAccountOperatorCommand(argv: readonly string[]): V28OrdinaryAccountOperatorCommand {
  if (!Array.isArray(argv) || argv.length > 7 || argv.some(value => typeof value !== 'string' || value.length > 4096)) throw new V28OrdinaryAccountOperatorError();
  const kind = argv[0];
  if (kind !== 'provision-account' || (argv.length - 1) % 2) throw new V28OrdinaryAccountOperatorError();
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!, value = argv[index + 1]!;
    if (!['--database', '--username', '--filesystem-root-owner-uid'].includes(name) || fields.has(name)) throw new V28OrdinaryAccountOperatorError();
    fields.set(name, value);
  }
  const databasePath = fields.get('--database');
  if (!databasePath || databasePath.length > 4000 || databasePath.includes('\0')) throw new V28OrdinaryAccountOperatorError();
  let filesystemRootOwnerUid: number | undefined;
  const root = fields.get('--filesystem-root-owner-uid');
  if (root !== undefined) {
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(root)) throw new V28OrdinaryAccountOperatorError();
    filesystemRootOwnerUid = Number(root);
    if (filesystemRootOwnerUid > 0xffff_ffff) throw new V28OrdinaryAccountOperatorError();
  }
  const owner = filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid };
  const username = fields.get('--username');
  if (!username || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) throw new V28OrdinaryAccountOperatorError();
  return Object.freeze({ kind: 'provision-account' as const, databasePath, username, ...owner });
}

/** Actual stopped-writer operator, not an HTTP/bootstrap route. Caller obtains
 * the secret through bounded stdin/TTY BEFORE calling this function. The exact
 * code-owned current catalog is the sole admission source. A preprovisioned private
 * database+lock is required; neither path is created/deleted/replaced here.
 * No SQL transaction spans constructor/password KDF. Physical ownership wraps
 * that original promise through its mutation and actual native-close cleanup. */
export async function executeV28OrdinaryAccountOperatorCandidate(commandInput: V28OrdinaryAccountOperatorCommand, password: string): Promise<Readonly<{ principalId: string; systemAdministrator: false }>> {
  assertOperatorPassword(password);
  // Copy and re-parse one fixed command before any await; caller mutation cannot
  // switch the selected DB/account halfway through ownership acquisition.
  const rootInput = commandInput?.filesystemRootOwnerUid;
  const args = [commandInput?.kind, '--database', commandInput?.databasePath,
    '--username', commandInput?.username];
  if (rootInput !== undefined) args.push('--filesystem-root-owner-uid', String(rootInput));
  const command = parseV28OrdinaryAccountOperatorCommand(args);
  if (operatorOwners.size >= 2) throw new V28OrdinaryAccountOperatorError();
  // Reserve synchronously; concurrent calls cannot outrun a cleanup-only count.
  const owner: OperatorOwner = { quarantined: false }; operatorOwners.add(owner);
  let lease: LinuxWriterLease | undefined, native: DatabaseSync | undefined, database: SqliteCapability | undefined;
  let failed = false;
  let result: Readonly<{ principalId: string; systemAdministrator: false }> | undefined;
  try {
    lease = await acquireLinuxWriterLease({ databasePath: command.databasePath,
      ...(command.filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid: command.filesystemRootOwnerUid }) });
    owner.lease = lease;
    native = new DatabaseSync(command.databasePath, { allowExtension: false, enableForeignKeyConstraints: true });
    owner.native = native;
    database = createSqliteCapability(native); lease.bind(database, native);
    const ownedLease = lease, ownedNative = native, ownedDatabase = database;
    await lease.withWriter(async () => {
      assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
      // Admission only: a separate explicit reviewed metadata upgrade must have
      // installed V28. This operation never initializes/updates schema or grants.
      const admission = admitInstallationRecoverySource(ownedNative, reviewedV28Catalog);
      const identity = await createInstalledLocalIdentity({ database: ownedDatabase, nativeDatabase: ownedNative,
        admission, hasher: createPasswordHasher(), policy: OFFLINE_POLICY });
      assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
      const offline = identity.offline({ assertHeld() {
        assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
        assertInstallationAdmission(ownedNative, admission);
      } });
      const principal = await offline.provisionAccount({ username: command.username, password, now: Date.now() });
      if (principal.capabilities.systemAdministrator) throw new V28OrdinaryAccountOperatorError();
      result = Object.freeze({ principalId: principal.id, systemAdministrator: false as const });
    });
  } catch { failed = true; }
  finally {
    if (lease) {
      try {
        await lease.stopAdmissionAndDrain();
        if (database) database.close(); else if (native?.isOpen) native.close();
        // Binding may itself have failed. The actual native owner must still be
        // closed. A reported core-close failure is retained; never retry it via
        // raw native or release after an uncertain original cleanup.
        if (native?.isOpen) throw new V28OrdinaryAccountOperatorError();
        await lease.release(); operatorOwners.delete(owner);
      } catch { owner.quarantined = true; failed = true; }
    } else operatorOwners.delete(owner); // Acquisition quarantine belongs to the lease factory.
  }
  if (failed || !result) throw new V28OrdinaryAccountOperatorError();
  return result;
}

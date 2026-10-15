import { DatabaseSync } from 'node:sqlite';
import { createInstalledLocalIdentity } from '../auth/identity';
import { createPasswordHasher } from '../auth/passwords';
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from '../operational-installation-catalog';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource, installReviewedSqliteCatalog } from '../migrations';
import { createSqliteCapability, type SqliteCapability } from '../sqlite';
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from './writer-lease';
import { assertOperatorPassword } from './operator-password';

export class IdentityOperatorError extends Error {
  constructor() { super('The offline identity operation is unavailable.'); this.name = 'IdentityOperatorError'; }
}
export type IdentityOperatorCommand = Readonly<{
  databasePath: string; filesystemRootOwnerUid?: number; runtimeProfile?: 'v28';
} & ({ kind: 'bootstrap'; username: string } | { kind: 'restore-administrator' | 'reset-password'; principalId: string })>;
const PRINCIPAL = /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// These limits serve only this stopped-writer offline composition. No sessions
// are issued, and a runtime's supported session policy belongs to its composer.
const OFFLINE_POLICY = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });
interface OperatorOwner { lease?: LinuxWriterLease; native?: DatabaseSync; database?: SqliteCapability; failure?: unknown; quarantined: boolean }
const operatorOwners = new Set<OperatorOwner>();

export function identityOperatorProcessState(): Readonly<{ activeOperations: number; quarantinedOperations: number }> {
  return Object.freeze({ activeOperations: [...operatorOwners].filter(owner => !owner.quarantined).length,
    quarantinedOperations: [...operatorOwners].filter(owner => owner.quarantined).length });
}

/** Strict public command parser. Passwords are never options/environment values;
 * rejected arguments are not interpolated into diagnostics. Only one exact
 * destination account may be given for recovery/reset, never an email grant. */
export function parseIdentityOperatorCommand(argv: readonly string[]): IdentityOperatorCommand {
  if (!Array.isArray(argv) || argv.length > 9 || argv.some(value => typeof value !== 'string' || value.length > 4096)) throw new IdentityOperatorError();
  const kind = argv[0];
  if (!['bootstrap', 'restore-administrator', 'reset-password'].includes(kind) || (argv.length - 1) % 2) throw new IdentityOperatorError();
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!, value = argv[index + 1]!;
    if (!['--database', '--username', '--principal', '--filesystem-root-owner-uid', '--runtime-profile'].includes(name) || fields.has(name)) throw new IdentityOperatorError();
    fields.set(name, value);
  }
  const runtimeProfile = fields.get('--runtime-profile');
  if (runtimeProfile !== undefined && runtimeProfile !== 'v28' || runtimeProfile === undefined && argv.length > 7
    || runtimeProfile === 'v28' && kind === 'bootstrap') throw new IdentityOperatorError();
  const profile = runtimeProfile === 'v28' ? { runtimeProfile: 'v28' as const } : {};
  const databasePath = fields.get('--database');
  if (!databasePath || databasePath.length > 4000 || databasePath.includes('\0')) throw new IdentityOperatorError();
  let filesystemRootOwnerUid: number | undefined;
  const root = fields.get('--filesystem-root-owner-uid');
  if (root !== undefined) {
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(root)) throw new IdentityOperatorError();
    filesystemRootOwnerUid = Number(root);
    if (filesystemRootOwnerUid > 0xffff_ffff) throw new IdentityOperatorError();
  }
  const owner = filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid };
  if (kind === 'bootstrap') {
    const username = fields.get('--username');
    if (!username || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username) || fields.has('--principal')) throw new IdentityOperatorError();
    return Object.freeze({ kind, databasePath, username, ...owner });
  }
  const principalId = fields.get('--principal');
  if (!principalId || !PRINCIPAL.test(principalId) || fields.has('--username')) throw new IdentityOperatorError();
  return Object.freeze({ kind: kind as 'restore-administrator' | 'reset-password', databasePath, principalId, ...owner, ...profile });
}

/** Actual stopped-writer operator, not an HTTP/bootstrap route. Caller obtains
 * the secret through bounded stdin/TTY BEFORE calling this function. The exact
 * code-owned current catalog is the sole DDL source. A preprovisioned private
 * database+lock is required; neither path is created/deleted/replaced here.
 * No SQL transaction spans constructor/password KDF. Physical ownership wraps
 * that original promise through its mutation and actual native-close cleanup. */
export async function executeIdentityOperator(commandInput: IdentityOperatorCommand, password: string): Promise<void> {
  assertOperatorPassword(password);
  // Copy and re-parse one fixed command before any await; caller mutation cannot
  // switch the selected DB/account halfway through ownership acquisition.
  const rootInput = commandInput?.filesystemRootOwnerUid;
  const args = [commandInput?.kind, '--database', commandInput?.databasePath,
    commandInput?.kind === 'bootstrap' ? '--username' : '--principal',
    commandInput?.kind === 'bootstrap' ? commandInput.username : commandInput?.principalId];
  if (rootInput !== undefined) args.push('--filesystem-root-owner-uid', String(rootInput));
  if (commandInput?.runtimeProfile !== undefined) args.push('--runtime-profile', commandInput.runtimeProfile);
  const command = parseIdentityOperatorCommand(args);
  const catalog = command.runtimeProfile === 'v28' ? V28_NODE_INSTALLATION_CATALOG_CANDIDATE : OPERATIONAL_NODE_INSTALLATION_CATALOG;
  if (operatorOwners.size >= 2) throw new IdentityOperatorError();
  // Reserve synchronously; concurrent calls cannot outrun a cleanup-only count.
  const owner: OperatorOwner = { quarantined: false }; operatorOwners.add(owner);
  let lease: LinuxWriterLease | undefined, native: DatabaseSync | undefined, database: SqliteCapability | undefined;
  let failed = false;
  try {
    lease = await acquireLinuxWriterLease({ databasePath: command.databasePath,
      ...(command.filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid: command.filesystemRootOwnerUid }) });
    owner.lease = lease;
    native = new DatabaseSync(command.databasePath, { allowExtension: false, enableForeignKeyConstraints: true });
    owner.native = native;
    database = owner.database = createSqliteCapability(native); lease.bind(database, native);
    const ownedLease = lease, ownedNative = native, ownedDatabase = database;
    await lease.withWriter(async () => {
      assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
      // Bootstrap can initialize a genuinely empty private file. Every
      // existing installation must already admit the fixed operational
      // checkpoint; reset/restore/bootstrap cannot silently upgrade V25.
      // Explicit V28 restores/resets admit only an already installed exact V28.
      // They never bootstrap, upgrade, reopen maintenance or activate runtime guards.
      if (command.kind === 'bootstrap' && !ownedNative.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
        installReviewedSqliteCatalog(ownedNative, OPERATIONAL_NODE_INSTALLATION_CATALOG);
      const admission = admitInstallationRecoverySource(ownedNative, catalog);
      const identity = await createInstalledLocalIdentity({ database: ownedDatabase, nativeDatabase: ownedNative,
        admission, hasher: createPasswordHasher(), policy: OFFLINE_POLICY });
      assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
      const offline = identity.offline(ownedLease), now = Date.now();
      if (command.kind === 'bootstrap') await offline.bootstrap({ username: command.username, password, now });
      else if (command.kind === 'restore-administrator') await offline.restoreAdministrator({ principalId: command.principalId, password, now });
      else await offline.resetPassword(command.principalId, password, now);
    });
  } catch { failed = true; }
  finally {
    if (lease) {
      try {
        await lease.stopAdmissionAndDrain();
        if (database) database.close(); else if (native?.isOpen) native.close();
        if (native?.isOpen) throw new IdentityOperatorError();
        await lease.release();
        operatorOwners.delete(owner);
      } catch (cleanupError) {
        owner.failure = cleanupError;
        // Retain the exact original owner after any failed drain/native/FD ACK.
        // Never substitute raw native close or infer success from isOpen=false.
        owner.quarantined = true; failed = true;
      }
    } else operatorOwners.delete(owner); // Acquisition quarantine belongs to the lease factory.
  }
  if (failed) throw new IdentityOperatorError();
}

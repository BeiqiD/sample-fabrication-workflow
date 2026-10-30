import { DatabaseSync } from 'node:sqlite';
import { CURRENT_NODE_INSTALLATION_CATALOG as FROZEN_V25_NODE_INSTALLATION_CATALOG } from '../installation-catalog';
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from '../operational-installation-catalog';
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog } from '../migrations';
import { createSqliteCapability, type SqliteCapability } from '../sqlite';
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from './writer-lease';

export class InstallationOperatorError extends Error {
  constructor() { super('The offline installation upgrade is unavailable.'); this.name = 'InstallationOperatorError'; }
}
export type InstallationUpgradeCommand = Readonly<{
  kind: 'upgrade'; databasePath: string; filesystemRootOwnerUid?: number;
}>;
interface OperatorOwner { lease?: LinuxWriterLease; native?: DatabaseSync; database?: SqliteCapability; failure?: unknown; quarantined: boolean }
const owners = new Set<OperatorOwner>();

export function installationOperatorProcessState(): Readonly<{ activeOperations: number; quarantinedOperations: number }> {
  return Object.freeze({ activeOperations: [...owners].filter(owner => !owner.quarantined).length,
    quarantinedOperations: [...owners].filter(owner => owner.quarantined).length });
}

/** One explicit local command. No caller-selected catalog, SQL, credentials,
 * administrator, provider or default-role options are accepted. */
export function parseInstallationUpgradeCommand(argv: readonly string[]): InstallationUpgradeCommand {
  if (!Array.isArray(argv) || ![3, 5].includes(argv.length) || argv[0] !== 'upgrade'
    || argv.some(value => typeof value !== 'string' || value.length > 4096)) throw new InstallationOperatorError();
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!, value = argv[index + 1]!;
    if (!['--database', '--filesystem-root-owner-uid'].includes(name) || fields.has(name)) throw new InstallationOperatorError();
    fields.set(name, value);
  }
  const databasePath = fields.get('--database');
  if (!databasePath || databasePath.length > 4000 || databasePath.includes('\0')) throw new InstallationOperatorError();
  const root = fields.get('--filesystem-root-owner-uid');
  if (root === undefined) return Object.freeze({ kind: 'upgrade', databasePath });
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(root) || Number(root) > 0xffff_ffff) throw new InstallationOperatorError();
  return Object.freeze({ kind: 'upgrade', databasePath, filesystemRootOwnerUid: Number(root) });
}

/** Stopped-writer metadata upgrade of an existing exact V25 or V26 installation.
 * Real Linux lease acquisition precedes native open. The reviewed installer
 * owns its synchronous atomic transaction; no password KDF/provider work runs.
 * Identity, sessions, credential rows and File defaults are not operator inputs.
 * The same actual native/core tuple closes before physical ownership releases. */
export async function executeInstallationUpgrade(input: InstallationUpgradeCommand): Promise<void> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['kind', 'databasePath', 'filesystemRootOwnerUid'].includes(key))) throw new InstallationOperatorError();
  const args = [input.kind, '--database', input.databasePath];
  if (input.filesystemRootOwnerUid !== undefined) args.push('--filesystem-root-owner-uid', String(input.filesystemRootOwnerUid));
  const command = parseInstallationUpgradeCommand(args);
  if (owners.size >= 2) throw new InstallationOperatorError();
  const owner: OperatorOwner = { quarantined: false }; owners.add(owner);
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
    await lease.withWriter(() => {
      assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
      const previousCheckpoint = FROZEN_V25_NODE_INSTALLATION_CATALOG.migrations.at(-1)?.checkpoint;
      const currentCheckpoint = OPERATIONAL_NODE_INSTALLATION_CATALOG.migrations.at(-1)?.checkpoint;
      const observed = ownedNative.prepare('SELECT schema_checkpoint FROM node_installation WHERE singleton=1').get();
      const checkpointId = observed?.schema_checkpoint;
      if (!previousCheckpoint || !currentCheckpoint
        || checkpointId !== previousCheckpoint.id && checkpointId !== currentCheckpoint.id) throw new InstallationOperatorError();
      const sourceCatalog = checkpointId === previousCheckpoint.id
        ? FROZEN_V25_NODE_INSTALLATION_CATALOG : OPERATIONAL_NODE_INSTALLATION_CATALOG;
      const before = assertInstallationAdmission(ownedNative, admitInstallationRecoverySource(ownedNative, sourceCatalog));
      installReviewedSqliteCatalog(ownedNative, OPERATIONAL_NODE_INSTALLATION_CATALOG);
      const after = assertInstallationAdmission(ownedNative, admitInstallationRecoverySource(ownedNative, OPERATIONAL_NODE_INSTALLATION_CATALOG));
      if (after.installationId !== before.installationId || after.catalogId !== before.catalogId || after.createdAt !== before.createdAt
        || after.checkpointId !== currentCheckpoint.id || after.schemaSha256 !== currentCheckpoint.schemaSha256
        || after.appliedMigrations !== OPERATIONAL_NODE_INSTALLATION_CATALOG.migrations.length) throw new InstallationOperatorError();
      assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
    });
  } catch { failed = true; }
  finally {
    if (lease) {
      try {
        await lease.stopAdmissionAndDrain();
        if (database) database.close(); else if (native?.isOpen) native.close();
        if (native?.isOpen) throw new InstallationOperatorError();
        await lease.release();
        owners.delete(owner);
      } catch (cleanupError) {
        owner.failure = cleanupError;
        // Retain the exact original owner after any failed drain/native/FD ACK.
        // Never substitute raw native close or infer success from isOpen=false.
        owner.quarantined = true; failed = true;
      }
    } else owners.delete(owner); // Acquisition quarantine belongs to the lease factory.
  }
  if (failed) throw new InstallationOperatorError();
}

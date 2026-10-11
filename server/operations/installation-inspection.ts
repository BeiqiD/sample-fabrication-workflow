import { DatabaseSync } from 'node:sqlite';
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from '../operational-installation-catalog';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations';
import { createSqliteCapability, type SqliteCapability } from '../sqlite';
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from './writer-lease';

export class InstallationInspectionError extends Error {
  constructor() { super('The offline installation inspection is unavailable.'); this.name = 'InstallationInspectionError'; }
}
export type InstallationInspectionCommand = Readonly<{
  kind: 'inspect'; databasePath: string; filesystemRootOwnerUid?: number;
}>;
export type InstallationInspectionReceipt = Readonly<{
  installationId: string; catalogId: string; checkpointId: string;
}>;
interface InspectionOwner { lease?: LinuxWriterLease; native?: DatabaseSync; database?: SqliteCapability; failure?: unknown; quarantined: boolean }
const owners = new Set<InspectionOwner>();

export function installationInspectionProcessState(): Readonly<{ activeOperations: number; quarantinedOperations: number }> {
  return Object.freeze({ activeOperations: [...owners].filter(owner => !owner.quarantined).length,
    quarantinedOperations: [...owners].filter(owner => owner.quarantined).length });
}

/** Only deployment-owned canonical database and immutable filesystem-root UID
 * inputs. No caller-selected catalog, query, actor, provider or output path. */
export function parseInstallationInspectionCommand(argv: readonly string[]): InstallationInspectionCommand {
  if (!Array.isArray(argv) || ![3, 5].includes(argv.length) || argv[0] !== 'inspect'
    || argv.some(value => typeof value !== 'string' || value.length > 4096)) throw new InstallationInspectionError();
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!, value = argv[index + 1]!;
    if (!['--database', '--filesystem-root-owner-uid'].includes(name) || fields.has(name)) throw new InstallationInspectionError();
    fields.set(name, value);
  }
  const databasePath = fields.get('--database');
  if (!databasePath || databasePath.length > 4000 || databasePath.includes('\0')) throw new InstallationInspectionError();
  const root = fields.get('--filesystem-root-owner-uid');
  if (root === undefined) return Object.freeze({ kind: 'inspect', databasePath });
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(root) || Number(root) > 0xffff_ffff) throw new InstallationInspectionError();
  return Object.freeze({ kind: 'inspect', databasePath, filesystemRootOwnerUid: Number(root) });
}

/** Stopped-writer metadata read. The original physical lease precedes native
 * open, exact current24 admission and owned core. No schema/domain/identity
 * SQL is installed or mutated. Core connection/WAL and lease bookkeeping are
 * still real filesystem work, so this is not a byte-identical database audit.
 * A receipt becomes returnable only after actual native close and lease ACK. */
export async function executeInstallationInspection(input: InstallationInspectionCommand): Promise<InstallationInspectionReceipt> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['kind', 'databasePath', 'filesystemRootOwnerUid'].includes(key))) throw new InstallationInspectionError();
  const args = [input.kind, '--database', input.databasePath];
  if (input.filesystemRootOwnerUid !== undefined) args.push('--filesystem-root-owner-uid', String(input.filesystemRootOwnerUid));
  const command = parseInstallationInspectionCommand(args);
  if (owners.size >= 2) throw new InstallationInspectionError();
  const owner: InspectionOwner = { quarantined: false }; owners.add(owner);
  let lease: LinuxWriterLease | undefined, native: DatabaseSync | undefined, database: SqliteCapability | undefined;
  let receipt: InstallationInspectionReceipt | undefined, failed = false;
  try {
    lease = await acquireLinuxWriterLease({ databasePath: command.databasePath,
      ...(command.filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid: command.filesystemRootOwnerUid }) });
    owner.lease = lease;
    native = new DatabaseSync(command.databasePath, { allowExtension: false, enableForeignKeyConstraints: true });
    owner.native = native;
    database = owner.database = createSqliteCapability(native); lease.bind(database, native);
    const ownedLease = lease, ownedNative = native, ownedDatabase = database;
    receipt = await ownedLease.withWriter(() => {
      assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
      const current = OPERATIONAL_NODE_INSTALLATION_CATALOG.migrations.at(-1)?.checkpoint;
      if (!current || current.id !== 'portable-runtime/v26' || OPERATIONAL_NODE_INSTALLATION_CATALOG.migrations.length !== 24)
        throw new InstallationInspectionError();
      const admitted = assertInstallationAdmission(ownedNative,
        admitInstallationRecoverySource(ownedNative, OPERATIONAL_NODE_INSTALLATION_CATALOG));
      if (admitted.checkpointId !== current.id || admitted.schemaSha256 !== current.schemaSha256
        || admitted.appliedMigrations !== 24) throw new InstallationInspectionError();
      assertLinuxWriterLeaseBinding(ownedLease, ownedDatabase, ownedNative);
      return Object.freeze({ installationId: admitted.installationId, catalogId: admitted.catalogId, checkpointId: admitted.checkpointId });
    });
  } catch { failed = true; }
  finally {
    if (lease) {
      try {
        await lease.stopAdmissionAndDrain();
        if (database) database.close(); else if (native?.isOpen) native.close();
        if (native?.isOpen) throw new InstallationInspectionError();
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
  if (failed || !receipt) throw new InstallationInspectionError();
  return receipt;
}

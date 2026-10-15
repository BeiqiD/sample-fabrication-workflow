import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { SYSTEM_BACKUP_MAX_ARCHIVE_BYTES } from "../../shared/contracts/system-backup";
import { restoreV28SystemBackupToIsolatedDirectoryCandidate } from "../../scripts/lib/restore-system-backup-v28-candidate";

export class OfflineV28RestoreError extends Error {
  constructor() { super("Offline V28 restoration is unavailable."); this.name = "OfflineV28RestoreError"; }
}
export interface OfflineV28RestoreCommand { readonly kind: "fixed-offline-v28-restore/1" }
interface Command { archive: string; destination: string; sha256: string; rootUid: number }
interface Identity { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: bigint }
interface FileIdentity extends Identity { size: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint }
interface Directory { path: string; identity: Identity; private: boolean }
interface Owner {
  descriptor?: number; archive?: FileIdentity; directories: Directory[];
  original?: ReturnType<typeof restoreV28SystemBackupToIsolatedDirectoryCandidate>;
  closeAttempted: boolean; closeFailed: boolean; closeFailure?: unknown; failure?: unknown;
}
const issued = new WeakMap<OfflineV28RestoreCommand, Readonly<Command>>();
const owners = new Set<Owner>();
function unavailable(): never { throw new OfflineV28RestoreError(); }
function absolute(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 4000 || value.includes("\0")
    || !isAbsolute(value) || resolve(value) !== value) unavailable();
}
function identity(stat: BigIntStats): Identity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode };
}
function fileIdentity(stat: BigIntStats): FileIdentity {
  return { ...identity(stat), size: stat.size, nlink: stat.nlink, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}
function same(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return same(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function privateFile(stat: BigIntStats, owner: bigint): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== owner || stat.nlink !== 1n
    || ![0o400n, 0o600n].includes(stat.mode & 0o7777n) || stat.size < 1n
    || stat.size > BigInt(SYSTEM_BACKUP_MAX_ARCHIVE_BYTES)) unavailable();
}
function directory(path: string, owner: bigint, rootUid: bigint, isPrivate: boolean): Identity {
  if (realpathSync(path) !== path) unavailable();
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n
    || (dirname(path) === path ? stat.uid !== rootUid : stat.uid !== owner && stat.uid !== 0n)
    || isPrivate && (stat.uid !== owner || (stat.mode & 0o7777n) !== 0o700n)) unavailable();
  return identity(stat);
}
function ancestors(path: string, owner: bigint, rootUid: bigint): Directory[] {
  const result: Directory[] = []; let current = dirname(path), isPrivate = true;
  while (true) {
    result.push({ path: current, identity: directory(current, owner, rootUid, isPrivate), private: isPrivate });
    const parent = dirname(current); if (parent === current) return result;
    current = parent; isPrivate = false;
  }
}

/** Closed arguments select only the fixed offline V5 reader and new inert V28
 * destination. The token is not an administrator, provider or startup grant. */
export function parseOfflineV28RestoreCommand(argv: readonly string[]): OfflineV28RestoreCommand {
  if (!Array.isArray(argv) || ![7, 9].includes(argv.length) || argv[0] !== "restore"
    || argv.some(value => typeof value !== "string" || value.length > 4000 || value.includes("\0"))) unavailable();
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!;
    if (!["--archive", "--destination", "--sha256", "--filesystem-root-owner-uid"].includes(name) || fields.has(name)) unavailable();
    fields.set(name, argv[index + 1]!);
  }
  const archive = fields.get("--archive"), destination = fields.get("--destination"), sha256 = fields.get("--sha256");
  absolute(archive); absolute(destination);
  if (archive === destination || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) unavailable();
  const rawRoot = fields.get("--filesystem-root-owner-uid"), rootUid = rawRoot === undefined ? 0 : Number(rawRoot);
  if (rawRoot !== undefined && !/^(?:0|[1-9][0-9]{0,9})$/.test(rawRoot)
    || !Number.isSafeInteger(rootUid) || rootUid < 0 || rootUid > 0xffff_ffff) unavailable();
  const token = Object.freeze({ kind: "fixed-offline-v28-restore/1" as const });
  issued.set(token, Object.freeze({ archive, destination, sha256, rootUid })); return token;
}

/** Existing private archive and private destination parent only. The genuine
 * reviewed restorer exclusively creates the destination; it retains failed
 * native owners and targets. It never opens an operational installation. */
export async function executeOfflineV28Restore(command: OfflineV28RestoreCommand) {
  const selected = issued.get(command);
  if (!selected || process.platform !== "linux" || typeof process.geteuid !== "function" || owners.size >= 2) unavailable();
  const ownerUid = BigInt(process.geteuid()), rootUid = BigInt(selected.rootUid);
  const owner: Owner = { directories: [], closeAttempted: false, closeFailed: false }; owners.add(owner);
  let failed = false, failure: unknown;
  const assertCurrent = () => {
    for (const pin of owner.directories) if (!same(pin.identity, directory(pin.path, ownerUid, rootUid, pin.private))) unavailable();
    if (owner.descriptor !== undefined && owner.archive) {
      const fd = fstatSync(owner.descriptor, { bigint: true }), path = lstatSync(selected.archive, { bigint: true });
      privateFile(fd, ownerUid); privateFile(path, ownerUid);
      if (realpathSync(selected.archive) !== selected.archive || !sameFile(owner.archive, fileIdentity(fd))
        || !sameFile(owner.archive, fileIdentity(path))) unavailable();
    }
  };
  const closeOriginal = () => {
    if (owner.closeAttempted) { if (owner.closeFailed) throw owner.closeFailure; return; }
    owner.closeAttempted = true;
    try { if (owner.descriptor !== undefined) closeSync(owner.descriptor); }
    catch (error) { owner.closeFailed = true; owner.closeFailure = error; throw error; }
  };
  try {
    if (realpathSync(selected.archive) !== selected.archive || !basename(selected.destination)) unavailable();
    owner.directories = [...ancestors(selected.archive, ownerUid, rootUid), ...ancestors(selected.destination, ownerUid, rootUid)];
    const before = lstatSync(selected.archive, { bigint: true }); privateFile(before, ownerUid);
    owner.archive = fileIdentity(before);
    owner.descriptor = openSync(selected.archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertCurrent();
    // There is one original constructor/restoration Promise. Its own archive
    // hash and full typed V5 admission precede the fixed fresh target schema.
    owner.original = restoreV28SystemBackupToIsolatedDirectoryCandidate({ archivePath: selected.archive,
      destination: selected.destination, expectedSha256: selected.sha256 });
    return await owner.original;
  } catch (error) { failed = true; failure = error; owner.failure = error; throw error; }
  finally {
    const errors: unknown[] = [];
    try { assertCurrent(); } catch (error) { errors.push(error); }
    try { closeOriginal(); } catch (error) { errors.push(error); }
    if (errors.length) {
      const error = new AggregateError(failed ? [failure, ...errors] : errors, "Offline V28 work and original archive closure failed");
      owner.failure = error; throw error;
    }
    if (!failed) owners.delete(owner);
    // A rejected original restore remains strongly retained. No raw Native
    // fallback, close retry, target removal or authority activation follows.
  }
}

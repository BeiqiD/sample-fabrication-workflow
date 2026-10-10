import { constants } from "node:fs";
import { chmod, link, lstat, mkdtemp, open, realpath, rm, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export interface SqliteBackupOptions {
  /** Canonical, server-owned directory on the same filesystem as publication. */
  directory: string;
  filename: string;
  /** Quiesced source and standalone destination must each fit this ceiling. */
  maxBytes: number;
  pagesPerStep?: number;
}
export interface SqliteBackupReceipt {
  path: string;
  byteLength: number;
  pageCount: number;
  pageSize: number;
  journalMode: "delete";
}
export interface SqliteCheckpointReceipt {
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
}
export class SqliteCheckpointBusyError extends Error {
  constructor(readonly checkpoint: SqliteCheckpointReceipt) {
    super("SQLite checkpoint is busy; the owned connection remains open");
    this.name = "SqliteCheckpointBusyError";
  }
}

function integer(value: unknown, description: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid SQLite ${description}`);
  }
  return value;
}
function bounded(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid ${name}`);
  return value;
}
function ownedWal(database: DatabaseSync) {
  if (!database.isOpen || database.isTransaction) throw new Error("Owned SQLite connection must be open without a transaction");
  if (database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") throw new Error("File-backed SQLite WAL is required");
}
async function syncFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Privileged maintenance only: the composer must own this DatabaseSync and
 * quiesce requests, jobs and every other writer until the Promise settles.
 * Native backup includes committed live-WAL pages without copying the main
 * file. It does not promise a snapshot fixed at call time under concurrent
 * writes: same-connection mutations are reflected and other writers can
 * restart native backup. Node's API has no AbortSignal/deadline; this helper
 * bounds pages/disk size under the required quiescence, not elapsed I/O time.
 * The directory must stay trusted and immutable to other writers throughout.
 * This is a SQLite snapshot, not a backup of file bytes/configuration/secrets.
 */
export async function backupQuiescedSqliteDatabase(database: DatabaseSync,
  options: SqliteBackupOptions): Promise<SqliteBackupReceipt> {
  ownedWal(database);
  const maxBytes = bounded(options.maxBytes, "maxBytes", 2 * 1024 * 1024 * 1024);
  const rate = bounded(options.pagesPerStep ?? 64, "pagesPerStep", 256);
  if (typeof options.filename !== "string" || options.filename !== basename(options.filename)
    || options.filename === "." || options.filename === ".." || /^[.]/.test(options.filename)
    || /[\\/\x00-\x1f\x7f]/.test(options.filename) || Buffer.byteLength(options.filename) > 200
    || !options.filename.length) throw new Error("Configure one bounded backup filename");
  const pageCount = integer(database.prepare("PRAGMA page_count").get()?.page_count, "page count", 1);
  const pageSize = integer(database.prepare("PRAGMA page_size").get()?.page_size, "page size", 1);
  if (!Number.isSafeInteger(pageCount * pageSize) || pageCount * pageSize > maxBytes) throw new Error("SQLite backup exceeds the byte ceiling");
  const directory = resolve(options.directory);
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error("Configure a canonical backup directory");
  const destination = join(directory, options.filename);
  try { await lstat(destination); throw new Error("Backup destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporaryDirectory = await mkdtemp(join(directory, ".sqlite-backup-"));
  const temporary = join(temporaryDirectory, "snapshot.sqlite");
  let published = false;
  try {
    await backup(database, temporary, { source: "main", target: "main", rate });
    await chmod(temporary, 0o600);
    const snapshot = new DatabaseSync(temporary, { allowExtension: false, enableForeignKeyConstraints: true });
    let receipt: SqliteBackupReceipt;
    try {
      // Close the private artifact's WAL before publishing a single standalone file.
      if (snapshot.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") throw new Error("Standalone SQLite backup journal is required");
      const checks = snapshot.prepare("PRAGMA quick_check").all();
      if (checks.length !== 1 || checks[0]?.quick_check !== "ok"
        || snapshot.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLite backup integrity check failed");
      const copiedPages = integer(snapshot.prepare("PRAGMA page_count").get()?.page_count, "backup page count", 1);
      const copiedSize = integer(snapshot.prepare("PRAGMA page_size").get()?.page_size, "backup page size", 1);
      const byteLength = integer((await stat(temporary)).size, "backup byte length", 1);
      if (byteLength > maxBytes || copiedPages * copiedSize !== byteLength) throw new Error("SQLite backup exceeds the byte ceiling or is incomplete");
      receipt = { path: destination, byteLength, pageCount: copiedPages, pageSize: copiedSize, journalMode: "delete" };
    } finally { snapshot.close(); }
    await syncFile(temporary);
    // A same-filesystem hard link atomically refuses any existing file/symlink.
    // rename() would overwrite a destination and is deliberately not used.
    await link(temporary, destination); published = true;
    await syncDirectory(directory);
    await rm(temporaryDirectory, { recursive: true });
    return receipt;
  } catch (error) {
    const failures: unknown[] = [error];
    if (published) {
      try { await unlink(destination); await syncDirectory(directory); }
      catch (cleanupError) { failures.push(cleanupError); }
    }
    try { await rm(temporaryDirectory, { recursive: true, force: true }); }
    catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1) throw new AggregateError(failures, "SQLite backup and cleanup failed");
    throw error;
  }
}

/** Call after the composer has quiesced every local request/job/writer.
 * A pinned reader in another connection can keep the checkpoint busy; that
 * outcome leaves this connection open and preserves its timeout for retry.
 * A successful checkpoint/close does not prove that another process stopped.
 */
export function shutdownQuiescedSqliteDatabase(database: DatabaseSync,
  options: { busyTimeoutMs?: number } = {}): SqliteCheckpointReceipt {
  ownedWal(database);
  const timeout = bounded(options.busyTimeoutMs ?? 1000, "busyTimeoutMs", 5000);
  const previous = integer(database.prepare("PRAGMA busy_timeout").get()?.timeout, "busy timeout");
  database.exec(`PRAGMA busy_timeout=${timeout}`);
  try {
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const receipt = { busy: integer(checkpoint?.busy, "checkpoint busy"),
      logFrames: integer(checkpoint?.log, "checkpoint log"),
      checkpointedFrames: integer(checkpoint?.checkpointed, "checkpoint progress") };
    if (receipt.busy !== 0 || receipt.logFrames !== receipt.checkpointedFrames) throw new SqliteCheckpointBusyError(receipt);
    database.close();
    return receipt;
  } finally {
    if (database.isOpen) database.exec(`PRAGMA busy_timeout=${previous}`);
  }
}

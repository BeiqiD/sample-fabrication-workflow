import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync,
  renameSync, writeSync, type BigIntStats } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http.ts";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate.ts";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations.ts";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config.ts";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease.ts";
import { assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite.ts";
import type { NodeV28JobFamily, NodeV28SchedulerCursor } from "./node-v28-job-scheduler.ts";

export interface NodeV28JobCursorOwner { readonly kind: "node-v28-owned-job-cursor/1"; close(): Promise<void> }
export interface NodeV28ReservedJobSlot { readonly kind: "node-v28-reserved-job-slot/1" }
interface FileOwner { readonly fd: number; close?: Promise<void> }
interface Pin { readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly gid: bigint; readonly mode: bigint }
interface FilePin extends Pin { readonly nlink: bigint; readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint }
interface Receipt extends NodeV28SchedulerCursor {
  readonly schema: "node-v28-workflow-job-cursor/1";
  readonly installation: Readonly<{ id: string; catalogId: string; checkpointId: string; schemaSha256: string; createdAt: string }>;
  readonly sequence: number;
  readonly reservation: Readonly<{ id: string; family: NodeV28JobFamily }> | null;
}
interface CursorBinding {
  readonly database: SqliteCapability; readonly nativeDatabase: DatabaseSync;
  readonly writerLease: LinuxWriterLease; readonly authentication: object;
  assertCurrent(): void;
  cursor(): Readonly<NodeV28SchedulerCursor>;
  reserve(family: NodeV28JobFamily): Promise<NodeV28ReservedJobSlot>;
  complete(slot: NodeV28ReservedJobSlot, consumed: boolean): Promise<Readonly<NodeV28SchedulerCursor>>;
}
const issued = new WeakMap<NodeV28JobCursorOwner, Readonly<CursorBinding>>();
const claimed = new WeakMap<DatabaseSync, object>(), retained = new Set<object>();
const families: readonly NodeV28JobFamily[] = Object.freeze(["file", "package", "recovery"]);
const FILE_NAME = ".node-v28-workflow-job-cursor.json", MAX_BYTES = 4096;
const unavailable = () => new Error("Original private V28 scheduler receipt is unavailable");
function pin(stat: BigIntStats): Pin { return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode }; }
function filePin(stat: BigIntStats): FilePin {
  return { ...pin(stat), nlink: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}
function same(left: Pin, right: Pin): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}
function sameFile(left: FilePin, right: FilePin): boolean {
  return same(left, right) && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function privateFile(stat: BigIntStats, uid: bigint): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n
    || stat.size < 1n || stat.size > BigInt(MAX_BYTES)) throw unavailable();
}
function missing(path: string): boolean {
  try { lstatSync(path, { bigint: true }); return false; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true; throw error; }
}
function encode(receipt: Receipt): Buffer { return Buffer.from(JSON.stringify(receipt) + "\n", "utf8"); }

/** Scheduler-only private receipt. The genuine config owns the private data
 * directory and code owns both filenames. No schema migration or job grant is
 * written. A reservation is durably acknowledged BEFORE its original action;
 * completion follows the original action AND first cleanup ACK. A restarted
 * reservation skips that uncertain slot. An orphan pending/malformed receipt
 * refuses startup; it is never overwritten, retried or interpreted as replay. */
export async function openNodeV28JobCursor(options: {
  configuration: LoadedNodeRuntimeConfiguration; database: SqliteCapability; nativeDatabase: DatabaseSync;
  admission: ReviewedInstallationAdmission; writerLease: LinuxWriterLease; authentication: object;
  quarantine(error: unknown): void;
}): Promise<NodeV28JobCursorOwner> {
  const captured = Object.freeze({ ...options });
  const { configuration, database, nativeDatabase, admission, writerLease, authentication } = captured;
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const config = assertNodeRuntimeConfiguration(configuration);
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity, database, nativeDatabase, admission);
  const installation = assertInstallationAdmission(nativeDatabase, admission);
  const main = nativeDatabase.prepare("PRAGMA database_list").all().filter(row => row.name === "main");
  if (!config.enableLocalFile || !config.enableLocalJobs || !config.enableLocalRecovery
    || installation.installationId !== config.expectedInstallationId || installation.checkpointId !== "portable-runtime/v28"
    || main.length !== 1 || main[0]?.file !== config.databasePath
    || claimed.has(nativeDatabase) || typeof process.geteuid !== "function") throw unavailable();
  const uid = BigInt(process.geteuid()), directory = config.dataDirectory;
  const path = join(directory, FILE_NAME), pendingPath = path + ".pending";
  const binding = Object.freeze({ id: installation.installationId, catalogId: installation.catalogId,
    checkpointId: installation.checkpointId, schemaSha256: installation.schemaSha256, createdAt: installation.createdAt });
  let phase: "opening" | "open" | "stopping" | "closed" | "quarantined" = "opening";
  let failed = false, failure: unknown, closing: Promise<void> | undefined;
  let directoryOwner: FileOwner | undefined, directoryPin: Pin | undefined;
  let currentFile: FileOwner | undefined, currentPin: FilePin | undefined, current: Receipt | undefined;
  let reserved: NodeV28ReservedJobSlot | undefined;
  const descriptors = new Set<FileOwner>();
  const slots = new WeakMap<NodeV28ReservedJobSlot, { receipt: Receipt; consumed?: boolean; completion?: Promise<Readonly<NodeV28SchedulerCursor>> }>();
  const operations = new Set<Promise<unknown>>();
  const state = { captured, descriptors }; retained.add(state); claimed.set(nativeDatabase, state);
  function quarantine(error: unknown): void {
    if (failed) return; failed = true; failure = error; phase = "quarantined";
    try { captured.quarantine(error); }
    catch (notificationError) { failure = new AggregateError([error, notificationError], "V28 cursor quarantine notification failed"); }
  }
  function physical(): void {
    if (failed) throw failure;
    if (phase === "closed" || assertNodeRuntimeConfiguration(configuration) !== config) throw unavailable();
    assertSqliteConnectionOwner(database, nativeDatabase); assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    identity.assertCurrent(); if (localAuthenticationIdentityAuthority(authentication) !== auth) throw unavailable();
    if (resolve(directory) !== directory || realpathSync(directory) !== directory) throw unavailable();
    const actual = lstatSync(directory, { bigint: true });
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.uid !== uid || (actual.mode & 0o7777n) !== 0o700n
      || directoryPin && !same(directoryPin, pin(actual))) throw unavailable();
    if (directoryOwner && !same(pin(actual), pin(fstatSync(directoryOwner.fd, { bigint: true })))) throw unavailable();
  }
  function readFile(owner: FileOwner, filePath: string): Readonly<{ bytes: Buffer; pin: FilePin }> {
    physical(); const before = fstatSync(owner.fd, { bigint: true }), named = lstatSync(filePath, { bigint: true });
    privateFile(before, uid); privateFile(named, uid);
    const expected = filePin(before); if (!sameFile(expected, filePin(named))) throw unavailable();
    const bytes = Buffer.alloc(Number(before.size)); let length = 0;
    while (length < bytes.length) {
      const count = readSync(owner.fd, bytes, length, bytes.length - length, length); if (count < 1) throw unavailable(); length += count;
    }
    const extra = Buffer.alloc(1); if (readSync(owner.fd, extra, 0, 1, length) !== 0) throw unavailable();
    const after = fstatSync(owner.fd, { bigint: true }), afterPath = lstatSync(filePath, { bigint: true });
    privateFile(after, uid); privateFile(afterPath, uid);
    if (!sameFile(expected, filePin(after)) || !sameFile(expected, filePin(afterPath))) throw unavailable();
    return Object.freeze({ bytes, pin: expected });
  }
  function assertReceipt(): void {
    physical(); if (!currentFile || !currentPin || !current) throw unavailable();
    const read = readFile(currentFile, path);
    if (!sameFile(currentPin, read.pin) || !read.bytes.equals(encode(current))) throw unavailable();
  }
  function decode(bytes: Buffer): Receipt {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as Receipt;
    if (!value || value.schema !== "node-v28-workflow-job-cursor/1" || !value.installation
      || JSON.stringify(value.installation) !== JSON.stringify(binding) || !families.includes(value.nextFamily)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isSafeInteger(value.consumedSlots)
      || value.consumedSlots < 0 || value.consumedSlots > value.sequence
      || !(value.reservation === null || value.reservation && families.includes(value.reservation.family)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.reservation.id))
      || !bytes.equals(encode(value))) throw unavailable();
    if (Object.keys(value).join(",") !== "schema,installation,sequence,nextFamily,consumedSlots,reservation"
      || value.reservation && Object.keys(value.reservation).join(",") !== "id,family") throw unavailable();
    return Object.freeze({ ...value, installation: binding,
      reservation: value.reservation && Object.freeze({ ...value.reservation }) });
  }
  function closeDescriptor(owner: FileOwner): Promise<void> {
    if (owner.close) return owner.close;
    owner.close = Promise.resolve().then(() => { closeSync(owner.fd); descriptors.delete(owner); })
      .catch(error => { quarantine(error); throw error; });
    void owner.close.catch(() => undefined); return owner.close;
  }
  async function publish(next: Receipt): Promise<void> {
    physical(); if (current) assertReceipt();
    if (!missing(pendingPath)) throw unavailable();
    const bytes = encode(next); if (bytes.length < 1 || bytes.length > MAX_BYTES) throw unavailable();
    const owner: FileOwner = { fd: openSync(pendingPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600) }; descriptors.add(owner);
    let length = 0;
    while (length < bytes.length) {
      const count = writeSync(owner.fd, bytes, length, bytes.length - length, length); if (count < 1) throw unavailable(); length += count;
    }
    fsyncSync(owner.fd);
    const written = readFile(owner, pendingPath); if (!written.bytes.equals(bytes)) throw unavailable();
    physical(); if (current) assertReceipt(); else if (!missing(path)) throw unavailable();
    renameSync(pendingPath, path); fsyncSync(directoryOwner!.fd);
    const committed = readFile(owner, path);
    // The owned rename may change inode ctime. All immutable identity fields,
    // nlink, bytes and mtime remain exact; readFile pins the new ctime itself.
    if (!committed.bytes.equals(bytes) || !same(written.pin, committed.pin)
      || written.pin.nlink !== committed.pin.nlink || written.pin.size !== committed.pin.size
      || written.pin.mtimeNs !== committed.pin.mtimeNs || !missing(pendingPath)) throw unavailable();
    const previous = currentFile; currentFile = owner; currentPin = committed.pin; current = next;
    physical(); if (previous) await closeDescriptor(previous);
  }
  function cursor(): Readonly<NodeV28SchedulerCursor> {
    assertReceipt(); if (current!.reservation !== null) throw unavailable();
    return Object.freeze({ nextFamily: current!.nextFamily, consumedSlots: current!.consumedSlots });
  }
  function reserve(family: NodeV28JobFamily): Promise<NodeV28ReservedJobSlot> {
    if (phase !== "open" || reserved || !families.includes(family)) return Promise.reject(failed ? failure : unavailable());
    const token: NodeV28ReservedJobSlot = Object.freeze({ kind: "node-v28-reserved-job-slot/1" }); reserved = token;
    const original = Promise.resolve().then(() => writerLease.withWriter(async () => {
      assertReceipt(); if (current!.reservation !== null || current!.sequence > Number.MAX_SAFE_INTEGER - 2
        || current!.consumedSlots >= Number.MAX_SAFE_INTEGER) throw unavailable();
      const receipt: Receipt = Object.freeze({ ...current!, sequence: current!.sequence + 1,
        reservation: Object.freeze({ id: randomUUID(), family }) });
      slots.set(token, { receipt }); await publish(receipt); return token;
    })).catch(error => { quarantine(error); throw error; });
    operations.add(original); void original.then(() => operations.delete(original), () => undefined);
    void original.catch(() => undefined); return original;
  }
  function complete(slot: NodeV28ReservedJobSlot, consumed: boolean): Promise<Readonly<NodeV28SchedulerCursor>> {
    const accepted = slots.get(slot);
    if (!accepted || typeof consumed !== "boolean") return Promise.reject(unavailable());
    if (accepted.completion) return accepted.consumed === consumed ? accepted.completion : Promise.reject(unavailable());
    if (closing) return Promise.reject(failed ? failure : unavailable());
    accepted.consumed = consumed;
    accepted.completion = Promise.resolve().then(() => writerLease.withWriter(async () => {
      if (phase !== "open" && phase !== "stopping" || reserved !== slot) throw failed ? failure : unavailable();
      assertReceipt(); const receipt = current;
      if (!receipt || receipt !== accepted.receipt || receipt.sequence >= Number.MAX_SAFE_INTEGER) throw unavailable();
      const selected = families.indexOf(receipt.reservation!.family);
      await publish(Object.freeze({ ...receipt, sequence: receipt.sequence + 1,
        nextFamily: consumed ? families[(selected + 1) % families.length]! : receipt.nextFamily,
        consumedSlots: receipt.consumedSlots + (consumed ? 1 : 0), reservation: null }));
      reserved = undefined; return cursor();
    })).catch(error => { quarantine(error); throw error; });
    operations.add(accepted.completion); void accepted.completion.then(() => operations.delete(accepted.completion!), () => undefined);
    void accepted.completion.catch(() => undefined); return accepted.completion;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    if (phase === "open") phase = "stopping";
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...operations]);
      if (failed) throw failure;
      assertReceipt();
      const results = await Promise.allSettled([...descriptors].filter(owner => owner !== directoryOwner).map(closeDescriptor));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (failed || errors.length) throw failed ? failure : new AggregateError(errors, "Original V28 cursor files did not close");
      await closeDescriptor(directoryOwner!); phase = "closed"; retained.delete(state);
      if (claimed.get(nativeDatabase) === state) claimed.delete(nativeDatabase);
    }).catch(error => { quarantine(error); throw error; });
    void closing.catch(() => undefined); return closing;
  }
  try {
    await writerLease.withWriter(async () => {
      physical(); const named = lstatSync(directory, { bigint: true }); directoryPin = pin(named);
      directoryOwner = { fd: openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK) };
      descriptors.add(directoryOwner); physical();
      if (!missing(pendingPath)) throw unavailable();
      if (missing(path)) {
        await publish(Object.freeze({ schema: "node-v28-workflow-job-cursor/1", installation: binding,
          sequence: 0, nextFamily: "file", consumedSlots: 0, reservation: null }));
      } else {
        currentFile = { fd: openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK) }; descriptors.add(currentFile);
        const read = readFile(currentFile, path); currentPin = read.pin; current = decode(read.bytes); assertReceipt();
        if (current.reservation) {
          // Crash after reservation ACK may have executed its action. Advance
          // exactly once; never invoke the original reserved action on restart.
          if (current.sequence >= Number.MAX_SAFE_INTEGER || current.consumedSlots >= Number.MAX_SAFE_INTEGER) throw unavailable();
          const selected = families.indexOf(current.reservation.family);
          await publish(Object.freeze({ ...current, sequence: current.sequence + 1,
            nextFamily: families[(selected + 1) % families.length]!, consumedSlots: current.consumedSlots + 1, reservation: null }));
        }
      }
      phase = "open"; cursor();
    });
    const owner: NodeV28JobCursorOwner = Object.freeze({ kind: "node-v28-owned-job-cursor/1", close });
    issued.set(owner, Object.freeze({ database, nativeDatabase, writerLease, authentication,
      assertCurrent() { if (phase !== "open") throw failed ? failure : unavailable(); assertReceipt(); }, cursor, reserve, complete }));
    return owner;
  } catch (error) { quarantine(error); throw error; }
}

/** Only the original same-parent cursor can reserve/complete scheduled work.
 * Serialized receipt contents supply order, never actor or job authority. */
export function ownedNodeV28JobCursor(owner: NodeV28JobCursorOwner, database: SqliteCapability,
  nativeDatabase: DatabaseSync, writerLease: LinuxWriterLease, authentication: object): Readonly<CursorBinding> {
  const current = issued.get(owner);
  if (!current || current.database !== database || current.nativeDatabase !== nativeDatabase
    || current.writerLease !== writerLease || current.authentication !== authentication) throw unavailable();
  current.assertCurrent(); return current;
}

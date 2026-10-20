import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FileJobExecutionDrainError, requiresFileJobExecutionQuarantine } from "../../../worker/files/jobs/execution-lifetime";
import type { FileJobCapabilities } from "../../../worker/files/jobs/types";
import { acquireLinuxWriterLease } from "../../operations/writer-lease";
import { SqliteCheckpointBusyError } from "../../sqlite-backup";
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from "../../operational-installation-catalog";
import { createInstalledNodeFileJobHost, NodeFileJobHostDrainError, type InstalledNodeFileJobHost } from "./host";
import { actor, bytes, incarnation, createPrincipalTemplate, principalFixture, retainOriginalPrincipalOperation, settleOriginalPrincipalOperations, drainOriginalPrincipalOwners, closePrincipalTemplates, openPrincipalFixtureInspection } from "./principal-test-support";

// SOURCE ONLY UNRUN on fixed operational V26. Real native/lease/disk owners; no returned fake transport.
let template: Awaited<ReturnType<typeof createPrincipalTemplate>>;
type Fixture = Awaited<ReturnType<typeof principalFixture>>;
interface OwnedCase { fixture: Fixture; host?: InstalledNodeFileJobHost; expectedCloseError?: NodeFileJobHostDrainError }
const ownedCases: OwnedCase[] = [];
beforeAll(() => retainOriginalPrincipalOperation(async () => { template = await createPrincipalTemplate(); }));
afterEach(async () => {
  await settleOriginalPrincipalOperations();
  for (const owned of [...ownedCases].reverse()) {
    if (owned.host) {
      try { await owned.host.stopAdmissionAndClose(); }
      catch (error) {
        // Only an explicit negative control with independently proven original
        // disk/reader closure permits manual test-host repair. Unexpected close
        // failure keeps all native/physical lease/template owners retained.
        if (error !== owned.expectedCloseError) throw error;
      }
    }
    await owned.fixture.close(); ownedCases.splice(ownedCases.indexOf(owned), 1);
  }
  await drainOriginalPrincipalOwners();
});
afterAll(async () => {
  await settleOriginalPrincipalOperations();
  if (ownedCases.length) throw new Error("Retained installed Node Job host owners have not closed");
  await drainOriginalPrincipalOwners(); await closePrincipalTemplates();
});
async function fixture() {
  const f = await principalFixture(template), owned: OwnedCase = { fixture: f };
  ownedCases.push(owned); return { f, owned };
}
function host(f: Fixture, owned: OwnedCase, openStorage?: FileJobCapabilities["openStorage"]) {
  const result = createInstalledNodeFileJobHost({ authority: f.authority, writerLease: f.lease, incarnation,
    ...(openStorage ? { openStorage } : {}) });
  owned.host = result; return result;
}
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function acquire(f: Fixture) {
  return acquireLinuxWriterLease({ databasePath: f.path,
    filesystemRootOwnerUid: f.filesystemRootOwnerUid });
}
async function assertPhysicalLockHeld(f: Fixture) {
  let rejected: unknown;
  try { const unexpected = await acquire(f); await unexpected.release(); }
  catch (error) { rejected = error; }
  expect(rejected).toMatchObject({ code: "busy" });
}
async function assertPhysicalLockReleased(f: Fixture) {
  const actual = await acquire(f);
  try { actual.assertHeld(); } finally { await actual.release(); }
}

describe("actual installed Node Job host ordered shutdown", () => {
  it("closes only after genuine unavailable-provider settlement, real quiesced native shutdown and physical lease release, preserving durable Job and File state", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(), accepted = await f.original.accept(f.input, actor);
    const catalog = OPERATIONAL_NODE_INSTALLATION_CATALOG, checkpoint = catalog.migrations.at(-1)?.checkpoint;
    expect(catalog.migrations).toHaveLength(24);
    expect(checkpoint?.id).toBe("portable-runtime/v26");
    expect(f.admission.receipt).toMatchObject({ catalogId: catalog.id, checkpointId: checkpoint?.id,
      schemaSha256: checkpoint?.schemaSha256, appliedMigrations: 24 });
    expect(f.native.prepare("SELECT catalog_id,schema_checkpoint,schema_sha256 FROM node_installation WHERE singleton=1").get())
      .toMatchObject({ catalog_id: catalog.id, schema_checkpoint: checkpoint?.id, schema_sha256: checkpoint?.schemaSha256 });
    const current = host(f, owned);
    expect(() => createInstalledNodeFileJobHost({ authority: f.authority, writerLease: f.lease, incarnation })).toThrow("already owned");
    expect(await current.dispatchOnce()).toEqual({ jobId: accepted.id, outcome: "paused" });
    const closing = current.stopAdmissionAndClose(); expect(current.stopAdmissionAndClose()).toBe(closing);
    await expect(current.dispatchOnce()).rejects.toThrow("closed");
    const receipt = await closing;
    expect(receipt).toMatchObject({ nativeClosed: true, writerLeaseReleased: true, checkpoint: { busy: 0 } });
    expect(receipt.checkpoint.logFrames).toBe(receipt.checkpoint.checkpointedFrames);
    expect(f.native.isOpen).toBe(false); expect(() => f.core.prepare("SELECT 1")).toThrow();
    expect(f.authority.authorizeAdministrator(actor)).toBe(false);
    await assertPhysicalLockReleased(f);
    const reopened = openPrincipalFixtureInspection(f.path);
    try {
      expect(reopened.prepare("SELECT state,reason FROM file_migration_jobs WHERE id=?").get(accepted.id))
        .toMatchObject({ state: "paused", reason: "verification_or_storage_unavailable" });
      expect(reopened.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()?.active_location_id).toBe("source-location");
      expect(reopened.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
      expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { reopened.close(); }
  }));

  it("keeps the original real disk operation, actual native owner and kernel lock alive during drain while immediately closing every new host and lease admission", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(), accepted = await f.original.accept(f.input, actor);
    const entered = gate(), release = gate(), path = join(f.directory, "actual-host-original-open.bin");
    let originalHandle: FileHandle | undefined;
    const current = host(f, owned, async () => {
      originalHandle = await open(path, "wx", 0o600);
      try { await originalHandle.writeFile(bytes); await originalHandle.sync(); entered.release(); await release.promise; }
      finally { await originalHandle.close(); }
      throw new Error("Original disk work has no composed provider");
    });
    const pending = current.dispatchOnce(); let closing: ReturnType<typeof current.stopAdmissionAndClose> | undefined;
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Original work did not reach its gate"); })]);
      let closed = false; closing = current.stopAdmissionAndClose(); void closing.then(() => { closed = true; }, () => undefined);
      expect(current.stopAdmissionAndClose()).toBe(closing);
      await expect(current.dispatchOnce()).rejects.toThrow("closed");
      await expect(f.lease.withWriter(() => undefined)).rejects.toMatchObject({ code: "closed" });
      await Promise.resolve(); expect(closed).toBe(false); expect(f.native.isOpen).toBe(true); f.lease.assertHeld();
      expect(await readFile(path)).toEqual(Buffer.from(bytes)); await assertPhysicalLockHeld(f);
      release.release(); expect(await pending).toEqual({ jobId: accepted.id, outcome: "paused" });
      expect(await closing).toMatchObject({ nativeClosed: true, writerLeaseReleased: true });
      if (!originalHandle) throw new Error("Missing actual original disk owner");
      await expect(originalHandle.stat()).rejects.toThrow();
      expect(f.native.isOpen).toBe(false); expect(closed).toBe(true); await assertPhysicalLockReleased(f);
    } finally { release.release(); await pending; if (closing) await closing; }
  }));

  it("quarantines a typed unproven original close with native and real physical lease still held, closed ingress and no automatic disposal or native-close retry", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(); await f.original.accept(f.input, actor);
    const path = join(f.directory, "actual-host-unproven-close.bin"); let handle: FileHandle | undefined, closes = 0;
    const current = host(f, owned, async () => {
      handle = await open(path, "wx", 0o600); await handle.writeFile(bytes); await handle.sync();
      await handle.close(); closes++;
      throw new FileJobExecutionDrainError([new Error("Original close acknowledgement is unproven")], [handle]);
    });
    let failure: unknown;
    try { await current.dispatchOnce(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(NodeFileJobHostDrainError);
    if (!(failure instanceof NodeFileJobHostDrainError)) throw new Error("Missing typed host quarantine");
    expect(requiresFileJobExecutionQuarantine(failure)).toBe(true);
    expect(failure.retainedOwners).toContain(f.native); expect(failure.retainedOwners).toContain(f.core); expect(failure.retainedOwners).toContain(f.lease);
    const closing = current.stopAdmissionAndClose(); expect(current.stopAdmissionAndClose()).toBe(closing);
    await expect(closing).rejects.toBe(failure); await expect(current.dispatchOnce()).rejects.toBe(failure);
    expect(() => createInstalledNodeFileJobHost({ authority: f.authority, writerLease: f.lease, incarnation })).toThrow("already owned");
    await expect(f.lease.withWriter(() => undefined)).rejects.toMatchObject({ code: "closed" });
    expect(f.native.isOpen).toBe(true); expect(f.authority.authorizeAdministrator(actor)).toBe(true); f.lease.assertHeld();
    await assertPhysicalLockHeld(f); expect(closes).toBe(1);
    if (!handle) throw new Error("Missing actual known-closed disk handle");
    await expect(handle.stat()).rejects.toThrow();
    // Only this explicit control's real known close allows test-host repair.
    // Production host stays quarantined; its closing promise never succeeds.
    owned.expectedCloseError = failure;
  }));

  it("keeps actual native and physical ownership after a genuine second-reader busy checkpoint and refuses an automatic close retry even after the reader rolls back", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(), current = host(f, owned);
    f.second.exec("BEGIN"); f.second.prepare("SELECT principal_id FROM local_accounts").all();
    try {
      expect(await current.dispatchOnce()).toEqual({ jobId: null, outcome: "idle" });
      let failure: unknown;
      try { await current.stopAdmissionAndClose(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(NodeFileJobHostDrainError);
      if (!(failure instanceof NodeFileJobHostDrainError)) throw new Error("Missing real busy-checkpoint quarantine");
      expect(failure.errors[0]).toBeInstanceOf(SqliteCheckpointBusyError);
      expect(f.native.isOpen).toBe(true); f.lease.assertHeld(); await assertPhysicalLockHeld(f);
      await expect(current.dispatchOnce()).rejects.toBe(failure);
      f.second.exec("ROLLBACK"); // Independently close this actual reader owner.
      await expect(current.stopAdmissionAndClose()).rejects.toBe(failure);
      expect(f.native.isOpen).toBe(true); await assertPhysicalLockHeld(f);
      expect(() => createInstalledNodeFileJobHost({ authority: f.authority, writerLease: f.lease, incarnation })).toThrow("already owned");
      owned.expectedCloseError = failure;
    } finally { if (f.second.isTransaction) f.second.exec("ROLLBACK"); }
  }));
});

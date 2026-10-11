import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FileJobExecutionDrainError, requiresFileJobExecutionQuarantine } from "../../../worker/files/jobs/execution-lifetime";
import type { FileJobCapabilities } from "../../../worker/files/jobs/types";
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from "../../operational-installation-catalog";
import { createInstalledNodeFileJobDispatcher, NodeFileJobDispatcherDrainError,
  type InstalledNodeFileJobDispatcher } from "./dispatcher";
import { actor, bytes, incarnation, createPrincipalTemplate, principalFixture, retainOriginalPrincipalOperation, settleOriginalPrincipalOperations, drainOriginalPrincipalOwners, closePrincipalTemplates } from "./principal-test-support";

// SOURCE ONLY UNRUN on fixed operational V26. Real SQLite/kernel lease and original disk work;
// no structural JobBoundStorage is relabelled as a local/R2 provider.
let template: Awaited<ReturnType<typeof createPrincipalTemplate>>;
type Fixture = Awaited<ReturnType<typeof principalFixture>>;
interface OwnedCase { fixture: Fixture; dispatcher?: InstalledNodeFileJobDispatcher; expectedDrainError?: NodeFileJobDispatcherDrainError }
const ownedCases: OwnedCase[] = [];
beforeAll(() => retainOriginalPrincipalOperation(async () => { template = await createPrincipalTemplate(); }));
afterEach(async () => {
  await settleOriginalPrincipalOperations();
  for (const owned of [...ownedCases].reverse()) {
    if (owned.dispatcher) {
      try { await owned.dispatcher.stopAdmissionAndDrain(); }
      catch (error) {
        // Only the explicit completed-but-unproven disk-close control below
        // permits test-host cleanup. An unexpected ownership failure retains
        // its native/lease/template owners and refuses optimistic release.
        if (error !== owned.expectedDrainError) throw error;
      }
    }
    await owned.fixture.close();
    ownedCases.splice(ownedCases.indexOf(owned), 1);
  }
  await drainOriginalPrincipalOwners();
});
afterAll(async () => {
  await settleOriginalPrincipalOperations();
  if (ownedCases.length) throw new Error("Retained Node dispatcher fixture owners have not closed");
  await drainOriginalPrincipalOwners(); await closePrincipalTemplates();
});
async function fixture() {
  const f = await principalFixture(template), owned: OwnedCase = { fixture: f };
  ownedCases.push(owned); return { f, owned };
}
function dispatcher(f: Fixture, owned: OwnedCase, openStorage?: FileJobCapabilities["openStorage"]) {
  const result = createInstalledNodeFileJobDispatcher({ authority: f.authority, writerLease: f.lease, incarnation,
    ...(openStorage ? { openStorage } : {}) });
  owned.dispatcher = result; return result;
}
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

describe("actual installed Node one-slot Job dispatcher lifetime", () => {
  it("requires original issued authority and genuine bound lease and admits only one owner per actual native installation", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture();
    const catalog = OPERATIONAL_NODE_INSTALLATION_CATALOG, checkpoint = catalog.migrations.at(-1)?.checkpoint;
    expect(catalog.migrations).toHaveLength(24);
    expect(checkpoint?.id).toBe("portable-runtime/v26");
    expect(f.admission.receipt).toMatchObject({ catalogId: catalog.id, checkpointId: checkpoint?.id,
      schemaSha256: checkpoint?.schemaSha256, appliedMigrations: 24 });
    expect(f.native.prepare("SELECT catalog_id,schema_checkpoint,schema_sha256 FROM node_installation WHERE singleton=1").get())
      .toMatchObject({ catalog_id: catalog.id, schema_checkpoint: checkpoint?.id, schema_sha256: checkpoint?.schemaSha256 });
    const options = { authority: f.authority, writerLease: f.lease, incarnation };
    expect(() => createInstalledNodeFileJobDispatcher({ ...options, authority: { ...f.authority } })).toThrow("unavailable");
    expect(() => createInstalledNodeFileJobDispatcher({ ...options, writerLease: { ...f.lease } })).toThrow();
    const other = await fixture();
    expect(() => createInstalledNodeFileJobDispatcher({ ...options, writerLease: other.f.lease })).toThrow();
    dispatcher(f, owned);
    expect(() => createInstalledNodeFileJobDispatcher(options)).toThrow("already owned");
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_jobs").get()?.n).toBe(0);
  }));

  it("runs one real idle kernel without opening storage or enabling, reconfiguring or replaying the installed executor", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(); let opened = 0;
    const before = f.native.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard WHERE singleton=1").get();
    const current = dispatcher(f, owned, async () => { opened++; throw new Error("Unexpected storage opening"); });
    expect(await current.dispatchOnce()).toEqual({ jobId: null, outcome: "idle" });
    // A later explicit slot receives a fresh execution-registry identity.
    expect(await current.dispatchOnce()).toEqual({ jobId: null, outcome: "idle" });
    expect(opened).toBe(0);
    expect(f.native.prepare("SELECT enabled,incarnation FROM file_job_runtime_guard WHERE singleton=1").get()).toEqual(before);
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_jobs").get()?.n).toBe(0);
    expect(f.native.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()?.active_location_id).toBe("source-location");
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }));

  it("refuses historical Worker actor grants through the mature claim before any byte opening or migration attempt", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(); let opened = 0;
    const accepted = await f.original.accept(f.input, "Historical.Admin@example.test");
    const current = dispatcher(f, owned, async () => { opened++; throw new Error("Unexpected storage opening"); });
    expect(await current.dispatchOnce()).toEqual({ jobId: null, outcome: "idle" });
    expect(opened).toBe(0);
    expect(await f.port.repository.status(accepted.id)).toMatchObject({ state: "paused", reason: "administrator_revoked" });
    expect(f.native.prepare("SELECT actor FROM file_migration_jobs WHERE id=?").get(accepted.id)?.actor).toBe("Historical.Admin@example.test");
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
  }));

  it("records the genuine uncomposed-provider negative outcome without creating a transport, attempt or File publication", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(); const accepted = await f.original.accept(f.input, actor);
    const current = dispatcher(f, owned);
    expect(await current.dispatchOnce()).toEqual({ jobId: accepted.id, outcome: "paused" });
    expect(await f.port.repository.status(accepted.id)).toMatchObject({ state: "paused", reason: "verification_or_storage_unavailable" });
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
    expect(f.native.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()?.active_location_id).toBe("source-location");
    expect(f.native.prepare("SELECT count(*) n FROM file_location_publications").get()?.n).toBe(1);
    expect(f.native.isTransaction).toBe(false);
  }));

  it("refuses overlapping/new slots and keeps the actual original disk operation plus kernel inside the genuine lease until stop and drain settle", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(); const accepted = await f.original.accept(f.input, actor);
    const entered = gate(), release = gate(), path = join(f.directory, "actual-original-dispatch-open.bin");
    let originalHandle: FileHandle | undefined, acknowledgement = false;
    const current = dispatcher(f, owned, async () => {
      originalHandle = await open(path, "wx", 0o600);
      try { await originalHandle.writeFile(bytes); await originalHandle.sync(); entered.release(); await release.promise; }
      finally { await originalHandle.close(); }
      // This is genuine original disk work followed by unavailable opening;
      // it never returns a fabricated r2/local JobBoundStorage descriptor.
      throw new Error("Controlled original disk opening has no composed transport");
    });
    const pending = current.dispatchOnce(); void pending.then(() => { acknowledgement = true; }, () => undefined);
    let physicalDrain: Promise<void> | undefined;
    try {
      await entered.promise;
      await expect(current.dispatchOnce()).rejects.toThrow("busy");
      const stopping = current.stopAdmissionAndDrain(); expect(current.stopAdmissionAndDrain()).toBe(stopping);
      await expect(current.dispatchOnce()).rejects.toThrow("closed");
      let logicalDrained = false, physicalDrained = false;
      void stopping.then(() => { logicalDrained = true; });
      physicalDrain = f.lease.stopAdmissionAndDrain().then(() => { physicalDrained = true; });
      await Promise.resolve(); expect(logicalDrained).toBe(false); expect(physicalDrained).toBe(false); expect(acknowledgement).toBe(false);
      expect(f.native.isOpen).toBe(true); expect(await readFile(path)).toEqual(Buffer.from(bytes));
      release.release(); expect(await pending).toEqual({ jobId: accepted.id, outcome: "paused" });
      await stopping; await physicalDrain;
      if (!originalHandle) throw new Error("Original real disk handle was not opened");
      await expect(originalHandle.stat()).rejects.toThrow();
      expect(acknowledgement).toBe(true); expect(logicalDrained).toBe(true); expect(physicalDrained).toBe(true);
      expect(f.native.isOpen).toBe(true); // This dispatcher does not close another host's SQL.
    } finally { release.release(); await pending; if (physicalDrain) await physicalDrain; }
  }));

  it("retains typed quarantine after an actual completed but unproven disk close without retrying disposal, releasing native owners or manufacturing byte settlement", () => retainOriginalPrincipalOperation(async () => {
    const { f, owned } = await fixture(); const accepted = await f.original.accept(f.input, actor);
    const path = join(f.directory, "actual-unproven-original-close.bin"); let originalHandle: FileHandle | undefined, closes = 0;
    const cause = new Error("Original disk close acknowledgement is unproven");
    const current = dispatcher(f, owned, async () => {
      originalHandle = await open(path, "wx", 0o600);
      await originalHandle.writeFile(bytes); await originalHandle.sync();
      await originalHandle.close(); closes++;
      // The actual handle closed, but the trusted opener cannot supply a
      // successful close receipt. Keep its original typed ownership failure.
      throw new FileJobExecutionDrainError([cause], [originalHandle]);
    });
    let failure: unknown;
    try { await current.dispatchOnce(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(NodeFileJobDispatcherDrainError);
    if (!(failure instanceof NodeFileJobDispatcherDrainError)) throw new Error("Missing typed actual dispatcher quarantine");
    expect(requiresFileJobExecutionQuarantine(failure)).toBe(true);
    expect(failure.retainedOwners).toContain(f.core); expect(failure.retainedOwners).toContain(f.native); expect(failure.retainedOwners).toContain(f.lease);
    const stopped = current.stopAdmissionAndDrain(); expect(current.stopAdmissionAndDrain()).toBe(stopped);
    await expect(stopped).rejects.toBe(failure); await expect(current.dispatchOnce()).rejects.toBe(failure);
    expect(() => createInstalledNodeFileJobDispatcher({ authority: f.authority, writerLease: f.lease, incarnation })).toThrow("already owned");
    expect(closes).toBe(1); expect(f.native.isOpen).toBe(true);
    expect(await f.port.repository.status(accepted.id)).toMatchObject({ state: "paused" });
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
    if (!originalHandle) throw new Error("Original real disk handle was not opened");
    await expect(originalHandle.stat()).rejects.toThrow();
    // Only this explicit fixture's actual known close permits manual test-host
    // SQL/lease cleanup; the dispatcher remains quarantined and never retries.
    owned.expectedDrainError = failure;
  }));
});

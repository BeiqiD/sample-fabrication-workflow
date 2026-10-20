import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { actor, otherActor, principalId, incarnation, bytes, createPrincipalTemplate, principalFixture, staged, retainOriginalPrincipalOperation, settleOriginalPrincipalOperations, drainOriginalPrincipalOwners, closePrincipalTemplates } from "./principal-test-support";

let template: Awaited<ReturnType<typeof createPrincipalTemplate>>;
const fixtures: Awaited<ReturnType<typeof principalFixture>>[] = [];
beforeAll(() => retainOriginalPrincipalOperation(async () => { template = await createPrincipalTemplate(); }));
afterEach(async () => {
  await settleOriginalPrincipalOperations(); vi.restoreAllMocks();
  for (const f of [...fixtures].reverse()) { await f.close(); fixtures.splice(fixtures.indexOf(f), 1); }
  await drainOriginalPrincipalOwners();
});
afterAll(async () => { await drainOriginalPrincipalOwners(); await closePrincipalTemplates(); });
const fixture = async () => { const f = await principalFixture(template); fixtures.push(f); return f; };
async function verified(f: Awaited<ReturnType<typeof fixture>>) {
  const x = await staged(f); await f.port.repository.observeSettled(x.attempt); await f.port.repository.verify(x.claim, x.item, x.attempt); return x;
}

describe("same-transaction Node job principal and operation-specific policies", () => {
  it("blocks a real second writer revocation after the source read but before publication BEGIN", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(), x = await verified(f); const original = f.native.exec.bind(f.native); let commits = 0, revoked = false;
    vi.spyOn(f.native, "exec").mockImplementation(sql => {
      original(sql);
      // First COMMIT during mature cutover is the actual source SELECT's
      // transaction. Revoke on a genuine second native connection after that
      // completed transaction and before the awaited source read returns.
      // Issued admission runs through the actual core, not core.batch's view.
      if (sql === "COMMIT" && ++commits === 1) {
        revoked = true; f.second.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId);
      }
    });
    await expect(f.port.repository.cutover(x.claim, x.item, x.attempt)).rejects.toThrow(); expect(revoked).toBe(true);
    expect(f.native.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()?.active_location_id).toBe("source-location");
    expect(f.native.prepare("SELECT state FROM file_migration_attempts WHERE id=?").get(x.attempt.id)?.state).toBe("verified");
    expect(f.native.prepare("SELECT count(*) n FROM file_location_publications WHERE location_id=?").get(x.attempt.location_id)?.n).toBe(0);
    expect(f.native.prepare("SELECT released_at FROM file_location_holds WHERE location_id='source-location' AND hold_kind='transition_source'").get()?.released_at).toBeNull();
    expect(f.native.isTransaction).toBe(false);
  }));
  it("holds the actual SQLite write transaction across the principal check and original publication mutation", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(), x = await verified(f); const original = f.native.exec.bind(f.native); let begins = 0, refused = false;
    vi.spyOn(f.native, "exec").mockImplementation(sql => {
      original(sql);
      if (sql === "BEGIN IMMEDIATE" && ++begins === 2) {
        // Second BEGIN is the original publication batch, after source read.
        // This test writer deliberately bypasses advisory host ownership to
        // prove the actual SQLite transaction, not an availability callback.
        try { f.second.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId); }
        catch (error) { refused = true; expect(error).toBeInstanceOf(Error); expect(String(error)).toMatch(/locked/); }
      }
    });
    expect(await f.port.repository.cutover(x.claim, x.item, x.attempt)).toBe(true); expect(refused).toBe(true);
    expect(f.native.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()?.active_location_id).toBe(x.attempt.location_id);
    expect(f.authority.authorizeAdministrator(actor)).toBe(true);
    f.second.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId); expect(f.authority.authorizeAdministrator(actor)).toBe(false);
  }));
  it("cannot certify another current administrator under a revoked job's immutable actor", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(), x = await staged(f); await f.port.repository.observeSettled(x.attempt);
    f.second.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId);
    expect(f.authority.authorizeAdministrator(otherActor)).toBe(true);
    await expect(f.port.repository.verify({ ...x.claim, actor: otherActor }, x.item, x.attempt)).rejects.toThrow();
    expect(f.native.prepare("SELECT actor FROM file_migration_jobs WHERE id=?").get(x.job.id)?.actor).toBe(actor);
    expect(f.native.prepare("SELECT state FROM file_migration_attempts WHERE id=?").get(x.attempt.id)?.state).toBe("write_started");
  }));
  it("records an original acknowledged disk write after grant revocation, then pauses without publication or early owner release", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(), x = await staged(f); const path = join(f.directory, "actual-owned-original.bin");
    let started!: () => void, acknowledge!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; }), acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    const original = f.lease.withWriter(async () => {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      started(); await acknowledgement;
      // Genuine completed original I/O acknowledges its exact accepted tuple.
      // No local provider is relabelled as R2 and no JobBoundStorage is forged.
      await f.port.repository.observeSettled(x.attempt);
    });
    let drain: Promise<void> | undefined;
    try {
      await startedPromise; f.second.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId);
      expect(f.authority.authorizeAdministrator(actor)).toBe(false);
      let drained = false; drain = f.lease.stopAdmissionAndDrain().then(() => { drained = true; });
      await Promise.resolve(); expect(drained).toBe(false); expect(f.native.isOpen).toBe(true);
      acknowledge(); await original; await drain; expect(await readFile(path)).toEqual(Buffer.from(bytes));
      expect(f.native.prepare("SELECT io_settled_at FROM file_migration_attempts WHERE id=?").get(x.attempt.id)?.io_settled_at).not.toBeNull();
      await expect(f.port.repository.verify(x.claim, x.item, x.attempt)).rejects.toThrow();
      await f.port.repository.fail(x.claim, x.item, x.attempt, "execution_not_authorized");
      await f.port.repository.pause(x.claim, "execution_not_authorized");
      expect(await f.port.repository.status(x.job.id)).toMatchObject({ state: "paused" });
      expect(f.native.prepare("SELECT active_location_id FROM file_publications WHERE file_id='file'").get()?.active_location_id).toBe("source-location");
      expect(f.native.prepare("SELECT count(*) n FROM file_location_holds WHERE released_at IS NULL").get()?.n).toBe(2);
    } finally { acknowledge(); await original; if (drain) await drain; }
  }));
  it("releases an independently approved source obligation after original actor revocation, retaining current-copy hold until explicit release", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(), x = await verified(f); expect(await f.port.repository.cutover(x.claim, x.item, x.attempt)).toBe(true);
    await f.port.repository.release(x.claim);
    await f.original.requestCleanup(x.job.id, otherActor, () => f.authority.authorizeAdministrator(otherActor));
    // Advance the existing grace field exactly as existing mature kernel tests;
    // no runtime TTL or production policy change is made by this candidate.
    f.native.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), x.job.id);
    f.second.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId);
    expect(f.authority.authorizeAdministrator(actor)).toBe(false); expect(f.port.authorizeSystemCleanup()).toBe(true);
    const copy = await f.port.repository.cleanupCopy(incarnation); if (!copy) throw new Error("Actual cleanup copy is unavailable");
    expect(await f.port.repository.releaseCleanup(copy, incarnation)).toBe(true);
    expect(f.native.prepare("SELECT released_at FROM file_location_holds WHERE id=?").get(copy.verification_hold_id)?.released_at).toBeNull();
    await f.port.repository.releaseVerificationHold(copy);
    expect(f.native.prepare("SELECT released_at FROM file_location_holds WHERE id=?").get(copy.verification_hold_id)?.released_at).not.toBeNull();
    expect(f.native.prepare("SELECT released_at FROM file_location_holds WHERE location_id='source-location' AND hold_kind='transition_source'").get()?.released_at).not.toBeNull();
  }));
  it("refuses old cleanup approval after a changed execution incarnation without releasing the source", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(), x = await verified(f); await f.port.repository.cutover(x.claim, x.item, x.attempt); await f.port.repository.release(x.claim);
    await f.original.requestCleanup(x.job.id, otherActor, () => f.authority.authorizeAdministrator(otherActor));
    f.native.prepare("UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?").run(new Date(Date.now() - 1000).toISOString(), x.job.id);
    const copy = await f.port.repository.cleanupCopy(incarnation); if (!copy) throw new Error("Actual cleanup copy is unavailable");
    f.second.prepare("UPDATE file_job_runtime_guard SET incarnation=?").run("new-destination-execution");
    expect(f.port.authorizeSystemCleanup()).toBe(false); await expect(f.port.repository.releaseCleanup(copy, incarnation)).rejects.toThrow();
    expect(f.native.prepare("SELECT released_at FROM file_location_holds WHERE location_id='source-location' AND hold_kind='transition_source'").get()?.released_at).toBeNull();
    await f.port.repository.releaseVerificationHold(copy);
  }));
});

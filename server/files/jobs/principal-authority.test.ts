import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createInstalledJobPrincipalAuthority } from "./principal-authority";
import { createOwnedNodeFileJobPort } from "./repository";
import { actor, otherActor, principalId, incarnation, createPrincipalTemplate, principalFixture, retainOriginalPrincipalOperation, settleOriginalPrincipalOperations, drainOriginalPrincipalOwners, closePrincipalTemplates } from "./principal-test-support";

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

describe("actual installed Node background job principal authority", () => {
  it("requires a current enabled stable account, exact actor equality, current grant and destination sentinel", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(); expect(f.authority.authorizeAdministrator(actor)).toBe(true);
    for (const wrong of [principalId, "migration.operator", "admin@example.test", actor.toUpperCase(), ` ${actor}`]) expect(f.authority.authorizeAdministrator(wrong)).toBe(false);
    f.second.prepare("DELETE FROM local_admin_grants WHERE principal_id=?").run(principalId);
    expect(f.authority.authorizeAdministrator(actor)).toBe(false); expect(f.authority.authorizeAdministrator(otherActor)).toBe(true);
    f.second.prepare("INSERT INTO local_admin_grants VALUES(?,0)").run(principalId);
    f.second.prepare("UPDATE local_accounts SET enabled=0 WHERE principal_id=?").run(principalId);
    expect(f.authority.authorizeAdministrator(actor)).toBe(false);
    f.second.prepare("UPDATE local_accounts SET enabled=1 WHERE principal_id=?").run(principalId);
    f.second.exec("DELETE FROM local_identity_installation"); expect(f.authority.authorizeAdministrator(actor)).toBe(false);
    expect(f.native.prepare("SELECT principal_id FROM local_accounts WHERE principal_id=?").get(principalId)?.principal_id).toBe(principalId);
  }));
  it("rejects copied admission/lease/authority and a wrong native owner without creating an executor grant", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(); const options = { database: f.core, nativeDatabase: f.native, admission: f.admission, writerLease: f.lease };
    expect(() => createInstalledJobPrincipalAuthority({ ...options, admission: { ...f.admission } })).toThrow("admission_not_issued");
    expect(() => createInstalledJobPrincipalAuthority({ ...options, writerLease: { ...f.lease } })).toThrow();
    expect(() => createInstalledJobPrincipalAuthority({ ...options, nativeDatabase: f.second })).toThrow("owner mismatch");
    expect(() => createOwnedNodeFileJobPort({ authority: { ...f.authority }, incarnation })).toThrow("unavailable");
    f.authority.close(); expect(f.authority.authorizeAdministrator(actor)).toBe(false);
    expect(() => createOwnedNodeFileJobPort({ authority: f.authority, incarnation })).toThrow("closed");
    expect(f.native.isOpen).toBe(true);
  }));
  it("rejects a changed installation identity and keeps HTTP mutation methods closed even for a current admin", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(); await expect(f.port.repository.accept(f.input, actor, () => true)).rejects.toThrow("HTTP admission");
    await expect(f.port.repository.control("unaccepted", "resume")).rejects.toThrow("HTTP admission");
    await expect(f.port.repository.requestCleanup("unaccepted", actor, () => true)).rejects.toThrow("HTTP admission");
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_jobs").get()?.n).toBe(0);
    f.second.prepare("UPDATE node_installation SET installation_id=?").run("30000000-0000-4000-8000-000000000003");
    expect(f.authority.authorizeAdministrator(actor)).toBe(false); await expect(f.port.repository.list()).rejects.toThrow("changed");
  }));
  it("pauses stored historical Worker actor history without coercing it into local authority", () => retainOriginalPrincipalOperation(async () => {
    const f = await fixture(); const oldActor = "Historical.Admin@example.test";
    const job = await f.original.accept(f.input, oldActor); const before = f.native.prepare("SELECT actor,input_json FROM file_migration_jobs WHERE id=?").get(job.id);
    expect(await f.port.repository.claim(incarnation, "node-owner", () => true)).toBeNull();
    expect(f.native.prepare("SELECT actor,input_json FROM file_migration_jobs WHERE id=?").get(job.id)).toEqual(before);
    expect(await f.port.repository.status(job.id)).toMatchObject({ state: "paused", reason: "administrator_revoked" });
    expect(f.native.prepare("SELECT count(*) n FROM file_migration_attempts").get()?.n).toBe(0);
  }));
});

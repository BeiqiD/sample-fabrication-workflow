import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { prepareStorageRoleSelection } from "../files/storage-role-selection";
import { activateNativeStorageProfile, readNativeStorageActivation } from "./native-profile-activation";
import { readStorageRolePolicy, setStorageRoleDefaults } from "./storage-role-policy";
import { saveStorageCandidate } from "./configuration-registry";
import { startStorageCandidateCheck } from "./candidate-check-service";

const databases: Awaited<ReturnType<typeof nativeAcceptanceFixture>>["sql"][] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });
async function fixture() { const f = await nativeAcceptanceFixture(false); databases.push(f.sql); return f; }
const roles = (f: Awaited<ReturnType<typeof fixture>>, operationId = crypto.randomUUID()) => ({ operationId,
  expectedPolicyRevision: 3, internalProfileId: f.admission.nativeProfileId, originalsProfileId: "r2-profile" });
const rotation = (f: Awaited<ReturnType<typeof fixture>>, operationId = crypto.randomUUID()) => ({ operationId,
  nativeProfileId: f.admission.nativeProfileId, candidateProfileId: f.saved.profileId, expectedCandidateRevision: 1,
  expectedEnvelopeRevision: 1, checkId: f.check.id, expectedBindingRevision: 1 });

describe("native activation and independent accepted storage policy", () => {
  it("changes two roles atomically, keeps historical selections and replays the original receipt without object I/O", async () => {
    const f = await fixture(), input = roles(f);
    const before = f.sql.prepare("SELECT * FROM storage_role_policy_revisions WHERE policy_revision=3 ORDER BY role").all();
    const value = await setStorageRoleDefaults(f.env, input, f.actor);
    expect(value).toMatchObject({ policyRevision: 4, internalProfileId: f.admission.nativeProfileId, originalsProfileId: "r2-profile" });
    expect(f.sql.prepare("SELECT * FROM storage_role_policy_revisions WHERE policy_revision=3 ORDER BY role").all()).toEqual(before);
    await setStorageRoleDefaults(f.env, { operationId: crypto.randomUUID(), expectedPolicyRevision: 4,
      internalProfileId: "r2-profile", originalsProfileId: "r2-profile" }, f.actor);
    expect(await setStorageRoleDefaults(f.env, input, f.actor)).toEqual(value);
    expect(await readStorageRolePolicy(f.env, input.operationId, f.actor)).toEqual(value);
    await expect(setStorageRoleDefaults(f.env, { ...input, originalsProfileId: f.admission.nativeProfileId }, f.actor)).rejects.toMatchObject({ status: 409 });
    expect(f.s3Fetch).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled(); expect(f.r2Put).not.toHaveBeenCalled();
  });
  it("serializes competing policy edits and rolls back the stale pair", async () => {
    const f = await fixture(), first = roles(f), second = { ...roles(f), internalProfileId: "r2-profile" };
    const result = await Promise.allSettled([setStorageRoleDefaults(f.env, first, f.actor), setStorageRoleDefaults(f.env, second, f.actor)]);
    expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(item => item.status === "rejected")).toHaveLength(1);
    expect(f.sql.prepare("SELECT count(*) count FROM storage_role_policy_revisions WHERE policy_revision=4").get()!.count).toBe(2);
    expect(f.sql.prepare("SELECT count(DISTINCT policy_revision) count FROM storage_role_defaults").get()!.count).toBe(1);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("fences a fresh acceptance against changed defaults without rerouting its selected targets", async () => {
    const f = await fixture();
    const selected = await prepareStorageRoleSelection(f.env.DB, f.env, ["research_source", "derived_preview"], new Date().toISOString());
    expect(selected.selectionRevision).toBe(3); expect(selected.profileFor("research_source").id).toBe(f.admission.nativeProfileId);
    expect(selected.profileFor("derived_preview").id).toBe("r2-profile");
    await setStorageRoleDefaults(f.env, roles(f), f.actor);
    await expect(f.env.DB.batch(selected.statements)).rejects.toThrow();
    expect(selected.profileFor("research_source").id).toBe(f.admission.nativeProfileId);
  });
  it("rotates an installation binding by CAS, preserves original activation receipts, and rejects a stale rotation", async () => {
    const f = await fixture(), input = rotation(f);
    const value = await activateNativeStorageProfile(f.env, input, f.actor);
    expect(value.bindingRevision).toBe(2);
    const next = { ...input, operationId: crypto.randomUUID(), expectedBindingRevision: 2 };
    expect((await activateNativeStorageProfile(f.env, next, f.actor)).bindingRevision).toBe(3);
    expect(await activateNativeStorageProfile(f.env, input, f.actor)).toEqual(value);
    expect(await readNativeStorageActivation(f.env, input.operationId, f.actor)).toEqual(value);
    await expect(activateNativeStorageProfile(f.env, { ...input, operationId: crypto.randomUUID() }, f.actor)).rejects.toMatchObject({ status: 409 });
    expect(f.s3Fetch).not.toHaveBeenCalled();
  });
  it("keeps the bound revision while candidate edits await explicit new-check activation", async () => {
    const f = await fixture();
    const revised = await saveStorageCandidate(f.env, { profileId: f.saved.profileId, expectedRevision: 1, label: "New credentials",
      namespace: f.saved.namespace, credentials: { mode: "replace", value: { accessKeyId: "next-access", secretAccessKey: "next-secret" } } }, f.actor);
    const selected = await prepareStorageRoleSelection(f.env.DB, f.env, ["research_source"], new Date().toISOString());
    expect(selected.profileFor("research_source").id).toBe(f.admission.nativeProfileId);
    await expect(activateNativeStorageProfile(f.env, rotation(f), f.actor)).rejects.toMatchObject({ status: 409 });
    const check = await startStorageCandidateCheck(f.env, { checkId: crypto.randomUUID(), profileId: revised.profileId, expectedRevision: 2 }, f.actor, { fetch: f.s3Fetch });
    expect(check.status).toBe("succeeded"); f.s3Fetch.mockClear();
    await activateNativeStorageProfile(f.env, { ...rotation(f), expectedCandidateRevision: 2, checkId: check.id }, f.actor);
    expect(f.sql.prepare("SELECT candidate_revision FROM system_storage_native_bindings").get()!.candidate_revision).toBe(2);
    await expect(f.env.DB.batch(selected.statements)).rejects.toThrow();
    expect(f.s3Fetch).not.toHaveBeenCalled();
  });
  it("requires current administrator authority even for successful replays and never substitutes R2 for unavailable selected S3", async () => {
    const f = await fixture(), input = roles(f), activation = rotation(f);
    const result = await setStorageRoleDefaults(f.env, input, f.actor);
    await activateNativeStorageProfile(f.env, activation, f.actor);
    f.env.SYSTEM_ADMIN_EMAILS = "another@example.test";
    await expect(setStorageRoleDefaults(f.env, input, f.actor)).rejects.toMatchObject({ status: 403 });
    await expect(activateNativeStorageProfile(f.env, activation, f.actor)).rejects.toMatchObject({ status: 403 });
    f.env.SYSTEM_ADMIN_EMAILS = f.actor; f.env.STORAGE_CREDENTIAL_KEYRING = undefined;
    expect(await readStorageRolePolicy(f.env, result.operationId, f.actor)).toEqual(result);
    await expect(prepareStorageRoleSelection(f.env.DB, f.env, ["derived_preview"], new Date().toISOString())).rejects.toThrow();
    expect(f.r2Put).not.toHaveBeenCalled(); expect(f.s3Fetch).not.toHaveBeenCalled();
    const disabled = { ...f.env, AUTH_MODE: "disabled" } as Env;
    await expect(setStorageRoleDefaults(disabled, input, f.actor)).rejects.toMatchObject({ status: 403 });
  });
  it("keeps independent roles usable when only the other role's credentials are unavailable", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = undefined;
    const selection = await prepareStorageRoleSelection(f.env.DB, f.env, ["embedded_content", "job_output"], new Date().toISOString());
    expect(selection.profileFor("embedded_content").id).toBe("r2-profile");
    await f.env.DB.batch(selection.statements);
    await expect(prepareStorageRoleSelection(f.env.DB, f.env, ["research_source"], new Date().toISOString())).rejects.toThrow();
    expect(f.s3Fetch).not.toHaveBeenCalled();
  });
});

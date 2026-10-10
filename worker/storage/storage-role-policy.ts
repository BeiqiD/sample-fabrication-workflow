import { checkedStorageRolePolicyInput, type StorageRolePolicyInput, type StorageRolePolicyReceipt } from "../../shared/contracts/storage-policy";
import { primaryD1 } from "../d1-primary";
import { readStorageRoleDefaults, StorageRoleDefaultsUnavailableError, type StorageRoleDefaults } from "../files/storage-role-defaults";
import { assertR2BootstrapProfile, ensureR2BootstrapProfile, type R2BootstrapProfile } from "../files/r2-bootstrap-profile";
import { openShadowProfile } from "../files/shadow-profile";
import { resolveR2ProfileBinding } from "../files/r2-profile-bindings";
import type { Env } from "../types";
import { StoragePolicyError, storagePolicyConflict, storagePolicyUnavailable } from "./native-profile-activation";
import { assertSystemAdministrator } from "./system-administrator";

export type SelectedStorageProfile = R2BootstrapProfile & { adapterType?: "r2" | "s3" | "switchdrive";
  bindingRevision?: number; envelopeRevision?: number };
export async function hasNativeStoragePolicy(database: D1Database): Promise<boolean> {
  const row = await primaryD1(database).prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='storage_role_policy_revisions'")
    .first<{ count: number }>();
  if (!row || ![0, 1].includes(row.count)) throw new StorageRoleDefaultsUnavailableError();
  return row.count === 1;
}
/** Pure capability opening; no object request or fallback takes place. */
export async function selectedStorageProfile(database: D1Database, env: Partial<Env>, id: string): Promise<SelectedStorageProfile> {
  const db = primaryD1(database);
  try {
    const row = await db.prepare(`SELECT p.*,r.state AS runtime_access FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id WHERE p.id=?`)
      .bind(id).first<{ id: string; adapter_type: string; configuration_revision: number; namespace_identity: string; runtime_access: string }>();
    if (!row || row.configuration_revision !== 1 || row.runtime_access !== "read_write") throw new Error();
    if (row.adapter_type === "r2") {
      const profile = await assertR2BootstrapProfile(db, env, row.id, 1);
      resolveR2ProfileBinding(env, profile);
      return profile;
    }
    if (row.adapter_type !== "s3") throw new Error();
    const binding = await db.prepare(`SELECT b.binding_revision,e.envelope_revision FROM system_storage_native_bindings b
      JOIN system_storage_credential_payloads e ON e.credential_ref=b.credential_ref WHERE b.storage_profile_id=?`)
      .bind(id).first<{ binding_revision: number; envelope_revision: number }>();
    if (!binding) throw new Error();
    const opened = await openShadowProfile({ ...env, DB: db } as Env, { profileId: id, configurationRevision: 1 }, "write");
    if (!opened.writer || !opened.deleter) throw new Error();
    return { id, configurationRevision: 1, namespaceIdentity: row.namespace_identity, adapterType: "s3",
      bindingRevision: binding.binding_revision, envelopeRevision: binding.envelope_revision };
  } catch { throw new StorageRoleDefaultsUnavailableError(); }
}
export function prepareRolePolicyStatements(db: D1Database, expected: StorageRoleDefaults | null,
  profiles: Record<"internal" | "originals", SelectedStorageProfile>, revision: number, operationId: string, actor: string, now: string): D1PreparedStatement[] {
  const expectedRevision = expected?.internal.policyRevision ?? null;
  const statements = [db.prepare(`SELECT CASE WHEN ((? IS NULL AND NOT EXISTS(SELECT 1 FROM storage_role_defaults))
    OR (? IS NOT NULL AND (SELECT count(*) FROM storage_role_defaults)=2 AND NOT EXISTS(SELECT 1 FROM storage_role_defaults WHERE policy_revision<>?)))
    AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active')
    THEN 1 ELSE json('Storage role policy changed') END`).bind(expectedRevision, expectedRevision, expectedRevision)];
  for (const role of ["internal", "originals"] as const) statements.push(db.prepare(`INSERT INTO storage_role_policy_revisions
    (policy_revision,role,storage_profile_id,storage_profile_revision,operation_id,actor,created_at) VALUES (?,?,?,1,?,?,?)`)
    .bind(revision, role, profiles[role].id, operationId, actor, now));
  for (const role of ["internal", "originals"] as const) if (profiles[role].adapterType === "s3") statements.push(db.prepare(`SELECT CASE WHEN EXISTS(
    SELECT 1 FROM system_storage_native_bindings b JOIN system_storage_credential_payloads e ON e.credential_ref=b.credential_ref
    WHERE b.storage_profile_id=? AND b.binding_revision=? AND e.envelope_revision=?) THEN 1 ELSE json('Native storage binding changed') END`)
    .bind(profiles[role].id, profiles[role].bindingRevision, profiles[role].envelopeRevision));
  for (const role of ["internal", "originals"] as const) statements.push(db.prepare(`INSERT INTO storage_role_defaults
    (role,storage_profile_id,storage_profile_revision,policy_revision,created_at) VALUES (?,?,1,?,?)
    ON CONFLICT(role) DO UPDATE SET storage_profile_id=excluded.storage_profile_id,storage_profile_revision=excluded.storage_profile_revision,
      policy_revision=excluded.policy_revision,created_at=excluded.created_at`).bind(role, profiles[role].id, revision, now));
  statements.push(prepareRoleSelectionFence(db, revision, profiles));
  return statements;
}
export function prepareRoleSelectionFence(db: D1Database, revision: number, profiles: Record<"internal" | "originals", SelectedStorageProfile>,
  selectedRoles: readonly ("internal" | "originals")[] = ["internal", "originals"]): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM storage_role_defaults)=2 AND
    (SELECT count(*) FROM storage_role_defaults d JOIN storage_role_policy_revisions h ON h.policy_revision=d.policy_revision AND h.role=d.role
      AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision AND h.created_at=d.created_at
      JOIN storage_profiles p ON p.id=d.storage_profile_id AND p.configuration_revision=d.storage_profile_revision
      LEFT JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
      WHERE d.policy_revision=? AND ((d.role='internal' AND d.storage_profile_id=?) OR(d.role='originals' AND d.storage_profile_id=?))
      AND (d.role NOT IN(${selectedRoles.map(() => "?").join(",")}) OR(r.state='read_write' AND (p.adapter_type='r2' OR(p.adapter_type='s3' AND EXISTS(SELECT 1 FROM system_storage_native_bindings b
        JOIN system_storage_credential_payloads e ON e.credential_ref=b.credential_ref WHERE b.storage_profile_id=p.id
        AND ((d.role='internal' AND b.binding_revision IS ? AND e.envelope_revision IS ?)
          OR(d.role='originals' AND b.binding_revision IS ? AND e.envelope_revision IS ?))))))))=2
    AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active')
    THEN 1 ELSE json('Selected storage policy changed') END`).bind(revision, profiles.internal.id, profiles.originals.id, ...selectedRoles,
      profiles.internal.bindingRevision ?? null, profiles.internal.envelopeRevision ?? null, profiles.originals.bindingRevision ?? null, profiles.originals.envelopeRevision ?? null);
}
export async function prepareCurrentRolePolicy(database: D1Database, env: Partial<Env>, now: string,
  selectedRoles: readonly ("internal" | "originals")[] = ["internal", "originals"]): Promise<{
  revision: number; profiles: Record<"internal" | "originals", SelectedStorageProfile>; statements: D1PreparedStatement[];
}> {
  const db = primaryD1(database), stored = await readStorageRoleDefaults(db);
  const initial = !stored ? await ensureR2BootstrapProfile(db, env, now) : null;
  async function profile(role: "internal" | "originals"): Promise<SelectedStorageProfile> {
    const id = stored?.[role].storageProfileId ?? initial!.id;
    if (selectedRoles.includes(role) || !stored || stored.internal.policyRevision === 2) return selectedStorageProfile(db, env, id);
    const row = await db.prepare(`SELECT id,adapter_type,namespace_identity,configuration_revision FROM storage_profiles WHERE id=? AND state='historical'`)
      .bind(id).first<{ id: string; adapter_type: string; namespace_identity: string; configuration_revision: number }>();
    if (!row || !["r2", "s3"].includes(row.adapter_type) || row.configuration_revision !== 1) throw new StorageRoleDefaultsUnavailableError();
    return { id: row.id, namespaceIdentity: row.namespace_identity, configurationRevision: 1,
      ...(row.adapter_type === "s3" ? { adapterType: "s3" as const } : {}) };
  }
  const profiles = { internal: await profile("internal"), originals: await profile("originals") };
  if (!stored || stored.internal.policyRevision === 2) return { revision: 3, profiles,
    statements: prepareRolePolicyStatements(db, stored, profiles, 3, "storage-role-policy:bootstrap:3", "bootstrap", now) };
  return { revision: stored.internal.policyRevision, profiles, statements: [prepareRoleSelectionFence(db, stored.internal.policyRevision, profiles, selectedRoles)] };
}
interface HistoryRow { policy_revision: number; role: string; storage_profile_id: string; operation_id: string; actor: string; created_at: string }
async function receipt(db: D1Database, operationId: string): Promise<StorageRolePolicyReceipt | null> {
  const result = await primaryD1(db).prepare("SELECT * FROM storage_role_policy_revisions WHERE operation_id=? ORDER BY role").bind(operationId).all<HistoryRow>();
  if (!result.success) throw storagePolicyUnavailable();
  if (!result.results.length) return null;
  const [internal, originals] = result.results;
  if (result.results.length !== 2 || internal.role !== "internal" || originals.role !== "originals" || internal.policy_revision !== originals.policy_revision
    || internal.actor !== originals.actor || internal.created_at !== originals.created_at) throw storagePolicyUnavailable();
  return { operationId, policyRevision: internal.policy_revision, internalProfileId: internal.storage_profile_id,
    originalsProfileId: originals.storage_profile_id, createdAt: internal.created_at, createdBy: internal.actor };
}
function match(value: StorageRolePolicyReceipt, input: StorageRolePolicyInput): StorageRolePolicyReceipt {
  if (value.internalProfileId !== input.internalProfileId || value.originalsProfileId !== input.originalsProfileId
    || value.policyRevision !== Math.max(3, (input.expectedPolicyRevision ?? 2) + 1)) throw storagePolicyConflict();
  return value;
}
export async function readStorageRolePolicy(env: Env, operationId: string, actor: string): Promise<StorageRolePolicyReceipt> {
  assertSystemAdministrator(env, actor);
  if (typeof operationId !== "string" || !operationId || operationId.length > 256 || operationId.includes("\0")) throw new StoragePolicyError(400, "Invalid role policy identity.");
  try { const value = await receipt(env.DB, operationId); if (!value) throw new StoragePolicyError(404, "Storage role policy was not found."); return value; }
  catch (error) { if (error instanceof StoragePolicyError) throw error; throw storagePolicyUnavailable(); }
}
export async function setStorageRoleDefaults(env: Env, raw: unknown, actor: string): Promise<StorageRolePolicyReceipt> {
  assertSystemAdministrator(env, actor);
  let input: StorageRolePolicyInput;
  try { input = checkedStorageRolePolicyInput(raw); } catch { throw new StoragePolicyError(400, "Invalid storage role policy."); }
  try {
    const capturedKeyring = env.STORAGE_CREDENTIAL_KEYRING;
    const prior = await receipt(env.DB, input.operationId);
    if (prior) return match(prior, input);
    const db = primaryD1(env.DB), stored = await readStorageRoleDefaults(db);
    if ((stored?.internal.policyRevision ?? null) !== input.expectedPolicyRevision) throw storagePolicyConflict();
    const profiles = { internal: await selectedStorageProfile(db, env, input.internalProfileId), originals: await selectedStorageProfile(db, env, input.originalsProfileId) };
    const revision = Math.max(3, (input.expectedPolicyRevision ?? 2) + 1), now = new Date().toISOString();
    if (!Number.isSafeInteger(revision)) throw storagePolicyConflict();
    assertSystemAdministrator(env, actor);
    if (env.STORAGE_CREDENTIAL_KEYRING !== capturedKeyring) throw storagePolicyConflict();
    try { await db.batch(prepareRolePolicyStatements(db, stored, profiles, revision, input.operationId, actor, now)); }
    catch { const committed = await receipt(env.DB, input.operationId); if (committed) return match(committed, input); throw storagePolicyConflict(); }
    const committed = await receipt(env.DB, input.operationId);
    if (!committed) throw storagePolicyUnavailable();
    return match(committed, input);
  } catch (error) { if (error instanceof StoragePolicyError) throw error; throw storagePolicyUnavailable(); }
}

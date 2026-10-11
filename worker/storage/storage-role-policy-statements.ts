import type { StorageRoleDefaults } from "../files/storage-role-defaults-core";

export type StoragePolicyRole = "internal" | "originals";
type PolicyBinding = string | number | null;
export interface RolePolicyTarget {
  readonly id: string;
  readonly configurationRevision: 1;
  readonly namespaceIdentity: string;
}

/** Prepare the mature metadata batch without granting provider authority. The
 * genuine composer supplies its already-owned provider fences and final exact
 * selection fence; all statements still execute in its one native transaction.
 * Configuration's mutation-only and Job SQL surfaces remain unchanged. */
export function prepareRolePolicyWrites<Statement>(
  database: { prepare(sql: string): { bind(...values: PolicyBinding[]): Statement } },
  expected: StorageRoleDefaults | null,
  profiles: Readonly<Record<StoragePolicyRole, RolePolicyTarget>>,
  revision: number, operationId: string, actor: string, now: string,
  providerFences: readonly Statement[], selectionFence: Statement,
): Statement[] {
  const expectedRevision = expected?.internal.policyRevision ?? null;
  const statements = [database.prepare(`SELECT CASE WHEN ((? IS NULL AND NOT EXISTS(SELECT 1 FROM storage_role_defaults))
    OR (? IS NOT NULL AND (SELECT count(*) FROM storage_role_defaults)=2 AND NOT EXISTS(SELECT 1 FROM storage_role_defaults WHERE policy_revision<>?)))
    AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active')
    THEN 1 ELSE json('Storage role policy changed') END`).bind(expectedRevision, expectedRevision, expectedRevision)];
  for (const role of ["internal", "originals"] as const) statements.push(database.prepare(`INSERT INTO storage_role_policy_revisions
    (policy_revision,role,storage_profile_id,storage_profile_revision,operation_id,actor,created_at) VALUES (?,?,?,1,?,?,?)`)
    .bind(revision, role, profiles[role].id, operationId, actor, now));
  statements.push(...providerFences);
  for (const role of ["internal", "originals"] as const) statements.push(database.prepare(`INSERT INTO storage_role_defaults
    (role,storage_profile_id,storage_profile_revision,policy_revision,created_at) VALUES (?,?,1,?,?)
    ON CONFLICT(role) DO UPDATE SET storage_profile_id=excluded.storage_profile_id,storage_profile_revision=excluded.storage_profile_revision,
      policy_revision=excluded.policy_revision,created_at=excluded.created_at`).bind(role, profiles[role].id, revision, now));
  statements.push(selectionFence);
  return statements;
}

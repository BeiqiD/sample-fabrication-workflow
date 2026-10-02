import type { FilePurpose } from "../../shared/contracts/files";
import type { FileAuthorityMode } from "./authority-reader";
import type { Env } from "../types";
import type { R2BootstrapProfile } from "./r2-bootstrap-profile";
import { prepareR2StorageRoleDefaults, StorageRoleDefaultsUnavailableError, type StorageRoleDefault } from "./storage-role-defaults";

type StorageRole = StorageRoleDefault["role"];
const PURPOSE_ROLES = Object.freeze({
  research_source: "originals",
  provenance: "originals",
  embedded_content: "internal",
  derived_preview: "internal",
  job_output: "internal",
} satisfies Record<FilePurpose, StorageRole>);

export function roleForFilePurpose(purpose: FilePurpose): StorageRole {
  if (typeof purpose !== "string" || !Object.hasOwn(PURPOSE_ROLES, purpose)) throw new StorageRoleDefaultsUnavailableError();
  return PURPOSE_ROLES[purpose];
}

interface StorageRoleProfiles {
  profileFor(purpose: FilePurpose): R2BootstrapProfile;
  /** Whole-import receipts capture one destination. Reject a selection that
   * would require destinations which that receipt cannot represent. */
  uniformProfile(): R2BootstrapProfile;
}

export interface StorageRoleSelection extends StorageRoleProfiles {
  rolePolicyRevision: 2;
  statements: D1PreparedStatement[];
}

/** A fresh receipt must commit under the mode that selected its target. This
 * also fences acceptances without binary items, which do not prepare defaults.
 * The native receipt schemas already require the installed authority table. */
export function prepareStorageRoleAcceptanceModeFence(database: D1Database, mode: FileAuthorityMode): D1PreparedStatement {
  if (mode !== "legacy" && mode !== "overlap" && mode !== "active") throw new StorageRoleDefaultsUnavailableError();
  return database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode=?)
    THEN 1 ELSE json('Storage acceptance authority mode changed') END`).bind(mode);
}

function checkedPurposes(purposes: readonly FilePurpose[]): Set<FilePurpose> {
  if (!Array.isArray(purposes) || !purposes.length) throw new StorageRoleDefaultsUnavailableError();
  for (const purpose of purposes) roleForFilePurpose(purpose);
  return new Set(purposes);
}

function profilesForPurposes(purposes: Set<FilePurpose>, profiles: Record<StorageRole, R2BootstrapProfile>): StorageRoleProfiles {
  const selected = new Map<FilePurpose, R2BootstrapProfile>();
  for (const purpose of purposes) {
    const profile = profiles[roleForFilePurpose(purpose)];
    if (!profile || typeof profile.id !== "string" || !profile.id || profile.configurationRevision !== 1
      || typeof profile.namespaceIdentity !== "string" || !profile.namespaceIdentity)
      throw new StorageRoleDefaultsUnavailableError();
    selected.set(purpose, Object.freeze({ ...profile }));
  }
  const profileFor = (purpose: FilePurpose): R2BootstrapProfile => {
    roleForFilePurpose(purpose);
    const profile = selected.get(purpose);
    if (!profile) throw new StorageRoleDefaultsUnavailableError();
    return profile;
  };
  return {
    profileFor,
    uniformProfile() {
      const [first, ...rest] = selected.values();
      if (!first || rest.some(profile => profile.id !== first.id || profile.configurationRevision !== first.configurationRevision
        || profile.namespaceIdentity !== first.namespaceIdentity)) throw new StorageRoleDefaultsUnavailableError();
      return first;
    },
  };
}

/** Resolve already validated profile metadata without reading mutable defaults.
 * The production preparation currently admits the same immutable R2 profile
 * for both roles. Keeping this resolution explicit prevents a whole-import
 * acceptance from silently choosing one role if destinations later diverge. */
export function resolveStorageRoleProfiles(purposes: readonly FilePurpose[], profiles: Record<StorageRole, R2BootstrapProfile>): StorageRoleProfiles {
  return profilesForPurposes(checkedPurposes(purposes), profiles);
}

/** Fresh active acceptances only. The caller commits these policy statements,
 * its immutable target receipt and an assertion that the exact owned receipt
 * exists in one batch, before any provider I/O. A zero-row receipt INSERT must
 * roll back newly initialized defaults. Existing receipts and execution must
 * continue using their captured targets. */
export async function prepareStorageRoleSelection(database: D1Database, env: Pick<Env, "R2_BOOTSTRAP_NAMESPACE">,
  purposes: readonly FilePurpose[], now: string): Promise<StorageRoleSelection> {
  const selected = checkedPurposes(purposes);
  const prepared = await prepareR2StorageRoleDefaults(database, env, now);
  return {
    ...profilesForPurposes(selected, { internal: prepared.profile, originals: prepared.profile }),
    rolePolicyRevision: 2,
    statements: prepared.statements,
  };
}

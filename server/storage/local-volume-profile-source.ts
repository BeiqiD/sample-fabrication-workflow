import type { DatabaseSync } from "node:sqlite";
import type { RegisteredStorageProfile } from "../../worker/files/storage-profile-opening";
import type { CapturedLocalVolumeDescriptor } from "./local-volume-descriptor";

/** Exact current local authority selection shared by byte opening and final
 * File publication. This read helper does not issue or admit any capability. */
export const LOCAL_VOLUME_PROFILE_SOURCE_SQL = `SELECT b.installation_id,b.root_binding_id,b.binding_id,b.binding_revision,b.admission_operation_id,
      b.namespace_sha256,b.binding_fingerprint_sha256,b.access,b.state,b.created_at,b.updated_at,
      r.state AS runtime_state,r.activated_at,r.retired_at,a.check_id,c.completed_at
      FROM storage_profiles p JOIN local_storage_profile_registrations registered ON registered.storage_profile_id=p.id
      JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
      JOIN local_storage_profile_bindings b ON b.storage_profile_id=p.id
      JOIN local_storage_profile_admissions a ON a.operation_id=b.admission_operation_id
      JOIN local_storage_profile_checks c ON c.id=a.check_id
      WHERE p.id=? AND p.adapter_type='local' AND p.configuration_source='installation' AND p.credential_reference IS NULL
      AND p.configuration_revision=1 AND p.state='historical' AND p.namespace_identity=?
      AND registered.namespace_sha256=? AND b.namespace_sha256=registered.namespace_sha256
      AND b.installation_id=? AND b.root_binding_id=? AND b.binding_fingerprint_sha256=? AND b.state='available'
      AND a.storage_profile_id=p.id AND a.installation_id=b.installation_id AND a.root_binding_id=b.root_binding_id
      AND a.binding_id=b.binding_id AND a.binding_revision=b.binding_revision AND a.namespace_sha256=b.namespace_sha256
      AND a.binding_fingerprint_sha256=b.binding_fingerprint_sha256 AND a.access=b.access
      AND c.storage_profile_id=p.id AND c.installation_id=b.installation_id AND c.root_binding_id=b.root_binding_id
      AND c.binding_id=b.binding_id AND c.binding_revision=b.binding_revision AND c.namespace_sha256=b.namespace_sha256
      AND c.binding_fingerprint_sha256=b.binding_fingerprint_sha256 AND c.access=b.access
      AND c.state='passed' AND c.stat_verified=1 AND c.read_verified=1 AND c.write_verified=1 AND c.delete_verified=1 AND c.cleanup_complete=1
      AND r.state IN('read_only','read_write') AND r.retired_at IS NULL
      AND (?='read' OR(r.state='read_write' AND b.access='read_write'))
      AND (r.state='read_only' OR EXISTS(SELECT 1 FROM local_storage_profile_activations active
        WHERE active.storage_profile_id=p.id AND active.action='activate' AND active.admission_operation_id=b.admission_operation_id
        AND active.binding_revision=b.binding_revision AND active.namespace_sha256=b.namespace_sha256 AND active.created_at=r.activated_at
        AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=p.id
          AND retired.action='retire' AND retired.binding_revision>=active.binding_revision)))`;
export const LOCAL_VOLUME_PROFILE_SOURCE_COLUMNS = Object.freeze([
  "installation_id", "root_binding_id", "binding_id", "binding_revision", "admission_operation_id",
  "namespace_sha256", "binding_fingerprint_sha256", "access", "state", "created_at", "updated_at",
  "runtime_state", "activated_at", "retired_at", "check_id", "completed_at",
] as const);
export type LocalVolumeProfileSource = Readonly<Record<string, string | number | null>>;
export function localVolumeProfileSourceBindings(installationId: string, profile: RegisteredStorageProfile,
  descriptor: CapturedLocalVolumeDescriptor, access: "read" | "write") {
  return Object.freeze([profile.profileId, descriptor.namespaceIdentity, descriptor.namespaceSha256, installationId,
    descriptor.rootBindingId, descriptor.bindingFingerprintSha256, access]);
}
export function readLocalVolumeProfileSource(native: DatabaseSync, installationId: string,
  profile: RegisteredStorageProfile, descriptor: CapturedLocalVolumeDescriptor, access: "read" | "write"): LocalVolumeProfileSource {
  const row = native.prepare(LOCAL_VOLUME_PROFILE_SOURCE_SQL).get(...localVolumeProfileSourceBindings(installationId, profile, descriptor, access));
  if (!row || !Number.isSafeInteger(row.binding_revision) || Number(row.binding_revision) < 1
    || row.runtime_state !== profile.runtimeState || Object.keys(row).length !== LOCAL_VOLUME_PROFILE_SOURCE_COLUMNS.length)
    throw new Error("Local volume profile is unavailable");
  const selected: Record<string, string | number | null> = Object.create(null);
  for (const column of LOCAL_VOLUME_PROFILE_SOURCE_COLUMNS) {
    const cell = row[column];
    if (cell !== null && typeof cell !== "string" && (typeof cell !== "number" || !Number.isSafeInteger(cell)))
      throw new Error("Local volume authority cell is unavailable");
    selected[column] = cell;
  }
  return Object.freeze(selected);
}

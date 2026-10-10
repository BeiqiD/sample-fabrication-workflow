import { checkedSaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import { awsS3NativeNamespace, canonicalNativeS3Namespace } from "../../shared/contracts/storage-profile-admission";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { ByteVerificationError } from "../files/byte-verification";
import { decryptStorageCredential, parseStorageCredentialKeyring } from "./credential-envelope";
import { s3ByteAdapter, S3StorageUnavailableError, type S3ByteAdapter, type S3ByteAdapterOptions } from "./s3-byte-adapter";

type NativeEnvironment = Pick<Env, "DB" | "STORAGE_CREDENTIAL_KEYRING">;
export interface NativeStorageProfile { profileId: string; configurationRevision: number }

// Resolve the explicit current installation binding, never the candidate's
// mutable head. Admission preserves registration; activation admits runtime use.
const COLUMNS = {
  profile_id: "p.id", adapter_type: "p.adapter_type", namespace_identity: "p.namespace_identity",
  configuration_source: "p.configuration_source", credential_reference: "p.credential_reference",
  configuration_revision: "p.configuration_revision", profile_state: "p.state", profile_created_at: "p.created_at",
  runtime_state: "runtime.state", registered_at: "runtime.registered_at", activated_at: "runtime.activated_at", retired_at: "runtime.retired_at",
  admission_namespace_sha256: "admission.namespace_sha256", admission_created_at: "admission.created_at",
  candidate_profile_id: "b.candidate_profile_id", candidate_revision: "b.candidate_revision", binding_credential_ref: "b.credential_ref",
  binding_envelope_revision: "b.envelope_revision", check_id: "b.check_id", configuration_sha256: "b.configuration_sha256",
  namespace_sha256: "b.namespace_sha256", binding_revision: "b.binding_revision", binding_created_at: "b.created_at", binding_updated_at: "b.updated_at",
  activation_operation_id: "a.operation_id", activation_action: "a.action", activation_candidate_profile_id: "a.candidate_profile_id",
  activation_candidate_revision: "a.candidate_revision", activation_envelope_revision: "a.envelope_revision", activation_check_id: "a.check_id",
  activation_configuration_sha256: "a.configuration_sha256", activation_namespace_sha256: "a.namespace_sha256", activation_binding_revision: "a.binding_revision",
  activation_actor: "a.actor", activation_created_at: "a.created_at",
  activation_head_revision: "(SELECT max(history.binding_revision) FROM storage_profile_activations history WHERE history.storage_profile_id=p.id AND history.action='activate')",
  candidate_adapter_type: "candidate.adapter_type", physical_namespace_json: "candidate.namespace_json", candidate_namespace_sha256: "candidate.namespace_sha256",
  namespace_json: "r.namespace_json", credential_ref: "r.credential_ref", descriptor_namespace_sha256: "d.namespace_sha256",
  envelope_revision: "e.envelope_revision", envelope_version: "e.envelope_version", key_id: "e.key_id", nonce: "e.nonce", ciphertext: "e.ciphertext",
  check_profile_id: "c.profile_id", check_revision: "c.configuration_revision", check_credential_ref: "c.credential_ref",
  check_envelope_revision: "c.envelope_revision", check_namespace_json: "c.namespace_json", check_configuration_sha256: "c.configuration_sha256",
  check_status: "c.status", check_write: "c.write_outcome", check_read: "c.read_outcome", check_metadata: "c.metadata_outcome",
  check_delete: "c.delete_outcome", check_cleanup: "c.cleanup_outcome", check_result_code: "c.result_code", check_completed_at: "c.completed_at",
} as const;
type Source = Record<keyof typeof COLUMNS, string | number | null>;
const FROM = `FROM storage_profiles p
 JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id
 JOIN storage_profile_admissions admission ON admission.native_profile_id=p.id
 JOIN system_storage_native_bindings b ON b.storage_profile_id=p.id
 JOIN storage_profile_activations a ON a.operation_id=b.activation_operation_id AND a.storage_profile_id=p.id
 JOIN system_storage_profiles candidate ON candidate.id=b.candidate_profile_id
 JOIN system_storage_configuration_revisions r ON r.profile_id=b.candidate_profile_id AND r.revision=b.candidate_revision
 JOIN system_storage_credential_descriptors d ON d.credential_ref=b.credential_ref AND d.profile_id=r.profile_id AND d.configuration_revision=r.revision
 JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref
 JOIN system_storage_candidate_checks c ON c.id=b.check_id
 WHERE p.id=? AND p.configuration_revision=?`;
const SELECT = `SELECT ${Object.entries(COLUMNS).map(([alias, column]) => `${column} AS ${alias}`).join(",")} ${FROM}`;
const GUARD = Object.values(COLUMNS).map(column => `${column} IS ?`).join(" AND ");
const encoder = new TextEncoder();
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function unavailable(): never { throw new S3StorageUnavailableError(); }

async function transport(env: NativeEnvironment, profile: NativeStorageProfile, access: "read" | "write", options: S3ByteAdapterOptions): Promise<S3ByteAdapter> {
  const database = env.DB;
  const source = await primaryD1(database).prepare(SELECT).bind(profile.profileId, profile.configurationRevision).first<Source>();
  if (!source || source.adapter_type !== "s3" || source.configuration_source !== "system" || source.credential_reference !== null
    || source.profile_state !== "historical" || source.configuration_revision !== 1 || source.candidate_adapter_type !== "s3"
    || !["read_only", "read_write"].includes(String(source.runtime_state)) || access === "write" && source.runtime_state !== "read_write"
    || source.registered_at !== source.profile_created_at || source.admission_created_at !== source.profile_created_at
    || source.retired_at !== null || source.activation_action !== "activate" || source.activated_at !== source.activation_created_at
    || source.activation_candidate_profile_id !== source.candidate_profile_id || source.activation_candidate_revision !== source.candidate_revision
    || source.activation_envelope_revision !== source.binding_envelope_revision || source.activation_check_id !== source.check_id
    || source.activation_configuration_sha256 !== source.configuration_sha256 || source.activation_namespace_sha256 !== source.namespace_sha256
    || source.activation_binding_revision !== source.binding_revision || source.activation_head_revision !== source.binding_revision
    || source.binding_credential_ref !== source.credential_ref
    || source.check_profile_id !== source.candidate_profile_id || source.check_revision !== source.candidate_revision
    || source.check_credential_ref !== source.credential_ref || source.check_envelope_revision !== source.binding_envelope_revision
    || source.check_namespace_json !== source.namespace_json || source.check_configuration_sha256 !== source.configuration_sha256
    || source.check_status !== "succeeded" || source.check_write !== "acknowledged" || source.check_read !== "verified"
    || source.check_metadata !== "verified" || source.check_delete !== "acknowledged" || source.check_cleanup !== "confirmed_absent"
    || source.check_result_code !== null || source.check_completed_at === null) return unavailable();
  const identity = canonicalNativeS3Namespace(JSON.parse(source.namespace_identity as string));
  if (identity !== source.namespace_identity || await digest(identity) !== source.namespace_sha256
    || source.admission_namespace_sha256 !== source.namespace_sha256 || profile.profileId !== `storage-profile:aws-s3:${source.namespace_sha256}`
    || !Number.isSafeInteger(source.envelope_revision) || (source.envelope_revision as number) < (source.binding_envelope_revision as number)
    || source.descriptor_namespace_sha256 !== source.candidate_namespace_sha256) return unavailable();

  const keyringJson = env.STORAGE_CREDENTIAL_KEYRING;
  const opened = await decryptStorageCredential(await parseStorageCredentialKeyring(keyringJson), {
    profileId: source.candidate_profile_id as string, configurationRevision: source.candidate_revision as number,
    credentialRef: source.credential_ref as string, namespaceSha256: source.candidate_namespace_sha256 as string,
  }, { version: source.envelope_version, keyId: source.key_id, nonce: source.nonce, ciphertext: source.ciphertext });
  if (opened.outcome !== "available") return unavailable();
  const checked = checkedSaveStorageCandidateInput({ expectedRevision: null, label: "Native File transport",
    namespace: JSON.parse(source.namespace_json as string), credentials: { mode: "replace", value: JSON.parse(opened.plaintext) } });
  if (checked.namespace.kind !== "s3" || checked.credentials.mode !== "replace" || !("accessKeyId" in checked.credentials.value)) return unavailable();
  const namespace = checked.namespace;
  const physical = JSON.stringify({ kind: "s3", endpoint: namespace.endpoint, bucket: namespace.bucket, root: namespace.root });
  if (JSON.stringify(namespace) !== source.namespace_json || awsS3NativeNamespace(namespace) !== identity
    || physical !== source.physical_namespace_json || await digest(physical) !== source.candidate_namespace_sha256
    || await digest(source.namespace_json as string) !== source.configuration_sha256) return unavailable();

  return s3ByteAdapter(namespace, checked.credentials.value, { ...options, beforeRequest: async operation => {
    // The adapter invokes this after signing. Recheck after the caller's fence,
    // since it may await and change the binding or the lease while suspended.
    if (options.beforeRequest && await options.beforeRequest(operation) !== true) return false;
    const bound = await primaryD1(database).prepare(`SELECT 1 AS bound ${FROM} AND ${GUARD}`)
      .bind(profile.profileId, profile.configurationRevision, ...Object.keys(COLUMNS).map(key => source[key as keyof Source])).first();
    return Boolean(bound) && env.DB === database && env.STORAGE_CREDENTIAL_KEYRING === keyringJson;
  } });
}

/** Authenticate the exact installation capability without making provider I/O.
 * Operation wrappers still authenticate and fence their own fresh snapshots. */
export async function assertNativeS3StorageAvailable(env: NativeEnvironment, profile: NativeStorageProfile, access: "read" | "write"): Promise<void> {
  await transport(env, profile, access, {});
}

/** Exact native File capabilities. Every operation authenticates the retained
 * installation binding anew and fences it after signing. This module owns no
 * business authorization, target selection, retries, publication or cleanup. */
export function nativeS3ByteStorage(env: NativeEnvironment, input: NativeStorageProfile, access: "read" | "write", options: S3ByteAdapterOptions = {}): S3ByteAdapter {
  if (!input || !/^storage-profile:aws-s3:[0-9a-f]{64}$/.test(input.profileId) || input.configurationRevision !== 1
    || !["read", "write"].includes(access)) return unavailable();
  const profile = Object.freeze({ profileId: input.profileId, configurationRevision: input.configurationRevision });
  return {
    reader: {
      async read(key) { try { return await (await transport(env, profile, access, options)).reader.read(key); } catch { return { outcome: "unavailable" }; } },
      async stat(key) { try { return await (await transport(env, profile, access, options)).reader.stat(key); } catch { return { outcome: "unavailable" }; } },
    },
    writer: { accepts: "both", async write(input) {
      if (access !== "write") return unavailable();
      try { return await (await transport(env, profile, access, options)).writer.write(input); }
      catch (error) {
        if (!(input.body instanceof ArrayBuffer) && !input.body.locked) await input.body.cancel().catch(() => undefined);
        if (error instanceof S3StorageUnavailableError || error instanceof ByteVerificationError) throw error;
        return unavailable();
      }
    } },
    deleter: { async delete(key) {
      if (access !== "write") return { outcome: "unavailable" };
      try { return await (await transport(env, profile, access, options)).deleter.delete(key); } catch { return { outcome: "unavailable" }; }
    } },
  };
}

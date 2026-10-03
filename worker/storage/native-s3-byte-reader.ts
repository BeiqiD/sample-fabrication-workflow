import { checkedSaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import { awsS3NativeNamespace, canonicalNativeS3Namespace, checkedStorageProfileAdmissionReceipt } from "../../shared/contracts/storage-profile-admission";
import { primaryD1 } from "../d1-primary";
import type { ByteReader } from "../files/byte-reader";
import type { Env } from "../types";
import { decryptStorageCredential, parseStorageCredentialKeyring } from "./credential-envelope";
import { s3ByteAdapter, S3StorageUnavailableError, type S3ByteAdapterOptions } from "./s3-byte-adapter";

type ReaderEnvironment = Pick<Env, "DB" | "STORAGE_CREDENTIAL_KEYRING">;
export interface NativeS3ReaderProfile { profileId: string; configurationRevision: number }

// The admission fixes the candidate revision. Its mutable head is deliberately
// absent: editing a candidate must not retarget an already registered namespace.
const COLUMNS = {
  native_id: "p.id", adapter_type: "p.adapter_type", namespace_identity: "p.namespace_identity",
  configuration_source: "p.configuration_source", credential_reference: "p.credential_reference",
  configuration_revision: "p.configuration_revision", profile_state: "p.state", profile_created_at: "p.created_at",
  runtime_state: "runtime.state", registered_at: "runtime.registered_at", activated_at: "runtime.activated_at", retired_at: "runtime.retired_at",
  operation_id: "a.operation_id", candidate_profile_id: "a.candidate_profile_id", candidate_revision: "a.candidate_revision",
  admission_envelope_revision: "a.envelope_revision", check_id: "a.check_id", configuration_sha256: "a.configuration_sha256",
  native_namespace_sha256: "a.namespace_sha256", actor: "a.actor", admission_created_at: "a.created_at",
  candidate_adapter_type: "candidate.adapter_type", physical_namespace_json: "candidate.namespace_json",
  candidate_namespace_sha256: "candidate.namespace_sha256", namespace_json: "r.namespace_json", credential_ref: "r.credential_ref",
  descriptor_namespace_sha256: "d.namespace_sha256", envelope_revision: "e.envelope_revision", envelope_version: "e.envelope_version",
  key_id: "e.key_id", nonce: "e.nonce", ciphertext: "e.ciphertext",
} as const;
type Source = Record<keyof typeof COLUMNS, string | number | null>;
const FROM = `FROM storage_profiles p
  JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id
  JOIN storage_profile_admissions a ON a.native_profile_id=p.id
  JOIN system_storage_profiles candidate ON candidate.id=a.candidate_profile_id
  JOIN system_storage_configuration_revisions r ON r.profile_id=a.candidate_profile_id AND r.revision=a.candidate_revision
  JOIN system_storage_credential_descriptors d ON d.credential_ref=r.credential_ref
    AND d.profile_id=r.profile_id AND d.configuration_revision=r.revision
  JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref
  WHERE p.id=? AND p.configuration_revision=?`;
const SELECT = `SELECT ${Object.entries(COLUMNS).map(([alias, column]) => `${column} AS ${alias}`).join(",")} ${FROM}`;
const GUARD = Object.values(COLUMNS).map(column => `${column} IS ?`).join(" AND ");
const encoder = new TextEncoder();
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function unavailable(): never { throw new S3StorageUnavailableError(); }

async function transport(env: ReaderEnvironment, profile: NativeS3ReaderProfile, options: S3ByteAdapterOptions): Promise<ByteReader> {
  const source = await primaryD1(env.DB).prepare(SELECT).bind(profile.profileId, profile.configurationRevision).first<Source>();
  if (!source || source.adapter_type !== "s3" || source.configuration_source !== "system" || source.credential_reference !== null
    || source.configuration_revision !== 1 || source.profile_state !== "historical" || source.runtime_state !== "read_only"
    || source.registered_at !== source.profile_created_at || source.admission_created_at !== source.profile_created_at
    || source.activated_at !== null || source.retired_at !== null || source.candidate_adapter_type !== "s3") return unavailable();
  const receipt = checkedStorageProfileAdmissionReceipt({ operationId: source.operation_id, profileId: source.candidate_profile_id,
    revision: source.candidate_revision, envelopeRevision: source.admission_envelope_revision, checkId: source.check_id,
    nativeProfileId: source.native_id, configurationRevision: 1, runtimeAccess: "read_only",
    createdAt: source.admission_created_at, createdBy: source.actor });
  const identity = canonicalNativeS3Namespace(JSON.parse(source.namespace_identity as string));
  if (identity !== source.namespace_identity || await digest(identity) !== source.native_namespace_sha256
    || profile.profileId !== `storage-profile:aws-s3:${source.native_namespace_sha256}`
    || !Number.isSafeInteger(source.envelope_revision) || (source.envelope_revision as number) < receipt.envelopeRevision
    || source.descriptor_namespace_sha256 !== source.candidate_namespace_sha256) return unavailable();

  const keyringJson = env.STORAGE_CREDENTIAL_KEYRING, keyring = await parseStorageCredentialKeyring(keyringJson);
  const opened = await decryptStorageCredential(keyring, { profileId: receipt.profileId, configurationRevision: receipt.revision,
    credentialRef: source.credential_ref as string, namespaceSha256: source.candidate_namespace_sha256 as string },
  { version: source.envelope_version, keyId: source.key_id, nonce: source.nonce, ciphertext: source.ciphertext });
  if (opened.outcome !== "available") return unavailable();
  const checked = checkedSaveStorageCandidateInput({ expectedRevision: null, label: "Native S3 reader",
    namespace: JSON.parse(source.namespace_json as string), credentials: { mode: "replace", value: JSON.parse(opened.plaintext) } });
  if (checked.namespace.kind !== "s3" || checked.credentials.mode !== "replace" || !("accessKeyId" in checked.credentials.value)) return unavailable();
  const namespace = checked.namespace;
  const physical = JSON.stringify({ kind: "s3", endpoint: namespace.endpoint, bucket: namespace.bucket, root: namespace.root });
  if (JSON.stringify(namespace) !== source.namespace_json || awsS3NativeNamespace(namespace) !== identity
    || physical !== source.physical_namespace_json || await digest(physical) !== source.candidate_namespace_sha256
    || await digest(source.namespace_json as string) !== source.configuration_sha256) return unavailable();

  // Recheck after authentication AND SigV4 signing, immediately before sending.
  // A wrapping race fails this operation; a later call can authenticate the new
  // envelope. Neither operation retries, falls back, or uses the latest candidate.
  return s3ByteAdapter(namespace, checked.credentials.value, { ...options, fetch: async request => {
    const bound = await primaryD1(env.DB).prepare(`SELECT 1 AS bound ${FROM} AND ${GUARD}`)
      .bind(profile.profileId, profile.configurationRevision, ...Object.keys(COLUMNS).map(key => source[key as keyof Source])).first();
    if (!bound || env.STORAGE_CREDENTIAL_KEYRING !== keyringJson) return unavailable();
    return (options.fetch ?? fetch)(request);
  } }).reader;
}

/** Internal read transport for one admitted native identity, with no SQL writes
 * or provider requests at construction. Each read/stat authenticates its exact
 * retained descriptor anew; plaintext is never exposed through this interface.
 *
 * The caller owns business authorization and key selection. This is groundwork
 * for native File access, not a public reader or permission to create S3 File
 * locations. The current schema still prohibits those locations, write admission
 * and defaults. No writer/deleter, activation, fallback or retry is provided.
 * Available bytes/metadata are transport observations, not File verification.
 */
export function nativeS3ByteReader(env: ReaderEnvironment, input: NativeS3ReaderProfile, options: S3ByteAdapterOptions = {}): ByteReader {
  if (!input || typeof input.profileId !== "string" || !/^storage-profile:aws-s3:[0-9a-f]{64}$/.test(input.profileId)
    || input.configurationRevision !== 1) return unavailable();
  const profile = Object.freeze({ profileId: input.profileId, configurationRevision: input.configurationRevision });
  return {
    async read(key) {
      try { return await (await transport(env, profile, options)).read(key); }
      catch { return { outcome: "unavailable" }; }
    },
    async stat(key) {
      try { return await (await transport(env, profile, options)).stat(key); }
      catch { return { outcome: "unavailable" }; }
    },
  };
}

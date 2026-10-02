import {
  checkedStorageCandidateReadiness, checkedStorageCandidateReadinessInput,
  type StorageCandidateReadiness, type StorageCandidateReadinessInput,
} from "../../shared/contracts/storage-candidate-readiness";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { decryptStorageCredential, parseStorageCredentialKeyring } from "./credential-envelope";
import { assertSystemAdministrator } from "./system-administrator";

type ReadinessEnvironment = Pick<Env, "DB" | "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS" | "STORAGE_CREDENTIAL_KEYRING">;
export class StorageCandidateReadinessError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) {
    super(message); this.name = "StorageCandidateReadinessError";
  }
}
const unavailable = () => new StorageCandidateReadinessError(503, "Storage candidate readiness is temporarily unavailable.");
const conflict = () => new StorageCandidateReadinessError(409, "Storage candidate changed. Refresh and try again.");

// Keep every value used for authentication and classification in the final
// source guard, including payload absence. No protected field leaves the service.
const SOURCE_COLUMNS = {
  profile_id: "p.id", adapter_type: "p.adapter_type", physical_namespace_json: "p.namespace_json",
  namespace_sha256: "p.namespace_sha256", latest_revision: "p.latest_revision", profile_created_at: "p.created_at",
  revision: "r.revision", namespace_json: "r.namespace_json", credential_ref: "r.credential_ref",
  label: "r.label", configuration_created_at: "r.created_at", configuration_created_by: "r.created_by",
  descriptor_ref: "d.credential_ref", descriptor_profile_id: "d.profile_id", descriptor_revision: "d.configuration_revision",
  descriptor_namespace_sha256: "d.namespace_sha256", descriptor_created_at: "d.created_at",
  payload_ref: "e.credential_ref", envelope_revision: "e.envelope_revision", envelope_version: "e.envelope_version",
  key_id: "e.key_id", nonce: "e.nonce", ciphertext: "e.ciphertext",
} as const;
interface SourceRow {
  profile_id: string; adapter_type: string; physical_namespace_json: string; namespace_sha256: string;
  latest_revision: number; profile_created_at: string; revision: number | null; namespace_json: string | null;
  credential_ref: string | null; label: string | null; configuration_created_at: string | null; configuration_created_by: string | null;
  descriptor_ref: string | null; descriptor_profile_id: string | null; descriptor_revision: number | null;
  descriptor_namespace_sha256: string | null; descriptor_created_at: string | null;
  payload_ref: string | null; envelope_revision: number | null; envelope_version: number | null;
  key_id: string | null; nonce: string | null; ciphertext: string | null;
}
const SOURCE_SELECT = `SELECT ${Object.entries(SOURCE_COLUMNS).map(([key, column]) => `${column} AS ${key}`).join(",")}
  FROM system_storage_profiles p
  LEFT JOIN system_storage_configuration_revisions r ON r.profile_id=p.id AND r.revision=p.latest_revision
  LEFT JOIN system_storage_credential_descriptors d ON d.credential_ref=r.credential_ref
    AND d.profile_id=r.profile_id AND d.configuration_revision=r.revision AND d.namespace_sha256=p.namespace_sha256
  LEFT JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref
  WHERE p.id=?`;
interface EvidenceRow {
  current_count: number; historical_count: number; in_progress_count: number; cleanup_count: number;
  exact_check_id: string | null; exact_completed_at: string | null;
}
async function credentialStatus(env: ReadinessEnvironment, source: SourceRow): Promise<StorageCandidateReadiness["credential"]["status"]> {
  try {
    const ring = await parseStorageCredentialKeyring(env.STORAGE_CREDENTIAL_KEYRING);
    const opened = await decryptStorageCredential(ring, { profileId: source.profile_id, configurationRevision: source.revision!,
      credentialRef: source.credential_ref!, namespaceSha256: source.namespace_sha256 },
    { version: source.envelope_version, keyId: source.key_id, nonce: source.nonce, ciphertext: source.ciphertext });
    return opened.outcome === "available" ? source.key_id === ring.currentKeyId ? "current" : "needs_reenvelope" : "unavailable";
  } catch { return "unavailable"; }
}

/** Read-only primary observation. Hashing and envelope authentication happen
 * between two reads; the final atomic aggregation rejects any changed source.
 * Expired executions stay visible and are never reconciled by this reader. */
export async function readStorageCandidateReadiness(env: ReadinessEnvironment, rawInput: unknown,
  actor: string): Promise<StorageCandidateReadiness> {
  assertSystemAdministrator(env, actor);
  let input: StorageCandidateReadinessInput;
  try { input = checkedStorageCandidateReadinessInput(rawInput); }
  catch { throw new StorageCandidateReadinessError(400, "Invalid storage candidate readiness."); }
  try {
    const source = await primaryD1(env.DB).prepare(SOURCE_SELECT).bind(input.profileId).first<SourceRow>();
    if (!source) throw new StorageCandidateReadinessError(404, "Storage candidate was not found.");
    if (source.latest_revision !== input.expectedRevision) throw conflict();
    if (source.revision !== input.expectedRevision || source.descriptor_ref !== source.credential_ref
      || !source.credential_ref || !source.descriptor_ref || !source.namespace_json) throw unavailable();
    // Candidate checks hash the complete configuration, including S3 transport
    // settings. The physical namespace digest deliberately omits those settings.
    const configurationBytes = new TextEncoder().encode(JSON.stringify(JSON.parse(source.namespace_json)));
    const configurationSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", configurationBytes)),
      value => value.toString(16).padStart(2, "0")).join("");
    const status = await credentialStatus(env, source);
    const guard = Object.values(SOURCE_COLUMNS).map(column => `${column} IS ?`).join(" AND ");
    // A session only pins its first query to primary. Open a new primary
    // session for this final snapshot instead of relying on session reuse.
    const result = await primaryD1(env.DB).prepare(`WITH source AS (${SOURCE_SELECT} AND ${guard}),
      classified AS (
        SELECT c.*,
          (c.configuration_revision=s.revision AND c.credential_ref=s.credential_ref
            AND c.namespace_json=s.namespace_json AND c.namespace_sha256=s.namespace_sha256
            AND c.configuration_sha256=?) AS same_configuration,
          (c.envelope_revision IS s.envelope_revision AND c.envelope_version IS s.envelope_version
            AND c.key_id IS s.key_id AND c.nonce IS s.nonce AND c.ciphertext IS s.ciphertext) AS same_envelope,
          (c.status='succeeded' AND c.write_outcome='acknowledged' AND c.read_outcome='verified'
            AND c.metadata_outcome='verified' AND c.delete_outcome='acknowledged'
            AND c.cleanup_outcome='confirmed_absent' AND c.result_code IS NULL AND c.completed_at IS NOT NULL) AS succeeded
        FROM system_storage_candidate_checks c JOIN source s ON c.profile_id=s.profile_id
      ), counts AS (
        SELECT count(CASE WHEN succeeded AND same_configuration THEN 1 END) AS current_count,
          count(CASE WHEN succeeded AND NOT same_configuration THEN 1 END) AS historical_count,
          count(CASE WHEN status='running' OR cleanup_outcome='running' THEN 1 END) AS in_progress_count,
          count(CASE WHEN cleanup_outcome<>'confirmed_absent' THEN 1 END) AS cleanup_count FROM classified
      ), latest_exact AS (
        SELECT id,completed_at FROM classified WHERE succeeded AND same_configuration AND same_envelope
        ORDER BY completed_at DESC,id DESC LIMIT 1
      ) SELECT counts.*,latest_exact.id AS exact_check_id,latest_exact.completed_at AS exact_completed_at
        FROM source CROSS JOIN counts LEFT JOIN latest_exact ON 1=1`)
      .bind(input.profileId, ...Object.keys(SOURCE_COLUMNS).map(key => source[key as keyof SourceRow]), configurationSha256)
      .first<EvidenceRow>();
    if (!result) throw conflict();
    return checkedStorageCandidateReadiness({ profileId: input.profileId, revision: input.expectedRevision,
      observedAt: new Date().toISOString(), credential: { envelopeRevision: source.envelope_revision, status },
      evidence: { currentConfigurationSuccessCount: result.current_count, historicalConfigurationSuccessCount: result.historical_count,
        exactCurrentContextSuccess: result.exact_check_id === null ? null : { checkId: result.exact_check_id, completedAt: result.exact_completed_at },
        inProgressCount: result.in_progress_count, unresolvedCleanupCount: result.cleanup_count }, canActivate: false });
  } catch (error) {
    if (error instanceof StorageCandidateReadinessError) throw error;
    throw unavailable();
  }
}

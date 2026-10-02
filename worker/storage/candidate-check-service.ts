import {
  checkedStartStorageCandidateCheckInput, checkedStorageCandidateCheckId, checkedStorageCandidateCheckProfileId,
  MAX_STORAGE_CANDIDATE_CHECKS, StorageCandidateCheckInputError,
  type StartStorageCandidateCheckInput, type StorageCandidateCheck, type StorageCandidateCheckCode,
  type StorageCandidateCheckList, type StorageCandidateCheckStage,
} from "../../shared/contracts/storage-candidate-check";
import { checkedSaveStorageCandidateInput, type S3StorageCredentials, type S3StorageNamespace } from "../../shared/contracts/storage-configuration";
import type { Env } from "../types";
import { ByteVerificationError, type Sha256Factory } from "../files/byte-verification";
import { writeVerifiedBytes } from "../files/byte-writer";
import { cloudflareSha256 } from "../files/storage-adapters/cloudflare-sha256";
import { decryptStorageCredential, parseStorageCredentialKeyring } from "./credential-envelope";
import { s3ByteAdapter, type S3ByteAdapter } from "./s3-byte-adapter";
import { assertSystemAdministrator } from "./system-administrator";

type CheckEnvironment = Pick<Env, "DB" | "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS" | "STORAGE_CREDENTIAL_KEYRING">;
export interface StorageCandidateCheckOptions {
  fetch?: (request: Request) => Promise<Response>;
  now?: () => Date;
  createHash?: Sha256Factory;
  /** Test injection may shorten, but never extend, the production lease. */
  timeoutMs?: number;
}
export class StorageCandidateCheckError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); this.name = "StorageCandidateCheckError"; }
}
const unavailable = () => new StorageCandidateCheckError(503, "Storage candidate checks are temporarily unavailable.");
const conflict = () => new StorageCandidateCheckError(409, "Storage candidate changed or check identity was already used. Refresh and try again.");
const missing = () => new StorageCandidateCheckError(404, "Storage candidate check was not found.");
const invalid = () => new StorageCandidateCheckError(400, "Invalid storage candidate check.");
const encoder = new TextEncoder();
const PAYLOAD_SIZE = 1024, LEASE_MS = 30_000;
interface ConfigurationRow {
  profile_id: string; revision: number; namespace_json: string; namespace_sha256: string; credential_ref: string;
  envelope_revision: number; envelope_version: 1; key_id: string; nonce: string; ciphertext: string;
}
interface CheckRow {
  id: string; profile_id: string; configuration_revision: number; credential_ref: string; envelope_revision: number;
  namespace_json: string; namespace_sha256: string; configuration_sha256: string;
  envelope_version: 1; key_id: string; nonce: string; ciphertext: string;
  probe_key: string; payload_sha256: string; payload_size: number; requested_by: string; created_at: string;
  execution_token: string; execution_deadline: string; execution_actor: string; execution_kind: "check" | "cleanup";
  status: "running" | "succeeded" | "failed" | "interrupted";
  write_outcome: "pending" | "unknown" | "acknowledged";
  read_outcome: "pending" | "verified" | "failed";
  metadata_outcome: "pending" | "verified" | "failed";
  delete_outcome: "pending" | "acknowledged" | "failed";
  cleanup_outcome: "pending" | "running" | "required" | "confirmed_absent" | "absence_observed";
  result_code: StorageCandidateCheckCode | null; updated_at: string; completed_at: string | null;
}
type Patch = Partial<Pick<CheckRow, "status" | "write_outcome" | "read_outcome" | "metadata_outcome" | "delete_outcome"
  | "cleanup_outcome" | "result_code" | "completed_at">>;
const CONFIGURATION_SELECT = `SELECT r.profile_id,r.revision,r.namespace_json,p.namespace_sha256,r.credential_ref,
  e.envelope_revision,e.envelope_version,e.key_id,e.nonce,e.ciphertext
  FROM system_storage_profiles p JOIN system_storage_configuration_revisions r ON r.profile_id=p.id AND r.revision=p.latest_revision
  JOIN system_storage_credential_payloads e ON e.credential_ref=r.credential_ref WHERE p.id=?`;
function view(row: CheckRow): StorageCandidateCheck {
  const stage = (value: string): StorageCandidateCheckStage => value === "acknowledged" || value === "verified" ? "passed"
    : value === "pending" ? row.status === "running" ? "pending" : "not_run" : value as StorageCandidateCheckStage;
  return { id: row.id, profileId: row.profile_id, revision: row.configuration_revision, status: row.status,
    write: stage(row.write_outcome), read: stage(row.read_outcome), metadata: stage(row.metadata_outcome), delete: stage(row.delete_outcome),
    cleanup: row.cleanup_outcome, code: row.result_code, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at };
}
function checked<T>(fn: () => T): T {
  try { return fn(); } catch (error) { if (error instanceof StorageCandidateCheckInputError) throw invalid(); throw unavailable(); }
}
function settings(options: StorageCandidateCheckOptions) {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs === undefined ? LEASE_MS : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LEASE_MS) throw unavailable();
  return { now, timeoutMs, createHash: options.createHash ?? cloudflareSha256, fetch: options.fetch ?? ((request: Request) => fetch(request)) };
}
async function digest(value: ArrayBuffer | string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value);
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function getRow(env: CheckEnvironment, id: string): Promise<CheckRow | null> {
  try { return await env.DB.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").bind(id).first<CheckRow>(); }
  catch { throw unavailable(); }
}
/** Reads reconcile expired leases only. They never contact or replay a provider. */
async function reconcile(env: CheckEnvironment, now: string, id?: string, profileId?: string): Promise<void> {
  try {
    await env.DB.prepare(`UPDATE system_storage_candidate_checks SET
      status=CASE WHEN status='running' THEN 'interrupted' ELSE status END,
      cleanup_outcome=CASE WHEN cleanup_outcome IN ('confirmed_absent','absence_observed') THEN cleanup_outcome
        WHEN write_outcome='pending' AND cleanup_outcome<>'running' THEN 'confirmed_absent' ELSE 'required' END,
      result_code='execution_interrupted',
      completed_at=COALESCE(completed_at,?),updated_at=?
      WHERE execution_deadline<=? AND (status='running' OR cleanup_outcome='running')${id ? " AND id=?" : profileId ? " AND profile_id=?" : ""}`)
      .bind(now, now, now, ...(id ? [id] : profileId ? [profileId] : [])).run();
  } catch { throw unavailable(); }
}
async function capturedAdapter(env: CheckEnvironment, row: CheckRow, options: { fetch: (request: Request) => Promise<Response>; now: () => Date }): Promise<S3ByteAdapter | null> {
  try {
    const ring = await parseStorageCredentialKeyring(env.STORAGE_CREDENTIAL_KEYRING);
    const opened = await decryptStorageCredential(ring, { profileId: row.profile_id, configurationRevision: row.configuration_revision,
      credentialRef: row.credential_ref, namespaceSha256: row.namespace_sha256 },
    { version: row.envelope_version, keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext });
    if (opened.outcome !== "available") return null;
    const namespace = JSON.parse(row.namespace_json) as S3StorageNamespace;
    if (await digest(JSON.stringify(namespace)) !== row.configuration_sha256) return null;
    const checked = checkedSaveStorageCandidateInput({ expectedRevision: null, label: "Candidate check", namespace,
      credentials: { mode: "replace", value: JSON.parse(opened.plaintext) } });
    if (checked.namespace.kind !== "s3" || checked.credentials.mode !== "replace" || !("accessKeyId" in checked.credentials.value)) return null;
    return s3ByteAdapter(checked.namespace, checked.credentials.value as S3StorageCredentials, options);
  } catch { return null; }
}
class LeaseStopped extends Error {}

/** The database fence is checked before each request and each publication.
 * Abort reaches the fetch response body as well as the upload. A separate
 * bounded race handles a provider that ignores cancellation; such a PUT stays
 * unknown, and a late continuation cannot start another request or publish. */
async function execute(env: CheckEnvironment, accepted: CheckRow, payload: ArrayBuffer | null, options: StorageCandidateCheckOptions): Promise<StorageCandidateCheck> {
  const config = settings(options), abort = new AbortController();
  let row = accepted, stopped = false, databaseFailed = false;
  const stamp = () => config.now().toISOString();
  const owns = (value: CheckRow | null, time: string) => !!value && value.execution_token === accepted.execution_token
    && value.execution_kind === accepted.execution_kind && value.execution_deadline > time
    && (accepted.execution_kind === "check" ? value.status === "running" : value.status !== "running" && value.cleanup_outcome === "running");
  async function guard() {
    if (stopped || stamp() >= accepted.execution_deadline) { stopped = true; abort.abort(); throw new LeaseStopped(); }
    let current: CheckRow | null;
    try { current = await getRow(env, row.id); } catch { databaseFailed = true; stopped = true; abort.abort(); throw unavailable(); }
    if (!owns(current, stamp())) { stopped = true; abort.abort(); throw new LeaseStopped(); }
  }
  async function publish(patch: Patch) {
    if (stopped) throw new LeaseStopped();
    const time = stamp();
    if (time >= accepted.execution_deadline) { stopped = true; abort.abort(); throw new LeaseStopped(); }
    const entries = Object.entries(patch);
    let changed;
    try {
      changed = await env.DB.prepare(`UPDATE system_storage_candidate_checks SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=?
        WHERE id=? AND execution_token=? AND execution_kind=? AND execution_deadline>? AND ${accepted.execution_kind === "check" ? "status='running'" : "status<>'running' AND cleanup_outcome='running'"}`)
        .bind(...entries.map(([, value]) => value), time, accepted.id, accepted.execution_token, accepted.execution_kind, time).run();
    } catch { databaseFailed = true; stopped = true; abort.abort(); throw unavailable(); }
    if (!changed.meta.changes) { stopped = true; abort.abort(); throw new LeaseStopped(); }
    row = { ...row, ...patch, updated_at: time };
  }
  async function remove(adapter: S3ByteAdapter): Promise<boolean> {
    const deletion = await adapter.deleter.delete(row.probe_key);
    await publish({ delete_outcome: deletion.outcome === "acknowledged" ? "acknowledged" : "failed" });
    const absent = await adapter.reader.stat(row.probe_key);
    const observed = absent.outcome === "missing";
    const confirmed = observed && deletion.outcome === "acknowledged" && row.write_outcome !== "unknown";
    await publish({ cleanup_outcome: confirmed ? "confirmed_absent" : observed ? "absence_observed" : "required" });
    return confirmed;
  }
  const guardedFetch = async (request: Request): Promise<Response> => {
    await guard();
    const signal = AbortSignal.any([abort.signal, request.signal]);
    return config.fetch(new Request(request, { signal }));
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { stopped = true; abort.abort(); reject(new LeaseStopped()); }, Math.max(1, Date.parse(accepted.execution_deadline) - config.now().getTime()));
  });
  const work = (async () => {
    const adapter = await capturedAdapter(env, row, { fetch: guardedFetch, now: config.now });
    if (!adapter) {
      await publish(accepted.execution_kind === "check"
        ? { status: "failed", cleanup_outcome: "confirmed_absent", result_code: "credential_unavailable", completed_at: stamp() }
        : { cleanup_outcome: "required" });
      return;
    }
    if (accepted.execution_kind === "cleanup") { await remove(adapter); return; }
    let code: StorageCandidateCheckCode | null = null;
    try {
      const writer = { accepts: adapter.writer.accepts, async write(input: Parameters<typeof adapter.writer.write>[0]) {
        // A failure after entering PUT is uncertain even if fetch rejects.
        await publish({ write_outcome: "unknown" });
        await adapter.writer.write(input);
        await publish({ write_outcome: "acknowledged" });
      } };
      await writeVerifiedBytes({ reader: adapter.reader, writer, createHash: config.createHash },
        { key: row.probe_key, body: payload!, byteSize: row.payload_size, sha256: row.payload_sha256,
          contentType: "application/octet-stream", filename: "storage-candidate-check" });
      await publish({ read_outcome: "verified" });
      const metadata = await adapter.reader.stat(row.probe_key);
      if (metadata.outcome !== "available" || metadata.byteSize !== row.payload_size) {
        await publish({ metadata_outcome: "failed" }); code = "metadata_verification_failed";
      } else await publish({ metadata_outcome: "verified" });
    } catch (error) {
      if (databaseFailed || stopped) throw error;
      if (row.write_outcome === "acknowledged") {
        await publish({ read_outcome: "failed" });
        code = error instanceof ByteVerificationError ? "read_verification_failed" : "provider_unavailable";
      } else code = "provider_unavailable";
    }
    const clean = await remove(adapter);
    code ??= clean ? null : "cleanup_unconfirmed";
    await publish({ status: code === null ? "succeeded" : "failed", result_code: code, completed_at: stamp() });
  })();
  // Retain rejection handling after an expired race; no detached continuation
  // can publish because it has the same stopped flag and stale lease token.
  void work.catch(() => undefined);
  try { await Promise.race([work, expired]); }
  catch (error) {
    if (databaseFailed) throw unavailable();
    if (!(error instanceof LeaseStopped) && !stopped) throw unavailable();
    await reconcile(env, new Date(Math.max(config.now().getTime(), Date.parse(accepted.execution_deadline))).toISOString(), accepted.id);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    abort.abort(); if (payload) new Uint8Array(payload).fill(0);
  }
  const result = await getRow(env, accepted.id);
  if (!result) throw unavailable();
  return view(result);
}

export async function startStorageCandidateCheck(env: CheckEnvironment, raw: unknown, actor: string, options: StorageCandidateCheckOptions = {}): Promise<StorageCandidateCheck> {
  assertSystemAdministrator(env, actor);
  const input: StartStorageCandidateCheckInput = checked(() => checkedStartStorageCandidateCheckInput(raw)), config = settings(options);
  await reconcile(env, config.now().toISOString(), input.checkId);
  const existing = await getRow(env, input.checkId);
  if (existing) {
    if (existing.profile_id !== input.profileId || existing.configuration_revision !== input.expectedRevision) throw conflict();
    return view(existing);
  }
  await reconcile(env, config.now().toISOString(), undefined, input.profileId);
  let source: ConfigurationRow | null;
  try { source = await env.DB.prepare(CONFIGURATION_SELECT).bind(input.profileId).first<ConfigurationRow>(); }
  catch { throw unavailable(); }
  if (!source || source.revision !== input.expectedRevision) throw conflict();
  let namespace: S3StorageNamespace;
  try { namespace = JSON.parse(source.namespace_json); } catch { throw unavailable(); }
  if (namespace.kind !== "s3") throw new StorageCandidateCheckError(400, "This storage provider does not support candidate checks yet.");
  const payload = crypto.getRandomValues(new Uint8Array(PAYLOAD_SIZE)).buffer;
  const now = config.now().toISOString(), token = crypto.randomUUID(), deadline = new Date(config.now().getTime() + config.timeoutMs).toISOString();
  const row: CheckRow = { id: input.checkId, profile_id: input.profileId, configuration_revision: input.expectedRevision,
    credential_ref: source.credential_ref, envelope_revision: source.envelope_revision, namespace_json: source.namespace_json,
    namespace_sha256: source.namespace_sha256, configuration_sha256: await digest(JSON.stringify(namespace)), envelope_version: source.envelope_version,
    key_id: source.key_id, nonce: source.nonce, ciphertext: source.ciphertext, probe_key: `__fp2_checks/${input.checkId}/${crypto.randomUUID()}`,
    payload_sha256: await digest(payload), payload_size: PAYLOAD_SIZE, requested_by: actor, created_at: now,
    execution_token: token, execution_deadline: deadline, execution_actor: actor, execution_kind: "check", status: "running",
    write_outcome: "pending", read_outcome: "pending", metadata_outcome: "pending", delete_outcome: "pending", cleanup_outcome: "pending",
    result_code: null, updated_at: now, completed_at: null };
  const entries = Object.entries(row);
  try {
    // The final INSERT SELECT CAS runs inside the transaction, after hashing.
    // It checks the current revision and every envelope field, not just a ref.
    const result = await env.DB.prepare(`INSERT INTO system_storage_candidate_checks (${entries.map(([key]) => key).join(",")})
      SELECT ${entries.map(() => "?").join(",")} WHERE EXISTS (
        SELECT 1 FROM system_storage_profiles p JOIN system_storage_configuration_revisions r ON r.profile_id=p.id AND r.revision=p.latest_revision
        JOIN system_storage_credential_payloads e ON e.credential_ref=r.credential_ref
        WHERE p.id=? AND r.revision=? AND r.namespace_json=? AND p.namespace_sha256=? AND r.credential_ref=?
          AND e.envelope_revision=? AND e.envelope_version=? AND e.key_id=? AND e.nonce=? AND e.ciphertext=?)`)
      .bind(...entries.map(([, value]) => value), row.profile_id, row.configuration_revision, row.namespace_json, row.namespace_sha256, row.credential_ref,
        row.envelope_revision, row.envelope_version, row.key_id, row.nonce, row.ciphertext).run();
    if (!result.meta.changes) throw conflict();
  } catch (error) {
    new Uint8Array(payload).fill(0);
    // Concurrent same-ID acceptance is idempotent, including response loss.
    const won = await getRow(env, input.checkId);
    if (won) {
      if (won.profile_id !== input.profileId || won.configuration_revision !== input.expectedRevision) throw conflict();
      return view(won);
    }
    if (error instanceof StorageCandidateCheckError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("FP2 storage check acceptance conflict") || message.includes("UNIQUE constraint failed: system_storage_candidate_checks.profile_id")) throw conflict();
    throw unavailable();
  }
  return execute(env, row, payload, options);
}

export async function readStorageCandidateCheck(env: CheckEnvironment, rawId: unknown, actor: string, options: StorageCandidateCheckOptions = {}): Promise<StorageCandidateCheck> {
  assertSystemAdministrator(env, actor);
  const id = checked(() => checkedStorageCandidateCheckId(rawId)), config = settings(options);
  await reconcile(env, config.now().toISOString(), id);
  const row = await getRow(env, id); if (!row) throw missing();
  return view(row);
}
export async function listStorageCandidateChecks(env: CheckEnvironment, rawProfileId: unknown, actor: string, options: StorageCandidateCheckOptions = {}): Promise<StorageCandidateCheckList> {
  assertSystemAdministrator(env, actor);
  const profileId = checked(() => checkedStorageCandidateCheckProfileId(rawProfileId)), config = settings(options);
  await reconcile(env, config.now().toISOString(), undefined, profileId);
  try {
    const rows = await env.DB.prepare("SELECT * FROM system_storage_candidate_checks WHERE profile_id=? ORDER BY created_at DESC,id LIMIT ?")
      .bind(profileId, MAX_STORAGE_CANDIDATE_CHECKS + 1).all<CheckRow>();
    return { items: rows.results.slice(0, MAX_STORAGE_CANDIDATE_CHECKS).map(view), hasMore: rows.results.length > MAX_STORAGE_CANDIDATE_CHECKS };
  } catch { throw unavailable(); }
}
export async function cleanupStorageCandidateCheck(env: CheckEnvironment, rawId: unknown, actor: string, options: StorageCandidateCheckOptions = {}): Promise<StorageCandidateCheck> {
  assertSystemAdministrator(env, actor);
  const id = checked(() => checkedStorageCandidateCheckId(rawId)), config = settings(options);
  await reconcile(env, config.now().toISOString(), id);
  const previous = await getRow(env, id); if (!previous) throw missing();
  if (previous.status === "running") throw new StorageCandidateCheckError(409, "Storage candidate check is still running.");
  if (previous.cleanup_outcome === "confirmed_absent" || previous.cleanup_outcome === "running") return view(previous);
  await reconcile(env, config.now().toISOString(), undefined, previous.profile_id);
  const time = config.now().toISOString(), token = crypto.randomUUID(), deadline = new Date(config.now().getTime() + config.timeoutMs).toISOString();
  try {
    const result = await env.DB.prepare(`UPDATE system_storage_candidate_checks SET execution_token=?,execution_deadline=?,execution_actor=?,execution_kind='cleanup',cleanup_outcome='running',updated_at=?
      WHERE id=? AND execution_token=? AND status<>'running' AND cleanup_outcome NOT IN ('running','confirmed_absent')`)
      .bind(token, deadline, actor, time, id, previous.execution_token).run();
    if (!result.meta.changes) { const current = await getRow(env, id); if (!current) throw unavailable(); return view(current); }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint failed: system_storage_candidate_checks.profile_id")) throw new StorageCandidateCheckError(409, "Another storage candidate check or cleanup is still running.");
    throw unavailable();
  }
  return execute(env, { ...previous, execution_token: token, execution_deadline: deadline, execution_actor: actor,
    execution_kind: "cleanup", cleanup_outcome: "running", updated_at: time }, null, options);
}

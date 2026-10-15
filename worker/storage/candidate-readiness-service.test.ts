import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { saveStorageCandidate } from "./configuration-registry";
import { readStorageCandidateReadiness, StorageCandidateReadinessError } from "./candidate-readiness-service";
import { reenvelopeStoredStorageCredential } from "./credential-reenvelope-service";

const actor = "admin@example.test";
const material = (value: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(value)));
const oldRing = JSON.stringify({ version: 1, currentKeyId: "old", keys: { old: material(13) } });
const rotatedRing = JSON.stringify({ version: 1, currentKeyId: "current", keys: { old: material(13), current: material(29) } });
const input: SaveStorageCandidateInput = { expectedRevision: null, label: "Readiness fixture",
  namespace: { kind: "s3", endpoint: "https://objects.example.test", bucket: "fixture-bucket", region: "auto", root: "research", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "private-access", secretAccessKey: "private-secret" } } };
const databases: DatabaseSync[] = [];
async function fixture() {
  const sql = new DatabaseSync(":memory:"); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  for (const name of ["0014_fp2_storage_configuration.sql", "0015_fp2_storage_candidate_checks.sql", "0016_fp2_credential_reenvelopes.sql"])
    sql.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const db = new SqliteD1Database(sql), env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor, STORAGE_CREDENTIAL_KEYRING: oldRing } as Env;
  const saved = await saveStorageCandidate(env, input, actor);
  const query = { profileId: saved.profileId, expectedRevision: 1 };
  const sessions: { prepare: ReturnType<typeof vi.fn> }[] = [];
  const withSession = vi.fn(() => { const session = { prepare: vi.fn((statement: string) => db.prepare(statement)) }; sessions.push(session); return session; });
  const directPrepare = vi.fn(() => { throw new Error("A primary session is required"); });
  const read = (overrides = {}) => readStorageCandidateReadiness({ ...env,
    DB: { withSession, prepare: directPrepare } as unknown as D1Database }, { ...query, ...overrides }, actor);
  let checkCount = 0;
  const check = async (state: "succeeded" | "running" | "cleanup" | "failed" = "succeeded") => {
    const source = sql.prepare(`SELECT r.*,p.namespace_sha256,e.* FROM system_storage_profiles p
      JOIN system_storage_configuration_revisions r ON r.profile_id=p.id AND r.revision=p.latest_revision
      JOIN system_storage_credential_payloads e ON e.credential_ref=r.credential_ref WHERE p.id=?`).get(saved.profileId)!;
    const created = new Date(Date.parse("2020-01-01T00:00:00.000Z") + checkCount++ * 1000).toISOString();
    const completed = new Date(Date.parse(created) + 1).toISOString();
    const deadline = new Date(Date.parse(created) + 30000).toISOString(), id = crypto.randomUUID();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(JSON.parse(source.namespace_json as string))))),
      byte => byte.toString(16).padStart(2, "0")).join("");
    const row = { id, profile_id: saved.profileId, configuration_revision: source.revision, credential_ref: source.credential_ref,
      envelope_revision: source.envelope_revision, namespace_json: source.namespace_json, namespace_sha256: source.namespace_sha256,
      configuration_sha256: hash, envelope_version: source.envelope_version, key_id: source.key_id, nonce: source.nonce, ciphertext: source.ciphertext,
      probe_key: `__fp2_checks/${id}/fixture`, payload_sha256: "a".repeat(64), payload_size: 1024, requested_by: actor, created_at: created,
      execution_kind: "check", execution_token: crypto.randomUUID(), execution_deadline: deadline, execution_actor: actor,
      status: "running", write_outcome: "pending", read_outcome: "pending", metadata_outcome: "pending", delete_outcome: "pending",
      cleanup_outcome: "pending", result_code: null, updated_at: created, completed_at: null };
    sql.prepare(`INSERT INTO system_storage_candidate_checks (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    if (state !== "running") {
      sql.prepare("UPDATE system_storage_candidate_checks SET write_outcome='unknown' WHERE id=?").run(id);
      sql.prepare(`UPDATE system_storage_candidate_checks SET status=?,write_outcome='acknowledged',read_outcome='verified',metadata_outcome='verified',
        delete_outcome=?,cleanup_outcome=?,result_code=?,updated_at=?,completed_at=? WHERE id=?`)
        .run(state === "succeeded" ? "succeeded" : "failed", state === "succeeded" ? "acknowledged" : "failed",
          state === "succeeded" ? "confirmed_absent" : "absence_observed", state === "succeeded" ? null : "cleanup_unconfirmed", completed, completed, id);
      if (state === "cleanup") sql.prepare(`UPDATE system_storage_candidate_checks SET cleanup_outcome='running',execution_kind='cleanup',execution_token=? WHERE id=?`).run(crypto.randomUUID(), id);
    }
    return { id, completed, row };
  };
  const rotate = () => reenvelopeStoredStorageCredential(env, { operationId: crypto.randomUUID(), profileId: saved.profileId, revision: 1,
    credentialRef: saved.credentials.ref, expectedEnvelopeRevision: 1 }, actor);
  const payload = () => sql.prepare("SELECT * FROM system_storage_credential_payloads WHERE credential_ref=?").get(saved.credentials.ref)!;
  return { sql, db, env, saved, query, read, check, rotate, payload, withSession, sessions, directPrepare };
}
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(sql => sql.close()); });

describe("read-only candidate readiness", () => {
  it("uses two distinct primary-first sessions and emits safe empty evidence without provider or database writes", async () => {
    const f = await fixture(), before = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider access forbidden"));
    const result = await f.read();
    expect(result).toMatchObject({ profileId: f.saved.profileId, revision: 1, credential: { envelopeRevision: 1, status: "current" },
      evidence: { currentConfigurationSuccessCount: 0, historicalConfigurationSuccessCount: 0, exactCurrentContextSuccess: null,
        inProgressCount: 0, unresolvedCleanupCount: 0 }, canActivate: false });
    expect(new Date(result.observedAt).toISOString()).toBe(result.observedAt);
    expect(f.withSession.mock.calls).toEqual([["first-primary"], ["first-primary"]]);
    expect(f.sessions).toHaveLength(2); for (const session of f.sessions) expect(session.prepare).toHaveBeenCalledTimes(1);
    expect(f.directPrepare).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    for (const secret of ["private-access", "private-secret", "credential_ref", "namespace_sha256", "key_id", "nonce", "ciphertext", "objects.example.test"])
      expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("preserves same-configuration history after re-envelope and does not inherit it across new revisions", async () => {
    const f = await fixture(), first = await f.check();
    expect((await f.read()).evidence).toMatchObject({ currentConfigurationSuccessCount: 1,
      exactCurrentContextSuccess: { checkId: first.id, completedAt: first.completed } });
    f.env.STORAGE_CREDENTIAL_KEYRING = rotatedRing;
    expect((await f.read()).credential.status).toBe("needs_reenvelope");
    await f.rotate();
    expect(await f.read()).toMatchObject({ credential: { envelopeRevision: 2, status: "current" },
      evidence: { currentConfigurationSuccessCount: 1, historicalConfigurationSuccessCount: 0, exactCurrentContextSuccess: null } });
    const second = await f.check();
    expect((await f.read()).evidence.exactCurrentContextSuccess?.checkId).toBe(second.id);
    await saveStorageCandidate(f.env, { ...input, profileId: f.saved.profileId, expectedRevision: 1, credentials: { mode: "retain" } }, actor);
    await expect(f.read()).rejects.toMatchObject({ status: 409 });
    expect(await f.read({ expectedRevision: 2 })).toMatchObject({ revision: 2, credential: { envelopeRevision: 1, status: "current" },
      evidence: { currentConfigurationSuccessCount: 0, historicalConfigurationSuccessCount: 2, exactCurrentContextSuccess: null } });
  });

  it("retains exact proof for authenticated already-current receipts and unavailable deployment keys", async () => {
    const f = await fixture(), first = await f.check(), before = f.payload();
    expect(await f.rotate()).toMatchObject({ outcome: "already_current" }); expect(f.payload()).toEqual(before);
    expect((await f.read()).evidence.exactCurrentContextSuccess?.checkId).toBe(first.id);
    for (const ring of [undefined, "invalid", JSON.stringify({ version: 1, currentKeyId: "other", keys: { other: material(3) } })]) {
      f.env.STORAGE_CREDENTIAL_KEYRING = ring;
      expect(await f.read()).toMatchObject({ credential: { envelopeRevision: 1, status: "unavailable" },
        evidence: { exactCurrentContextSuccess: { checkId: first.id } }, canActivate: false });
    }
  });

  it("authenticates payload bytes and AAD instead of inferring availability from the key ID", async () => {
    const f = await fixture();
    f.sql.exec("UPDATE system_storage_credential_payloads SET envelope_revision=2,ciphertext=substr(ciphertext,1,20)||'AAAA'||substr(ciphertext,25)");
    expect((await f.read()).credential).toEqual({ envelopeRevision: 2, status: "unavailable" });
    const other = await saveStorageCandidate(f.env, { ...input, namespace: { ...input.namespace, root: "other" } }, actor);
    const swapped = f.sql.prepare("SELECT * FROM system_storage_credential_payloads WHERE credential_ref=?").get(other.credentials.ref)!;
    f.sql.prepare("UPDATE system_storage_credential_payloads SET envelope_revision=3,nonce=?,ciphertext=? WHERE credential_ref=?")
      .run(swapped.nonce, swapped.ciphertext, f.saved.credentials.ref);
    expect((await f.read()).credential).toEqual({ envelopeRevision: 3, status: "unavailable" });
    f.sql.exec("DROP TRIGGER system_storage_credential_payloads_delete_guard");
    f.sql.prepare("DELETE FROM system_storage_credential_payloads WHERE credential_ref=?").run(f.saved.credentials.ref);
    expect((await f.read()).credential).toEqual({ envelopeRevision: null, status: "unavailable" });
  });

  it("aggregates all history beyond the display page and leaves expired executions and cleanup untouched", async () => {
    const f = await fixture(); let latest;
    for (let index = 0; index < 61; index++) latest = await f.check();
    await f.check("failed"); const running = await f.check("running");
    const before = f.sql.prepare("SELECT * FROM system_storage_candidate_checks ORDER BY id").all();
    expect((await f.read()).evidence).toEqual({ currentConfigurationSuccessCount: 61, historicalConfigurationSuccessCount: 0,
      exactCurrentContextSuccess: { checkId: latest!.id, completedAt: latest!.completed }, inProgressCount: 1, unresolvedCleanupCount: 2 });
    expect(f.sql.prepare("SELECT * FROM system_storage_candidate_checks ORDER BY id").all()).toEqual(before);
    f.sql.prepare(`UPDATE system_storage_candidate_checks SET status='interrupted',cleanup_outcome='confirmed_absent',result_code='execution_interrupted',completed_at=?,updated_at=? WHERE id=?`)
      .run(running.completed, running.completed, running.id);
    await f.check("cleanup");
    const cleanupBefore = f.sql.prepare("SELECT * FROM system_storage_candidate_checks ORDER BY id").all();
    expect((await f.read()).evidence).toMatchObject({ inProgressCount: 1, unresolvedCleanupCount: 2 });
    expect(f.sql.prepare("SELECT * FROM system_storage_candidate_checks ORDER BY id").all()).toEqual(cleanupBefore);
  });

  it("requires the complete configuration tuple and all successful terminal stages", async () => {
    const f = await fixture(); const good = await f.check();
    f.sql.exec("DROP TRIGGER system_storage_candidate_checks_update_guard; PRAGMA ignore_check_constraints=ON");
    const changes: Record<string, string | number | null> = { configuration_sha256: "b".repeat(64), namespace_json: ` ${good.row.namespace_json}`,
      namespace_sha256: "c".repeat(64), write_outcome: "pending", read_outcome: "failed", metadata_outcome: "failed", delete_outcome: "failed",
      cleanup_outcome: "absence_observed", result_code: "provider_unavailable", status: "failed", completed_at: null };
    const original = f.sql.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").get(good.id)!;
    for (const [field, value] of Object.entries(changes)) {
      f.sql.prepare(`UPDATE system_storage_candidate_checks SET ${field}=? WHERE id=?`).run(value, good.id);
      const evidence = (await f.read()).evidence;
      expect(evidence.exactCurrentContextSuccess, field).toBeNull(); expect(evidence.currentConfigurationSuccessCount, field).toBe(0);
      expect(evidence.historicalConfigurationSuccessCount, field).toBe(["configuration_sha256", "namespace_json", "namespace_sha256"].includes(field) ? 1 : 0);
      f.sql.prepare(`UPDATE system_storage_candidate_checks SET ${field}=? WHERE id=?`).run(original[field], good.id);
    }
    expect((await f.read()).evidence.exactCurrentContextSuccess?.checkId).toBe(good.id);
  });

  it("compares every captured envelope field while preserving same-configuration success counts", async () => {
    const f = await fixture(), good = await f.check();
    f.sql.exec("DROP TRIGGER system_storage_candidate_checks_update_guard; PRAGMA ignore_check_constraints=ON");
    const changes = { envelope_revision: 2, envelope_version: 2, key_id: "other", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "changed" };
    for (const [field, value] of Object.entries(changes)) {
      f.sql.prepare(`UPDATE system_storage_candidate_checks SET ${field}=? WHERE id=?`).run(value, good.id);
      expect((await f.read()).evidence).toMatchObject({ currentConfigurationSuccessCount: 1,
        historicalConfigurationSuccessCount: 0, exactCurrentContextSuccess: null });
      f.sql.prepare(`UPDATE system_storage_candidate_checks SET ${field}=? WHERE id=?`).run(good.row[field as keyof typeof good.row], good.id);
    }
    expect((await f.read()).evidence.exactCurrentContextSuccess?.checkId).toBe(good.id);
  });

  it.each([
    ["system_storage_profiles", "id", "changed"], ["system_storage_configuration_revisions", "profile_id", "changed"],
    ["system_storage_profiles", "adapter_type", "webdav"], ["system_storage_profiles", "namespace_json", "{}"],
    ["system_storage_profiles", "namespace_sha256", "d".repeat(64)], ["system_storage_profiles", "latest_revision", 2],
    ["system_storage_profiles", "created_at", "changed"], ["system_storage_configuration_revisions", "revision", 2],
    ["system_storage_configuration_revisions", "namespace_json", "{}"], ["system_storage_configuration_revisions", "credential_ref", "changed"],
    ["system_storage_configuration_revisions", "label", "changed"], ["system_storage_configuration_revisions", "created_at", "changed"],
    ["system_storage_configuration_revisions", "created_by", "changed"], ["system_storage_credential_descriptors", "profile_id", "changed"],
    ["system_storage_credential_descriptors", "configuration_revision", 2], ["system_storage_credential_descriptors", "credential_ref", "changed"],
    ["system_storage_credential_descriptors", "namespace_sha256", "e".repeat(64)], ["system_storage_credential_descriptors", "created_at", "changed"],
    ["system_storage_credential_payloads", "credential_ref", "changed"], ["system_storage_credential_payloads", "envelope_revision", 2],
    ["system_storage_credential_payloads", "envelope_version", 2], ["system_storage_credential_payloads", "key_id", "changed"],
    ["system_storage_credential_payloads", "nonce", "AAAAAAAAAAAAAAAA"], ["system_storage_credential_payloads", "ciphertext", "changed"],
  ] as const)("rejects concurrent source drift in %s.%s even when revision discipline is bypassed", async (table, column, value) => {
    const f = await fixture(), prepare = f.db.prepare.bind(f.db);
    const triggers = f.sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all();
    for (const trigger of triggers) f.sql.exec(`DROP TRIGGER ${trigger.name}`);
    f.sql.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
    vi.spyOn(f.db, "prepare").mockImplementation(statement => {
      if (statement.startsWith("WITH source AS")) f.sql.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
      return prepare(statement);
    });
    await expect(f.read()).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a missing payload appearing during observation and deletion of the source profile", async () => {
    for (const mode of ["appears", "disappears"] as const) {
      const f = await fixture(), payload = f.payload(), prepare = f.db.prepare.bind(f.db);
      if (mode === "appears") {
        f.sql.exec("DROP TRIGGER system_storage_credential_payloads_delete_guard; DELETE FROM system_storage_credential_payloads");
      } else f.sql.exec("DROP TRIGGER system_storage_profiles_delete_guard; PRAGMA foreign_keys=OFF");
      vi.spyOn(f.db, "prepare").mockImplementation(statement => {
        if (statement.startsWith("WITH source AS")) {
          if (mode === "appears") f.sql.prepare("INSERT INTO system_storage_credential_payloads VALUES (?,?,?,?,?,?)")
            .run(payload.credential_ref, payload.envelope_revision, payload.envelope_version, payload.key_id, payload.nonce, payload.ciphertext);
          else f.sql.exec("DELETE FROM system_storage_profiles");
        }
        return prepare(statement);
      });
      await expect(f.read()).rejects.toMatchObject({ status: 409 });
    }
  });

  it("enforces administrator policy before any database access and sanitizes other failures", async () => {
    const f = await fixture(); f.db.resetQueryCount();
    for (const overrides of [{ AUTH_MODE: "disabled" }, { SYSTEM_ADMIN_EMAILS: "other@example.test" }])
      await expect(readStorageCandidateReadiness({ ...f.env, ...overrides }, f.query, actor)).rejects.toMatchObject({ status: 403 });
    await expect(readStorageCandidateReadiness(f.env, { ...f.query, nonce: "forbidden" }, actor)).rejects.toMatchObject({ status: 400 });
    expect(f.db.queryCount).toBe(0);
    await expect(f.read({ profileId: "unknown" })).rejects.toMatchObject({ status: 404 });
    await expect(f.read({ expectedRevision: 2 })).rejects.toMatchObject({ status: 409 });
    vi.spyOn(f.db, "prepare").mockImplementation(() => { throw new Error("private provider or SQL failure"); });
    await expect(f.read()).rejects.toEqual(new StorageCandidateReadinessError(503, "Storage candidate readiness is temporarily unavailable."));
  });
});

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterEach, describe, expect, it } from "vitest";

const registry = readFileSync(new URL("../../migrations/0014_fp2_storage_configuration.sql", import.meta.url), "utf8");
const checks = readFileSync(new URL("../../migrations/0015_fp2_storage_candidate_checks.sql", import.meta.url), "utf8");
const databases: DatabaseSync[] = [];
const now = "2026-10-02T00:00:00.000Z", deadline = "2026-10-02T00:00:30.000Z";
const id = "11111111-1111-4111-8111-111111111111";
const namespace = JSON.stringify({ kind: "s3", endpoint: "https://private-provider.example.test", bucket: "private-bucket", root: "private-root", region: "eu-test", forcePathStyle: true });
const ciphertext = "PROTECTED_ENVELOPE_SNAPSHOT_SENTINEL";
function fixture(individual = false) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("PRAGMA foreign_keys=ON;"); db.exec(registry);
  db.prepare("INSERT INTO system_storage_profiles VALUES('profile','s3',?,?,0,?)").run(namespace, "a".repeat(64), now);
  revision(db, 1);
  if (individual) {
    db.exec("CREATE TABLE d1_migrations(name TEXT NOT NULL UNIQUE)");
    const tracked = splitSql(checks + "\nINSERT INTO d1_migrations(name) VALUES ('0015_fp2_storage_candidate_checks.sql');");
    expect(tracked).toHaveLength(splitSql(checks).length + 1);
    for (const statement of tracked) db.prepare(statement).run();
    expect(db.prepare("SELECT name FROM d1_migrations").all()).toEqual([{ name: "0015_fp2_storage_candidate_checks.sql" }]);
  } else db.exec(checks);
  return db;
}
function revision(db: DatabaseSync, number: number) {
  db.prepare("INSERT INTO system_storage_credential_descriptors VALUES(?,?,?, ?,?)").run(`credential-${number}`, "profile", number, "a".repeat(64), now);
  db.prepare("INSERT INTO system_storage_credential_payloads VALUES(?,1,1,'key','abcdefghijklmnop',?)").run(`credential-${number}`, ciphertext);
  db.prepare("INSERT INTO system_storage_configuration_revisions VALUES('profile',?,'candidate',?,?,?,'admin@example.test')").run(number, namespace, `credential-${number}`, now);
}
function accept(db: DatabaseSync, options: { revision?: number; envelopeRevision?: number; snapshot?: string; checkId?: string; probeKey?: string } = {}) {
  const checkId = options.checkId ?? id, configurationRevision = options.revision ?? 1;
  db.prepare(`INSERT INTO system_storage_candidate_checks
    (id,profile_id,configuration_revision,credential_ref,envelope_revision,namespace_json,namespace_sha256,configuration_sha256,envelope_version,key_id,nonce,ciphertext,
      probe_key,payload_sha256,payload_size,requested_by,created_at,execution_kind,execution_token,execution_deadline,execution_actor,status,
      write_outcome,read_outcome,metadata_outcome,delete_outcome,cleanup_outcome,result_code,updated_at,completed_at)
    VALUES (?,'profile',?,?,?,?,?,?,1,'key','abcdefghijklmnop',?,?,?,?,?,?,'check','first-token',?,'admin@example.test','running','pending','pending','pending','pending','pending',NULL,?,NULL)`)
    .run(checkId, configurationRevision, `credential-${configurationRevision}`, options.envelopeRevision ?? 1, namespace, "a".repeat(64), "b".repeat(64), options.snapshot ?? ciphertext,
      options.probeKey ?? `__fp2_checks/${checkId}/11111111-1111-4111-8111-111111111111`, "c".repeat(64), 32, "admin@example.test", now, deadline, now);
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe("FP2 isolated check schema", () => {
  it("installs every statement separately and appends safe immutable audit snapshots", () => {
    const db = fixture(true); accept(db);
    db.exec("UPDATE system_storage_candidate_checks SET write_outcome='unknown',updated_at='2026-10-02T00:00:01.000Z'");
    const audit = db.prepare("SELECT * FROM system_storage_candidate_check_audit ORDER BY id").all();
    expect(audit).toHaveLength(2);
    expect(audit.map(row => row.operation)).toEqual(["accepted", "state_updated"]);
    expect(JSON.stringify(audit)).not.toContain(ciphertext);
    const names = db.prepare("PRAGMA table_info(system_storage_candidate_check_audit)").all().map(row => row.name);
    for (const name of ["namespace_json", "key_id", "nonce", "ciphertext", "probe_key", "credential_ref"]) expect(names).not.toContain(name);
    expect(() => db.exec("UPDATE system_storage_candidate_check_audit SET actor='changed'")).toThrow("audit is immutable");
    expect(() => db.exec("DELETE FROM system_storage_candidate_check_audit")).toThrow("audit is immutable");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("accepts only the current exact configuration and complete encrypted envelope snapshot", () => {
    const staleCandidate = fixture(); revision(staleCandidate, 2);
    expect(() => accept(staleCandidate)).toThrow("acceptance conflict");
    const rotated = fixture();
    rotated.prepare("UPDATE system_storage_credential_payloads SET envelope_revision=2,ciphertext=?").run("ROTATED_PROTECTED_PAYLOAD_SENTINEL");
    expect(() => accept(rotated)).toThrow("acceptance conflict");
    expect(() => accept(rotated, { envelopeRevision: 2 })).toThrow("acceptance conflict");
    accept(rotated, { envelopeRevision: 2, snapshot: "ROTATED_PROTECTED_PAYLOAD_SENTINEL" });
    rotated.prepare("UPDATE system_storage_credential_payloads SET envelope_revision=3,ciphertext=?").run("LATER_ROTATED_PAYLOAD_SENTINEL");
    expect(rotated.prepare("SELECT envelope_revision,ciphertext FROM system_storage_candidate_checks").get()).toEqual({ envelope_revision: 2, ciphertext: "ROTATED_PROTECTED_PAYLOAD_SENTINEL" });
  });

  it("retains immutable identity and allows fresh keys after terminal uncertainty while bounding active work", () => {
    const db = fixture(); accept(db);
    expect(() => accept(db, { checkId: "22222222-2222-4222-8222-222222222222" })).toThrow("UNIQUE constraint failed");
    for (const sql of ["UPDATE system_storage_candidate_checks SET namespace_sha256='" + "d".repeat(64) + "'",
      "UPDATE system_storage_candidate_checks SET ciphertext='OTHER_PROTECTED_PAYLOAD_SENTINEL'", "UPDATE system_storage_candidate_checks SET payload_size=33",
      "UPDATE system_storage_candidate_checks SET probe_key=probe_key||'other'", "DELETE FROM system_storage_candidate_checks"])
      expect(() => db.exec(sql)).toThrow();
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET execution_token='unexpected-owner'")).toThrow("execution conflict");
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET execution_deadline='2026-10-02T01:00:00.000Z'")).toThrow("execution conflict");
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET write_outcome='acknowledged'")).toThrow("outcome conflict");
    db.exec("UPDATE system_storage_candidate_checks SET write_outcome='unknown',status='interrupted',cleanup_outcome='absence_observed',result_code='execution_interrupted',completed_at=updated_at");
    accept(db, { checkId: "22222222-2222-4222-8222-222222222222" });
    expect(db.prepare("SELECT count(*) n FROM system_storage_candidate_checks").get()!.n).toBe(2);
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET execution_kind='cleanup',execution_token='cleanup-owner',execution_deadline='2026-10-02T00:00:40.000Z',cleanup_outcome='running' WHERE id='11111111-1111-4111-8111-111111111111'")).toThrow("UNIQUE constraint failed");
  });

  it("fences late completion and never erases an uncertain PUT during cleanup", () => {
    const db = fixture(); accept(db);
    db.exec("UPDATE system_storage_candidate_checks SET write_outcome='unknown',updated_at='2026-10-02T00:00:01.000Z'");
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET write_outcome='acknowledged',updated_at='2026-10-02T00:00:31.000Z'")).toThrow("execution conflict");
    db.exec("UPDATE system_storage_candidate_checks SET status='interrupted',cleanup_outcome='required',result_code='execution_interrupted',updated_at='2026-10-02T00:00:31.000Z',completed_at='2026-10-02T00:00:31.000Z'");
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET write_outcome='acknowledged'")).toThrow();
    db.exec("UPDATE system_storage_candidate_checks SET execution_kind='cleanup',execution_token='cleanup-token',execution_actor='other-admin@example.test',execution_deadline='2026-10-02T00:01:05.000Z',cleanup_outcome='running',updated_at='2026-10-02T00:00:35.000Z'");
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET cleanup_outcome='confirmed_absent',delete_outcome='acknowledged',updated_at='2026-10-02T00:00:36.000Z'")).toThrow();
    db.exec("UPDATE system_storage_candidate_checks SET cleanup_outcome='absence_observed',delete_outcome='acknowledged',updated_at='2026-10-02T00:00:36.000Z'");
    expect(db.prepare("SELECT status,write_outcome,cleanup_outcome FROM system_storage_candidate_checks").get()).toEqual({ status: "interrupted", write_outcome: "unknown", cleanup_outcome: "absence_observed" });
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET cleanup_outcome='confirmed_absent'")).toThrow();
  });

  it("requires full acknowledgement, verification and confirmed absence for success", () => {
    const db = fixture(); accept(db);
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET status='succeeded',completed_at=updated_at")).toThrow();
    db.exec("UPDATE system_storage_candidate_checks SET write_outcome='unknown'");
    db.exec("UPDATE system_storage_candidate_checks SET write_outcome='acknowledged',read_outcome='verified',metadata_outcome='verified',delete_outcome='acknowledged',cleanup_outcome='confirmed_absent',status='succeeded',completed_at=updated_at");
    expect(db.prepare("SELECT status FROM system_storage_candidate_checks").get()!.status).toBe("succeeded");
    expect(() => db.exec("UPDATE system_storage_candidate_checks SET cleanup_outcome='running',execution_kind='cleanup',execution_token='again',execution_deadline='2026-10-02T00:00:40.000Z'")).toThrow();
  });
});

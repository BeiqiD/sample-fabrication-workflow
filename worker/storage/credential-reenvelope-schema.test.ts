import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { afterEach, describe, expect, it } from "vitest";

const registry = readFileSync(new URL("../../migrations/0014_fp2_storage_configuration.sql", import.meta.url), "utf8");
const checks = readFileSync(new URL("../../migrations/0015_fp2_storage_candidate_checks.sql", import.meta.url), "utf8");
const reenvelopes = readFileSync(new URL("../../migrations/0016_fp2_credential_reenvelopes.sql", import.meta.url), "utf8");
const databases: DatabaseSync[] = [];
const now = "2026-10-02T00:00:00.000Z";
const operationId = "11111111-1111-4111-8111-111111111111";
const oldCiphertext = "ORIGINAL_PROTECTED_PAYLOAD_SENTINEL";
const newCiphertext = "REENVELOPED_PROTECTED_PAYLOAD_SENTINEL";
const namespace = JSON.stringify({ kind: "s3", endpoint: "https://provider.example.test", bucket: "private-bucket", root: "private-root", region: "eu-test", forcePathStyle: true });
function fixture(individual = false) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("PRAGMA foreign_keys=ON"); db.exec(registry); db.exec(checks);
  if (individual) {
    db.exec("CREATE TABLE d1_migrations(name TEXT NOT NULL UNIQUE)");
    const tracked = splitSql(reenvelopes + "\nINSERT INTO d1_migrations(name) VALUES ('0016_fp2_credential_reenvelopes.sql');");
    expect(splitSql(reenvelopes)).toHaveLength(5);
    expect(tracked).toHaveLength(6);
    for (const statement of tracked) db.prepare(statement).run();
    expect(db.prepare("SELECT name FROM d1_migrations").all()).toEqual([{ name: "0016_fp2_credential_reenvelopes.sql" }]);
  } else db.exec(reenvelopes);
  db.prepare("INSERT INTO system_storage_profiles VALUES('profile','s3',?,?,0,?)").run(namespace, "a".repeat(64), now);
  revision(db, 1);
  return db;
}
function revision(db: DatabaseSync, number: number) {
  db.prepare("INSERT INTO system_storage_credential_descriptors VALUES(?,?,?,?,?)").run(`credential-${number}`, "profile", number, "a".repeat(64), now);
  db.prepare("INSERT INTO system_storage_credential_payloads VALUES(?,1,1,'old-key','abcdefghijklmnop',?)").run(`credential-${number}`, oldCiphertext);
  db.prepare("INSERT INTO system_storage_configuration_revisions VALUES('profile',?,'candidate',?,?,?,'admin@example.test')").run(number, namespace, `credential-${number}`, now);
}
function receipt(db: DatabaseSync, options: { id?: string; profileId?: string; revision?: number; previousRevision?: number; envelopeRevision?: number; outcome?: string; oldKey?: string; key?: string } = {}) {
  const revision = options.revision ?? 1;
  db.prepare("INSERT INTO system_storage_credential_reenvelopes VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(options.id ?? operationId, options.profileId ?? "profile", revision, `credential-${revision}`, options.previousRevision ?? 1,
      options.envelopeRevision ?? 1, options.outcome ?? "already_current", options.oldKey ?? "old-key", options.key ?? "old-key", now, "admin@example.test");
}
function rotate(db: DatabaseSync, options: { sourceNonce?: string; id?: string } = {}) {
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE system_storage_credential_payloads SET envelope_revision=2,key_id='new-key',nonce='ponmlkjihgfedcba',ciphertext=?
      WHERE credential_ref='credential-1' AND envelope_revision=1 AND envelope_version=1 AND key_id='old-key' AND nonce=? AND ciphertext=?`)
      .run(newCiphertext, options.sourceNonce ?? "abcdefghijklmnop", oldCiphertext);
    // A scalar miss fails NOT NULL, making a lost CAS abort the entire batch.
    // changes() also rejects a zero-row update when the desired new row exists.
    db.prepare(`INSERT INTO system_storage_credential_reenvelopes VALUES(?,'profile',1,'credential-1',1,
      (SELECT envelope_revision FROM system_storage_credential_payloads WHERE credential_ref='credential-1' AND envelope_revision=2
        AND envelope_version=1 AND key_id='new-key' AND nonce='ponmlkjihgfedcba' AND ciphertext=? AND changes()=1),
      'reenveloped','old-key','new-key',?,'admin@example.test')`).run(options.id ?? operationId, newCiphertext, now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe("FP2 credential re-envelope receipt schema", () => {
  it("installs as complete migration statements and records safe immutable metadata", () => {
    const db = fixture(true); rotate(db);
    const audit = db.prepare("SELECT * FROM system_storage_credential_reenvelopes").all();
    expect(audit).toEqual([{ operation_id: operationId, profile_id: "profile", configuration_revision: 1, credential_ref: "credential-1",
      previous_envelope_revision: 1, envelope_revision: 2, outcome: "reenveloped", previous_key_id: "old-key", key_id: "new-key", created_at: now, created_by: "admin@example.test" }]);
    const names = db.prepare("PRAGMA table_info(system_storage_credential_reenvelopes)").all().map(row => row.name);
    for (const name of ["envelope_version", "nonce", "ciphertext", "namespace_json", "key_material", "plaintext"]) expect(names).not.toContain(name);
    expect(JSON.stringify(audit)).not.toContain(oldCiphertext); expect(JSON.stringify(audit)).not.toContain(newCiphertext);
    expect(() => db.exec("UPDATE system_storage_credential_reenvelopes SET created_by='changed'")).toThrow("receipts are immutable");
    expect(() => db.exec("DELETE FROM system_storage_credential_reenvelopes")).toThrow("receipts are immutable");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("permits historical descriptor maintenance without changing configuration identity", () => {
    const db = fixture(); revision(db, 2); rotate(db);
    expect(db.prepare("SELECT latest_revision FROM system_storage_profiles").get()).toEqual({ latest_revision: 2 });
    expect(db.prepare("SELECT revision,credential_ref FROM system_storage_configuration_revisions ORDER BY revision").all())
      .toEqual([{ revision: 1, credential_ref: "credential-1" }, { revision: 2, credential_ref: "credential-2" }]);
    expect(db.prepare("SELECT envelope_revision,key_id FROM system_storage_credential_payloads WHERE credential_ref='credential-2'").get())
      .toEqual({ envelope_revision: 1, key_id: "old-key" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("requires exact descriptor identity, current payload metadata and coherent outcomes", () => {
    const db = fixture();
    expect(() => receipt(db, { profileId: "other-profile" })).toThrow("re-envelope conflict");
    expect(() => receipt(db, { revision: 2 })).toThrow("re-envelope conflict");
    expect(() => receipt(db, { previousRevision: 2, envelopeRevision: 2 })).toThrow("re-envelope conflict");
    expect(() => receipt(db, { key: "other-key", oldKey: "other-key" })).toThrow("re-envelope conflict");
    expect(() => receipt(db, { outcome: "reenveloped" })).toThrow("CHECK constraint failed");
    expect(() => receipt(db, { previousRevision: 2 })).toThrow("CHECK constraint failed");
    receipt(db);
    expect(() => receipt(db)).toThrow("UNIQUE constraint failed");
    receipt(db, { id: "22222222-2222-4222-8222-222222222222" });
    expect(db.prepare("SELECT envelope_revision,key_id FROM system_storage_credential_payloads").get()).toEqual({ envelope_revision: 1, key_id: "old-key" });
  });

  it("aborts a lost full-source CAS and rolls back a payload update when receipt insertion fails", () => {
    const db = fixture(), before = db.prepare("SELECT * FROM system_storage_credential_payloads").all();
    expect(() => rotate(db, { sourceNonce: "SOURCE_NOT_MATCH" })).toThrow();
    expect(db.prepare("SELECT * FROM system_storage_credential_payloads").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM system_storage_credential_reenvelopes").all()).toEqual([]);
    receipt(db);
    expect(() => rotate(db)).toThrow("UNIQUE constraint failed");
    expect(db.prepare("SELECT * FROM system_storage_credential_payloads").all()).toEqual(before);
    expect(db.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()).toEqual({ n: 1 });
  });

  it("does not infer a successful CAS merely from an already matching replacement envelope", () => {
    const db = fixture();
    db.prepare("UPDATE system_storage_credential_payloads SET envelope_revision=2,key_id='new-key',nonce='ponmlkjihgfedcba',ciphertext=?").run(newCiphertext);
    const before = db.prepare("SELECT * FROM system_storage_credential_payloads").all();
    expect(() => rotate(db)).toThrow();
    expect(db.prepare("SELECT * FROM system_storage_credential_payloads").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM system_storage_credential_reenvelopes").all()).toEqual([]);
  });
});

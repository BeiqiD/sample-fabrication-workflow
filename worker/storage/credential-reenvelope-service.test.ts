import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkedStorageCredentialEnvelopeList, checkedStorageCredentialReenvelopeReceipt } from "../../shared/contracts/storage-credential-reenvelope";
import type { SaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { saveStorageCandidate } from "./configuration-registry";
import { decryptStorageCredential, encryptStorageCredential, parseStorageCredentialKeyring } from "./credential-envelope";
import {
  listStorageCredentialEnvelopes, readStorageCredentialReenvelope, reenvelopeStoredStorageCredential,
  StorageCredentialReenvelopeError,
} from "./credential-reenvelope-service";

const actor = "admin@example.test";
const material = (value: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(value)));
const oldRing = JSON.stringify({ version: 1, currentKeyId: "old", keys: { old: material(13) } });
const rotatedRing = JSON.stringify({ version: 1, currentKeyId: "current", keys: { old: material(13), current: material(29) } });
const currentOnlyRing = JSON.stringify({ version: 1, currentKeyId: "current", keys: { current: material(29) } });
const input: SaveStorageCandidateInput = { expectedRevision: null, label: "Wrapping fixture",
  namespace: { kind: "s3", endpoint: "https://objects.example.test", bucket: "fixture-bucket", region: "auto", root: "research", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "private-access", secretAccessKey: "private-secret" } } };
const databases: DatabaseSync[] = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture() {
  const sql = new DatabaseSync(":memory:"); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  for (const name of ["0014_fp2_storage_configuration.sql", "0015_fp2_storage_candidate_checks.sql", "0016_fp2_credential_reenvelopes.sql"])
    sql.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const db = new SqliteD1Database(sql), env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor, STORAGE_CREDENTIAL_KEYRING: oldRing } as Env;
  const saved = await saveStorageCandidate(env, input, actor);
  const payload = (ref = saved.credentials.ref) => sql.prepare("SELECT * FROM system_storage_credential_payloads WHERE credential_ref=?").get(ref)!;
  const command = (overrides = {}) => ({ operationId: crypto.randomUUID(), profileId: saved.profileId, revision: 1,
    credentialRef: saved.credentials.ref, expectedEnvelopeRevision: 1, ...overrides });
  env.STORAGE_CREDENTIAL_KEYRING = rotatedRing;
  return { sql, db, env, saved, payload, command };
}
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(sql => sql.close()); });

describe("durable credential wrapping maintenance", () => {
  it("authenticates wrapping status and commits exact-identity encryption with one immutable safe receipt", async () => {
    const f = await fixture(), before = f.payload(), command = f.command();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider access is forbidden"));
    expect(checkedStorageCredentialEnvelopeList(await listStorageCredentialEnvelopes(f.env, f.saved.profileId, actor))).toEqual({
      items: [{ profileId: f.saved.profileId, revision: 1, credentialRef: f.saved.credentials.ref, envelopeRevision: 1, isCurrentCandidate: true, status: "needs_reenvelope" }], hasMore: false });
    const result = checkedStorageCredentialReenvelopeReceipt(await reenvelopeStoredStorageCredential(f.env, command, actor));
    expect(result).toMatchObject({ operationId: command.operationId, profileId: command.profileId, revision: 1,
      credentialRef: command.credentialRef, previousEnvelopeRevision: 1, envelopeRevision: 2, outcome: "reenveloped", createdBy: actor });
    const after = f.payload(); expect(after).toMatchObject({ envelope_revision: 2, key_id: "current" });
    expect(after.nonce).not.toBe(before.nonce); expect(after.ciphertext).not.toBe(before.ciphertext);
    const descriptor = f.sql.prepare("SELECT * FROM system_storage_credential_descriptors WHERE credential_ref=?").get(command.credentialRef)!;
    expect(await decryptStorageCredential(await parseStorageCredentialKeyring(currentOnlyRing), {
      profileId: command.profileId, configurationRevision: 1, credentialRef: command.credentialRef, namespaceSha256: descriptor.namespace_sha256 as string,
    }, { version: 1, keyId: after.key_id, nonce: after.nonce, ciphertext: after.ciphertext })).toEqual({ outcome: "available", plaintext: JSON.stringify(input.credentials.mode === "replace" && input.credentials.value) });
    expect(await listStorageCredentialEnvelopes(f.env, f.saved.profileId, actor)).toMatchObject({ items: [{ status: "current", envelopeRevision: 2 }] });
    const audit = f.sql.prepare("SELECT * FROM system_storage_credential_reenvelopes").get()!;
    expect(audit).toMatchObject({ operation_id: command.operationId, previous_key_id: "old", key_id: "current" });
    expect(Object.keys(audit)).not.toContain("nonce"); expect(Object.keys(audit)).not.toContain("ciphertext");
    for (const secret of ["private-secret", "private-access", before.ciphertext as string, after.ciphertext as string, "previous_key_id", "key_id"])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.sql.prepare("SELECT latest_revision FROM system_storage_profiles").get()!.latest_revision).toBe(1);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves lost responses by UUID before later keyrings or payload changes, and rejects conflicting ID reuse", async () => {
    const f = await fixture(), command = f.command(), result = await reenvelopeStoredStorageCredential(f.env, command, actor);
    f.env.STORAGE_CREDENTIAL_KEYRING = "missing keyring";
    expect(await reenvelopeStoredStorageCredential(f.env, { ...command, operationId: command.operationId.toUpperCase() }, actor)).toEqual(result);
    expect(await readStorageCredentialReenvelope(f.env, command.operationId, actor)).toEqual(result);
    for (const change of [{ profileId: "other" }, { revision: 2 }, { credentialRef: "other" }, { expectedEnvelopeRevision: 2 }])
      await expect(reenvelopeStoredStorageCredential(f.env, { ...command, ...change }, actor)).rejects.toMatchObject({ status: 409 });
    expect(f.payload().envelope_revision).toBe(2);
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(1);
  });

  it("audits authenticated already-current operations without changing their protected payload", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = oldRing; const before = f.payload();
    const first = await reenvelopeStoredStorageCredential(f.env, f.command(), actor);
    const second = await reenvelopeStoredStorageCredential(f.env, f.command(), actor);
    expect(first).toMatchObject({ outcome: "already_current", previousEnvelopeRevision: 1, envelopeRevision: 1 });
    expect(second).toMatchObject({ outcome: "already_current", envelopeRevision: 1 }); expect(f.payload()).toEqual(before);
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(2);
  });

  it("does not equate matching key IDs with authenticated envelopes", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = oldRing;
    f.sql.exec("UPDATE system_storage_credential_payloads SET envelope_revision=2,ciphertext=substr(ciphertext,1,20)||'AAAA'||substr(ciphertext,25)");
    const before = f.payload();
    expect(await listStorageCredentialEnvelopes(f.env, f.saved.profileId, actor)).toMatchObject({ items: [{ status: "unavailable", envelopeRevision: 2 }] });
    await expect(reenvelopeStoredStorageCredential(f.env, f.command({ expectedEnvelopeRevision: 2 }), actor)).rejects.toMatchObject({ status: 503 });
    expect(f.payload()).toEqual(before); expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(0);
  });

  it("enforces verified administrator permission independently before any database query", async () => {
    const f = await fixture(); f.db.resetQueryCount();
    for (const env of [{ ...f.env, SYSTEM_ADMIN_EMAILS: "someone@example.test" }, { ...f.env, AUTH_MODE: "disabled" }]) {
      for (const operation of [() => listStorageCredentialEnvelopes(env, f.saved.profileId, actor),
        () => readStorageCredentialReenvelope(env, crypto.randomUUID(), actor), () => reenvelopeStoredStorageCredential(env, f.command(), actor)])
        await expect(operation()).rejects.toMatchObject({ status: 403 });
    }
    expect(f.db.queryCount).toBe(0);
  });

  it("rejects malformed commands, wrong retained identities and stale revisions without modifying envelopes", async () => {
    const f = await fixture(), before = f.payload();
    await expect(reenvelopeStoredStorageCredential(f.env, { ...f.command(), keyId: "user-selected" }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(listStorageCredentialEnvelopes(f.env, "\0invalid", actor)).rejects.toMatchObject({ status: 400 });
    await expect(readStorageCredentialReenvelope(f.env, "invalid", actor)).rejects.toMatchObject({ status: 400 });
    await expect(readStorageCredentialReenvelope(f.env, crypto.randomUUID(), actor)).rejects.toMatchObject({ status: 404 });
    for (const changes of [{ profileId: "other" }, { revision: 2 }, { credentialRef: "other" }, { expectedEnvelopeRevision: 2 }])
      await expect(reenvelopeStoredStorageCredential(f.env, f.command(changes), actor)).rejects.toMatchObject({ status: 409 });
    expect(f.payload()).toEqual(before);
  });

  it("preserves ciphertext when a retained decryption key is missing or the keyring is malformed", async () => {
    const f = await fixture(), before = f.payload();
    for (const ring of [currentOnlyRing, "invalid", undefined]) {
      f.env.STORAGE_CREDENTIAL_KEYRING = ring;
      expect(await listStorageCredentialEnvelopes(f.env, f.saved.profileId, actor)).toMatchObject({ items: [{ status: "unavailable" }] });
      await expect(reenvelopeStoredStorageCredential(f.env, f.command(), actor)).rejects.toEqual(new StorageCredentialReenvelopeError(503, "Storage credential encryption is unavailable."));
      expect(f.payload()).toEqual(before);
    }
  });

  it("rejects a payload copied across descriptor identities without overwriting either envelope", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = oldRing;
    const other = await saveStorageCandidate(f.env, { ...input, label: "Other", namespace: { ...input.namespace, root: "other" } }, actor);
    const swapped = f.payload(other.credentials.ref);
    f.sql.prepare("UPDATE system_storage_credential_payloads SET envelope_revision=2,nonce=?,ciphertext=? WHERE credential_ref=?")
      .run(swapped.nonce, swapped.ciphertext, f.saved.credentials.ref);
    const before = f.payload(); f.env.STORAGE_CREDENTIAL_KEYRING = rotatedRing;
    await expect(reenvelopeStoredStorageCredential(f.env, f.command({ expectedEnvelopeRevision: 2 }), actor)).rejects.toMatchObject({ status: 503 });
    expect(f.payload()).toEqual(before); expect(f.payload(other.credentials.ref)).toEqual(swapped);
  });

  it.each(["envelope_revision", "envelope_version", "key_id", "nonce", "ciphertext"])("CAS compares source field %s even if revision discipline was bypassed", async field => {
    const f = await fixture(), batch = f.db.batch.bind(f.db);
    const replacements: Record<string, string | number> = { envelope_revision: 2, envelope_version: 2, key_id: "concurrent", nonce: "AAAAAAAAAAAAAAAA", ciphertext: `${f.payload().ciphertext}A` };
    let concurrent!: ReturnType<typeof f.payload>;
    vi.spyOn(f.db, "batch").mockImplementation(async statements => {
      f.sql.exec("DROP TRIGGER system_storage_credential_payloads_update_guard; PRAGMA ignore_check_constraints=ON");
      f.sql.prepare(`UPDATE system_storage_credential_payloads SET ${field}=?`).run(replacements[field]);
      concurrent = f.payload();
      return batch(statements);
    });
    await expect(reenvelopeStoredStorageCredential(f.env, f.command(), actor)).rejects.toMatchObject({ status: 409 });
    expect(f.payload()).toEqual(concurrent);
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(0);
  });

  it("rolls back the new payload when audit insertion fails, sanitizing the database error", async () => {
    const f = await fixture(), before = f.payload();
    f.sql.exec("CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON system_storage_credential_reenvelopes BEGIN SELECT RAISE(ABORT,'secret audit error'); END;");
    await expect(reenvelopeStoredStorageCredential(f.env, f.command(), actor)).rejects.toEqual(new StorageCredentialReenvelopeError(503, "Storage credential re-envelope is temporarily unavailable."));
    expect(f.payload()).toEqual(before); expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(0);
  });

  it("guards an already-current receipt against a concurrent full-envelope change", async () => {
    const f = await fixture(), batch = f.db.batch.bind(f.db); f.env.STORAGE_CREDENTIAL_KEYRING = oldRing;
    let concurrent!: ReturnType<typeof f.payload>;
    vi.spyOn(f.db, "batch").mockImplementation(async statements => {
      f.sql.exec("UPDATE system_storage_credential_payloads SET envelope_revision=2,nonce='AAAAAAAAAAAAAAAA'");
      concurrent = f.payload(); return batch(statements);
    });
    await expect(reenvelopeStoredStorageCredential(f.env, f.command(), actor)).rejects.toMatchObject({ status: 409 });
    expect(f.payload()).toEqual(concurrent); expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(0);
  });

  it("returns one receipt for concurrent identical operation IDs and rejects competing IDs on the old envelope", async () => {
    for (const sameId of [true, false]) {
      const f = await fixture(), batch = f.db.batch.bind(f.db), release = deferred(), ready = deferred(); let calls = 0;
      vi.spyOn(f.db, "batch").mockImplementation(async statements => { if (++calls === 2) ready.resolve(); await release.promise; return batch(statements); });
      const first = f.command(), second = sameId ? first : f.command();
      const operations = [reenvelopeStoredStorageCredential(f.env, first, actor), reenvelopeStoredStorageCredential(f.env, second, actor)];
      await ready.promise; release.resolve(); const results = await Promise.allSettled(operations);
      if (sameId) {
        expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
        expect((results[1] as PromiseFulfilledResult<unknown>).value).toEqual((results[0] as PromiseFulfilledResult<unknown>).value);
      } else {
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      }
      expect(f.payload().envelope_revision).toBe(2); expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(1);
    }
  });

  it("rolls back a second payload when concurrent UUID reuse names conflicting identities", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = oldRing;
    const other = await saveStorageCandidate(f.env, { ...input, namespace: { ...input.namespace, root: "another" } }, actor);
    const firstBefore = f.payload(), otherBefore = f.payload(other.credentials.ref), batch = f.db.batch.bind(f.db), release = deferred(), ready = deferred(); let calls = 0;
    f.env.STORAGE_CREDENTIAL_KEYRING = rotatedRing;
    vi.spyOn(f.db, "batch").mockImplementation(async statements => { if (++calls === 2) ready.resolve(); await release.promise; return batch(statements); });
    const first = f.command(), second = { ...first, profileId: other.profileId, credentialRef: other.credentials.ref };
    const operations = [reenvelopeStoredStorageCredential(f.env, first, actor), reenvelopeStoredStorageCredential(f.env, second, actor)];
    await ready.promise; release.resolve(); const results = await Promise.allSettled(operations);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    if (results[0].status === "fulfilled") { expect(f.payload().envelope_revision).toBe(2); expect(f.payload(other.credentials.ref)).toEqual(otherBefore); }
    else { expect(f.payload()).toEqual(firstBefore); expect(f.payload(other.credentials.ref).envelope_revision).toBe(2); }
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(1);
  });

  it("treats an ambiguous committed batch as uncertain until the same durable operation can be read again", async () => {
    const f = await fixture(), command = f.command(), batch = f.db.batch.bind(f.db), prepare = f.db.prepare.bind(f.db); let blockReceiptRead = false;
    vi.spyOn(f.db, "batch").mockImplementation(async statements => { await batch(statements); blockReceiptRead = true; throw new Error("lost commit acknowledgement"); });
    vi.spyOn(f.db, "prepare").mockImplementation(sql => { if (blockReceiptRead && sql.includes("FROM system_storage_credential_reenvelopes")) throw new Error("temporary read outage"); return prepare(sql); });
    await expect(reenvelopeStoredStorageCredential(f.env, command, actor)).rejects.toMatchObject({ status: 503 });
    blockReceiptRead = false;
    expect(await reenvelopeStoredStorageCredential(f.env, command, actor)).toMatchObject({ outcome: "reenveloped", envelopeRevision: 2 });
    expect(f.payload().envelope_revision).toBe(2); expect(f.sql.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").get()!.n).toBe(1);
  });

  it("lists and maintains retained historical and unattached descriptors with their exact original identity", async () => {
    const f = await fixture(); f.env.STORAGE_CREDENTIAL_KEYRING = oldRing;
    const latest = await saveStorageCandidate(f.env, { ...input, profileId: f.saved.profileId, expectedRevision: 1, credentials: { mode: "retain" } }, actor);
    const descriptor = f.sql.prepare("SELECT * FROM system_storage_credential_descriptors WHERE credential_ref=?").get(f.saved.credentials.ref)!;
    const orphanRef = "credential:unattached", orphanIdentity = { profileId: f.saved.profileId, configurationRevision: 2, credentialRef: orphanRef, namespaceSha256: descriptor.namespace_sha256 as string };
    const sealed = await encryptStorageCredential(await parseStorageCredentialKeyring(oldRing), orphanIdentity, "retained-secret");
    f.sql.prepare("INSERT INTO system_storage_credential_descriptors VALUES (?,?,?,?,?)").run(orphanRef, f.saved.profileId, 2, descriptor.namespace_sha256, new Date().toISOString());
    f.sql.prepare("INSERT INTO system_storage_credential_payloads VALUES (?,1,?,?,?,?)").run(orphanRef, sealed.version, sealed.keyId, sealed.nonce, sealed.ciphertext);
    f.env.STORAGE_CREDENTIAL_KEYRING = rotatedRing;
    expect(await listStorageCredentialEnvelopes(f.env, f.saved.profileId, actor)).toMatchObject({ items: [
      { revision: 2, credentialRef: latest.credentials.ref, isCurrentCandidate: true, status: "needs_reenvelope" },
      { revision: 2, credentialRef: orphanRef, isCurrentCandidate: false, status: "needs_reenvelope" },
      { revision: 1, credentialRef: f.saved.credentials.ref, isCurrentCandidate: false, status: "needs_reenvelope" },
    ] });
    expect(await reenvelopeStoredStorageCredential(f.env, f.command(), actor)).toMatchObject({ revision: 1, envelopeRevision: 2 });
    expect(await reenvelopeStoredStorageCredential(f.env, f.command({ revision: 2, credentialRef: orphanRef }), actor)).toMatchObject({ revision: 2, envelopeRevision: 2 });
    expect(f.sql.prepare("SELECT latest_revision FROM system_storage_profiles").get()!.latest_revision).toBe(2);
    expect(f.payload(latest.credentials.ref).envelope_revision).toBe(1);
  });

  it("bounds retained history and represents absent payloads without a fabricated envelope revision", async () => {
    const f = await fixture(), descriptor = f.sql.prepare("SELECT * FROM system_storage_credential_descriptors").get()!;
    for (let n = 2; n <= 102; n++) f.sql.prepare("INSERT INTO system_storage_credential_descriptors VALUES (?,?,?,?,?)")
      .run(`credential:retained-${n}`, f.saved.profileId, n, descriptor.namespace_sha256, new Date().toISOString());
    const result = checkedStorageCredentialEnvelopeList(await listStorageCredentialEnvelopes(f.env, f.saved.profileId, actor));
    expect(result.items).toHaveLength(100); expect(result.hasMore).toBe(true);
    expect(result.items[0]).toMatchObject({ revision: 102, envelopeRevision: null, isCurrentCandidate: false, status: "unavailable" });
    await expect(reenvelopeStoredStorageCredential(f.env, f.command({ revision: 102, credentialRef: "credential:retained-102" }), actor)).rejects.toMatchObject({ status: 503 });
  });

  it("fails safely before CAS when the next wrapping revision would exceed safe integer range", async () => {
    const f = await fixture(); f.sql.exec("DROP TRIGGER system_storage_credential_payloads_update_guard");
    f.sql.prepare("UPDATE system_storage_credential_payloads SET envelope_revision=?").run(Number.MAX_SAFE_INTEGER); const before = f.payload();
    await expect(reenvelopeStoredStorageCredential(f.env, f.command({ expectedEnvelopeRevision: Number.MAX_SAFE_INTEGER }), actor)).rejects.toMatchObject({ status: 409 });
    expect(f.payload()).toEqual(before);
  });
});

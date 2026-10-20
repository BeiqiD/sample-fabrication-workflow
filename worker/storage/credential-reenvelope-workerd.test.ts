import { build } from "esbuild";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { checkedStorageCandidateCheck } from "../../shared/contracts/storage-candidate-check";
import { checkedStorageCredentialEnvelopeList, checkedStorageCredentialReenvelopeReceipt } from "../../shared/contracts/storage-credential-reenvelope";
import type { StorageCandidate } from "../../shared/contracts/storage-configuration";

const oldKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(19)));
const nextKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)));
const thirdKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(39)));
const initialKeyring = { version: 1, currentKeyId: "fixture-old", keys: { "fixture-old": oldKey } };
const nextKeyring = { version: 1, currentKeyId: "fixture-next", keys: { "fixture-old": oldKey, "fixture-next": nextKey } };
const nextOnlyKeyring = { version: 1, currentKeyId: "fixture-next", keys: { "fixture-next": nextKey } };
const thirdKeyring = { version: 1, currentKeyId: "fixture-third", keys: { "fixture-next": nextKey, "fixture-third": thirdKey } };
const candidate = { expectedRevision: null, label: "Native re-envelope fixture", namespace: { kind: "s3", endpoint: "https://objects.example.test",
  bucket: "test-bucket", region: "region-one", root: "", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "fixture-id-one", secretAccessKey: "fixture-secret-one" } } };
const secondCredentials = { accessKeyId: "fixture-id-two", secretAccessKey: "fixture-secret-two" };

async function fixture() {
  const bundle = await build({ stdin: { contents: `
    import {saveStorageCandidate} from './configuration-registry';
    import {listStorageCredentialEnvelopes,reenvelopeStoredStorageCredential,readStorageCredentialReenvelope} from './credential-reenvelope-service';
    import {decryptStorageCredential,parseStorageCredentialKeyring} from './credential-envelope';
    import {startStorageCandidateCheck,cleanupStorageCandidateCheck} from './candidate-check-service';
    import {activateFileAuthority} from '../files/authority-activation';
    import {prepareR2StorageRoleDefaults} from '../files/storage-role-defaults';
    const objects = new Map(), calls = [];
    let denyDelete = false;
    async function barrier(env,group) {
      const response=await env.QUALIFICATION_GATE.fetch('https://qualification-gate.test/',{method:'POST',body:group});
      if(response.status!==204)throw new Error('Native qualification gate did not admit both requests');
    }
    export default {async fetch(request, env) {
      const input=await request.json(), actor='admin@example.test';
      const serviceEnv={...env,...('keyring' in input?{STORAGE_CREDENTIAL_KEYRING:JSON.stringify(input.keyring)}:{})};
      if(input.raceGroup)serviceEnv.DB={prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{await barrier(env,input.raceGroup);return env.DB.batch(statements);}};
      const options={fetch:async request=>{
        calls.push({method:request.method,url:request.url,authorization:request.headers.get('authorization')});
        if(request.method==='PUT'){objects.set(request.url,await request.arrayBuffer());return new Response(null,{status:200});}
        if(request.method==='DELETE'){if(denyDelete)return new Response(null,{status:403});objects.delete(request.url);return new Response(null,{status:204});}
        const value=objects.get(request.url);if(!value)return new Response(null,{status:404});
        return new Response(request.method==='HEAD'?null:value.slice(0),{headers:{'content-length':String(value.byteLength),'content-type':'application/octet-stream'}});
      }};
      try {
        let value;
        if(input.action==='save')value=await saveStorageCandidate(serviceEnv,input.command,actor);
        else if(input.action==='list')value=await listStorageCredentialEnvelopes(serviceEnv,input.profileId,actor);
        else if(input.action==='reenvelope')value=await reenvelopeStoredStorageCredential(serviceEnv,input.command,actor);
        else if(input.action==='receipt')value=await readStorageCredentialReenvelope(serviceEnv,input.id,actor);
        else if(input.action==='decrypt'){
          const row=await env.DB.prepare('SELECT d.profile_id,d.configuration_revision,d.credential_ref,d.namespace_sha256,e.* FROM system_storage_credential_descriptors d JOIN system_storage_credential_payloads e ON e.credential_ref=d.credential_ref WHERE d.credential_ref=?').bind(input.ref).first();
          value=await decryptStorageCredential(await parseStorageCredentialKeyring(serviceEnv.STORAGE_CREDENTIAL_KEYRING),
            {profileId:row.profile_id,configurationRevision:row.configuration_revision,credentialRef:row.credential_ref,namespaceSha256:row.namespace_sha256},
            {version:row.envelope_version,keyId:row.key_id,nonce:row.nonce,ciphertext:row.ciphertext});
        }
        else if(input.action==='start')value=await startStorageCandidateCheck(serviceEnv,input.command,actor,options);
        else if(input.action==='cleanup')value=await cleanupStorageCandidateCheck(serviceEnv,input.id,actor,options);
        else if(input.action==='denyDelete'){denyDelete=input.value;value={ok:true};}
        else if(input.action==='bootstrap'){
          const time=new Date().toISOString(), profileId='native-r2';
          await env.DB.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)").bind(profileId,env.R2_BOOTSTRAP_NAMESPACE,time).run();
          await env.DB.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) SELECT 1,epoch,?,? FROM file_shadow_control").bind(actor,time).run();
          await env.DB.prepare("INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES(?,1,?,?)").bind(profileId,actor,time).run();
          await env.DB.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by=?,updated_at=?").bind(crypto.randomUUID(),actor,time).run();
          await env.DB.prepare('UPDATE file_shadow_runtime_guard SET enabled=0').run();
          const cutoff=await env.DB.prepare('SELECT c.epoch,r.incarnation FROM file_shadow_control c JOIN file_shadow_runtime_guard r ON r.singleton=c.singleton').first();
          await activateFileAuthority(env.DB,actor,{requestId:crypto.randomUUID(),expectedEpoch:cutoff.epoch,expectedShadowIncarnation:cutoff.incarnation});
          const policy=await prepareR2StorageRoleDefaults(env.DB,env,new Date().toISOString());await env.DB.batch(policy.statements);
          value={ok:true};
        }
        else value={calls,remaining:objects.size};
        return Response.json(value);
      }catch(error){return Response.json({error:error.message},{status:error.status||503});}
    }};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false });
  // Shared gates belong to Node, while each Worker request awaits its own
  // service-binding I/O. A Worker-global Promise would cross request contexts.
  const gates = new Map<string, { arrivals: number; ready: Promise<boolean>; release: (admitted: boolean) => void;
    timer: ReturnType<typeof setTimeout> }>();
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20", d1Databases: ["DB"],
    serviceBindings: { QUALIFICATION_GATE: async request => {
      const group = await request.text();
      if (request.method !== "POST" || !group || group.length > 512) return new MiniflareResponse(null, { status: 400 });
      let gate = gates.get(group);
      if (!gate) {
        let release!: (admitted: boolean) => void;
        const ready = new Promise<boolean>(resolve => { release = resolve; });
        gate = { arrivals: 0, ready, release, timer: setTimeout(() => release(false), 10_000) };
        gates.set(group, gate);
      }
      if (++gate.arrivals > 2) return new MiniflareResponse(null, { status: 409 });
      if (gate.arrivals === 2) { clearTimeout(gate.timer); gate.release(true); }
      return new MiniflareResponse(null, { status: await gate.ready ? 204 : 504 });
    } },
    log: new Log(LogLevel.ERROR), bindings: { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test",
      STORAGE_CREDENTIAL_KEYRING: JSON.stringify(initialKeyring),
      R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "native-fixture-bucket" }) } });
  const dispose = async () => {
    for (const gate of gates.values()) { clearTimeout(gate.timer); gate.release(false); }
    await native.dispose();
  };
  try {
    const db = await native.getD1Database("DB"), directory = new URL("../../migrations/", import.meta.url);
    for (const filename of readdirSync(directory).filter(filename => filename.endsWith(".sql")).sort())
      await db.batch(splitSql(readFileSync(new URL(filename, directory), "utf8")).map(statement => db.prepare(statement)));
    const call = async (value: unknown) => {
      const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    };
    const save = async (command: unknown = candidate) => {
      const saved = await call({ action: "save", command }); expect(saved.status).toBe(200);
      return saved.body as StorageCandidate;
    };
    const payload = (ref: string) => db.prepare("SELECT * FROM system_storage_credential_payloads WHERE credential_ref=?").bind(ref).first<Record<string, string | number>>();
    return { db, call, save, payload, gateArrivals: (group: string) => gates.get(group)?.arrivals, dispose };
  } catch (error) { await dispose(); throw error; }
}
function rotation(saved: StorageCandidate, operationId: string, expectedEnvelopeRevision = 1) {
  return { operationId, profileId: saved.profileId, revision: saved.revision, credentialRef: saved.credentials.ref, expectedEnvelopeRevision };
}
async function invariantSnapshot(db: Awaited<ReturnType<typeof fixture>>["db"]) {
  const tables = ["system_storage_profiles", "system_storage_configuration_revisions", "system_storage_credential_descriptors",
    "system_storage_configuration_audit", "storage_profiles", "storage_profile_runtime", "storage_role_defaults", "file_authority_control", "file_authority_runtime_guard"];
  return Promise.all(tables.map(async table => ({ table, rows: (await db.prepare(`SELECT * FROM ${table}`).all()).results })));
}
const checkSnapshotSql = "SELECT profile_id,configuration_revision,credential_ref,envelope_revision,namespace_json,namespace_sha256,configuration_sha256,envelope_version,key_id,nonce,ciphertext,probe_key,payload_sha256,payload_size FROM system_storage_candidate_checks WHERE id=?";

describe("credential re-enveloping with native Worker crypto and D1", () => {
  it("rotates current and historical payloads atomically while retaining provider credentials, configuration, R2 defaults and idempotent receipts", async () => {
    const f = await fixture();
    try {
      expect((await f.call({ action: "bootstrap" })).status).toBe(200);
      expect((await f.db.prepare("SELECT role,storage_profile_id FROM storage_role_defaults ORDER BY role").all()).results)
        .toEqual([{ role: "internal", storage_profile_id: "native-r2" }, { role: "originals", storage_profile_id: "native-r2" }]);
      const first = await f.save(), second = await f.save({ ...candidate, profileId: first.profileId, expectedRevision: 1,
        namespace: { ...candidate.namespace, region: "region-two" }, credentials: { mode: "replace", value: secondCredentials } });
      const invariant = await invariantSnapshot(f.db), oldFirst = await f.payload(first.credentials.ref), oldSecond = await f.payload(second.credentials.ref);
      const list = await f.call({ action: "list", profileId: first.profileId, keyring: nextKeyring }); expect(list.status).toBe(200);
      expect(checkedStorageCredentialEnvelopeList(list.body).items).toEqual([
        { profileId: first.profileId, revision: 2, credentialRef: second.credentials.ref, envelopeRevision: 1, isCurrentCandidate: true, status: "needs_reenvelope" },
        { profileId: first.profileId, revision: 1, credentialRef: first.credentials.ref, envelopeRevision: 1, isCurrentCandidate: false, status: "needs_reenvelope" },
      ]);
      const commands = [rotation(first, "11111111-1111-4111-8111-111111111111"), rotation(second, "22222222-2222-4222-8222-222222222222")];
      const receipts = [];
      for (const command of commands) {
        const result = await f.call({ action: "reenvelope", command, keyring: nextKeyring }); expect(result.status).toBe(200);
        expect(checkedStorageCredentialReenvelopeReceipt(result.body)).toMatchObject({ operationId: command.operationId, profileId: command.profileId,
          revision: command.revision, credentialRef: command.credentialRef, previousEnvelopeRevision: 1, envelopeRevision: 2, outcome: "reenveloped" });
        receipts.push(result.body);
      }
      for (const [saved, oldPayload, credentials] of [[first, oldFirst, candidate.credentials.value], [second, oldSecond, secondCredentials]] as const) {
        const payload = await f.payload(saved.credentials.ref);
        expect(payload).toMatchObject({ credential_ref: saved.credentials.ref, envelope_revision: 2, envelope_version: 1, key_id: "fixture-next" });
        expect(payload!.nonce).not.toBe(oldPayload!.nonce); expect(payload!.ciphertext).not.toBe(oldPayload!.ciphertext);
        const decrypted = await f.call({ action: "decrypt", ref: saved.credentials.ref, keyring: nextOnlyKeyring });
        expect(decrypted.body).toEqual({ outcome: "available", plaintext: JSON.stringify(credentials) });
      }
      // The receipt reconciles a lost response before reading any current keyring.
      const beforeRepeat = await f.payload(second.credentials.ref);
      expect((await f.call({ action: "receipt", id: commands[1].operationId, keyring: null })).body).toEqual(receipts[1]);
      expect((await f.call({ action: "reenvelope", command: commands[1], keyring: thirdKeyring })).body).toEqual(receipts[1]);
      expect((await f.call({ action: "reenvelope", command: commands[1], keyring: null })).body).toEqual(receipts[1]);
      expect(await f.payload(second.credentials.ref)).toEqual(beforeRepeat);
      expect((await f.call({ action: "reenvelope", command: { ...commands[1], credentialRef: first.credentials.ref }, keyring: nextKeyring })).status).toBe(409);
      const current = await f.call({ action: "reenvelope", command: rotation(second, "33333333-3333-4333-8333-333333333333", 2), keyring: nextOnlyKeyring });
      expect(current.status).toBe(200); expect(checkedStorageCredentialReenvelopeReceipt(current.body))
        .toMatchObject({ outcome: "already_current", previousEnvelopeRevision: 2, envelopeRevision: 2 });
      expect(await f.payload(second.credentials.ref)).toEqual(beforeRepeat);
      expect(await invariantSnapshot(f.db)).toEqual(invariant);
      expect((await f.db.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").first<{ n: number }>())!.n).toBe(3);
      expect((await f.call({ action: "io" })).body).toEqual({ calls: [], remaining: 0 });
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await f.dispose(); }
  }, 60_000);

  it("uses native D1 atomic CAS to admit one concurrent writer and rolls back an envelope when its receipt cannot commit", async () => {
    const f = await fixture();
    try {
      const saved = await f.save(), one = rotation(saved, "44444444-4444-4444-8444-444444444444"), two = rotation(saved, "55555555-5555-4555-8555-555555555555");
      // Both requests finish crypto and reach their prepared transaction before
      // either native D1 batch starts, so this exercises the final SQL CAS.
      const competing = await Promise.all([one, two].map(command => f.call({ action: "reenvelope", command, keyring: nextKeyring, raceGroup: "same-old-envelope" })));
      expect(f.gateArrivals("same-old-envelope")).toBe(2);
      expect(competing.map(result => result.status).sort()).toEqual([200, 409]);
      const winner = competing.find(result => result.status === 200)!;
      expect(checkedStorageCredentialReenvelopeReceipt(winner.body)).toMatchObject({ outcome: "reenveloped", previousEnvelopeRevision: 1, envelopeRevision: 2 });
      expect(await f.payload(saved.credentials.ref)).toMatchObject({ envelope_revision: 2, key_id: "fixture-next" });
      expect((await f.db.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").first<{ n: number }>())!.n).toBe(1);
      const command = rotation(saved, "66666666-6666-4666-8666-666666666666", 2), before = await f.payload(saved.credentials.ref);
      await f.db.prepare("CREATE TRIGGER native_fixture_receipt_failure BEFORE INSERT ON system_storage_credential_reenvelopes BEGIN SELECT RAISE(ABORT,'fixture receipt failed'); END;").run();
      const failed = await f.call({ action: "reenvelope", command, keyring: thirdKeyring }); expect(failed.status).toBe(503);
      expect(JSON.stringify(failed.body)).not.toContain("fixture receipt failed");
      expect(await f.payload(saved.credentials.ref)).toEqual(before);
      expect(await f.db.prepare("SELECT operation_id FROM system_storage_credential_reenvelopes WHERE operation_id=?").bind(command.operationId).first()).toBeNull();
      await f.db.prepare("DROP TRIGGER native_fixture_receipt_failure").run();
      const retried = await f.call({ action: "reenvelope", command, keyring: thirdKeyring }); expect(retried.status).toBe(200);
      expect(checkedStorageCredentialReenvelopeReceipt(retried.body)).toMatchObject({ previousEnvelopeRevision: 2, envelopeRevision: 3, outcome: "reenveloped" });
      const sameId = rotation(saved, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 3);
      const fourthKeyring = { version: 1, currentKeyId: "fixture-next", keys: { "fixture-next": nextKey, "fixture-third": thirdKey } };
      const reconciled = await Promise.all([0, 1].map(() => f.call({ action: "reenvelope", command: sameId, keyring: fourthKeyring, raceGroup: "same-operation-id" })));
      expect(f.gateArrivals("same-operation-id")).toBe(2);
      expect(reconciled.map(result => result.status)).toEqual([200, 200]); expect(reconciled[0].body).toEqual(reconciled[1].body);
      expect(checkedStorageCredentialReenvelopeReceipt(reconciled[0].body)).toMatchObject({ previousEnvelopeRevision: 3, envelopeRevision: 4, outcome: "reenveloped" });
      expect(await f.payload(saved.credentials.ref)).toMatchObject({ envelope_revision: 4, key_id: "fixture-next" });
      expect((await f.db.prepare("SELECT count(*) n FROM system_storage_credential_reenvelopes").first<{ n: number }>())!.n).toBe(3);
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      expect((await f.call({ action: "io" })).body).toEqual({ calls: [], remaining: 0 });
    } finally { await f.dispose(); }
  }, 60_000);

  it("preserves captured check envelopes and requires their old key for cleanup after live payloads use the new key", async () => {
    const f = await fixture();
    try {
      const first = await f.save(), checkId = "77777777-7777-4777-8777-777777777777";
      await f.call({ action: "denyDelete", value: true });
      const checked = await f.call({ action: "start", command: { checkId, profileId: first.profileId, expectedRevision: 1 } });
      expect(checked.status).toBe(200); expect(checkedStorageCandidateCheck(checked.body)).toMatchObject({ status: "failed", cleanup: "required", write: "passed", read: "passed" });
      const snapshot = await f.db.prepare(checkSnapshotSql).bind(checkId).first(); expect(snapshot).toMatchObject({ envelope_revision: 1, key_id: "fixture-old" });
      const second = await f.save({ ...candidate, profileId: first.profileId, expectedRevision: 1, namespace: { ...candidate.namespace, region: "region-two" },
        credentials: { mode: "replace", value: secondCredentials } });
      for (const [saved, id] of [[first, "88888888-8888-4888-8888-888888888888"], [second, "99999999-9999-4999-8999-999999999999"]] as const)
        expect((await f.call({ action: "reenvelope", command: rotation(saved, id), keyring: nextKeyring })).status).toBe(200);
      expect(await f.db.prepare(checkSnapshotSql).bind(checkId).first()).toEqual(snapshot);
      expect((await f.call({ action: "decrypt", ref: second.credentials.ref, keyring: nextOnlyKeyring })).body)
        .toEqual({ outcome: "available", plaintext: JSON.stringify(secondCredentials) });
      await f.call({ action: "denyDelete", value: false });
      const ioBefore = (await f.call({ action: "io" })).body;
      const unavailable = await f.call({ action: "cleanup", id: checkId, keyring: nextOnlyKeyring }); expect(unavailable.status).toBe(200);
      expect(checkedStorageCandidateCheck(unavailable.body)).toMatchObject({ revision: 1, status: "failed", cleanup: "required" });
      expect((await f.call({ action: "io" })).body).toEqual(ioBefore);
      const cleaned = await f.call({ action: "cleanup", id: checkId, keyring: nextKeyring }); expect(cleaned.status).toBe(200);
      expect(checkedStorageCandidateCheck(cleaned.body)).toMatchObject({ revision: 1, status: "failed", cleanup: "confirmed_absent" });
      const io = (await f.call({ action: "io" })).body as { calls: { method: string; authorization: string }[]; remaining: number };
      expect(io.calls.filter(call => call.method === "PUT")).toHaveLength(1); expect(io.remaining).toBe(0);
      const deletion = io.calls.filter(call => call.method === "DELETE").at(-1)!;
      expect(deletion.authorization).toContain("Credential=fixture-id-one/"); expect(deletion.authorization).toContain("/region-one/s3/aws4_request");
      expect(await f.db.prepare(checkSnapshotSql).bind(checkId).first()).toEqual(snapshot);
      expect((await f.db.prepare("SELECT latest_revision FROM system_storage_profiles WHERE id=?").bind(first.profileId).first())!.latest_revision).toBe(2);
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await f.dispose(); }
  }, 60_000);
});

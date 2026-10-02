import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkedStorageCandidateCheck } from "../../shared/contracts/storage-candidate-check";

describe("candidate checks with native Worker crypto and D1", () => {
  it("qualifies durable acceptance, DigestStream readback, no PUT replay and cleanup of the captured revision", async () => {
    const bundle = await build({ stdin: { contents: `
      import {saveStorageCandidate} from './configuration-registry';
      import {startStorageCandidateCheck,readStorageCandidateCheck,listStorageCandidateChecks,cleanupStorageCandidateCheck} from './candidate-check-service';
      const objects = new Map(), calls = [];
      let denyDelete = false;
      export default {async fetch(request, env) {
        const input = await request.json(), actor = 'admin@example.test';
        const options = {fetch: async request => {
          const accepted = await env.DB.prepare('SELECT id,write_outcome FROM system_storage_candidate_checks WHERE probe_key=?').bind(decodeURIComponent(new URL(request.url).pathname).split('/').slice(2).join('/')).first();
          if (!accepted || request.method === 'PUT' && accepted.write_outcome !== 'unknown') throw new Error('I/O without durable acceptance');
          calls.push({method:request.method,url:request.url,authorization:request.headers.get('authorization')});
          if (request.method === 'PUT') {objects.set(request.url, await request.arrayBuffer());return new Response(null,{status:200});}
          if (request.method === 'DELETE') {if(denyDelete)return new Response(null,{status:403});objects.delete(request.url);return new Response(null,{status:204});}
          const value=objects.get(request.url);
          if(!value)return new Response(null,{status:404});
          return new Response(request.method==='HEAD'?null:value.slice(0),{headers:{'content-length':String(value.byteLength),'content-type':'application/octet-stream'}});
        }};
        try {
          let value;
          if(input.action==='save')value=await saveStorageCandidate(env,input.command,actor);
          else if(input.action==='start')value=await startStorageCandidateCheck(env,input.command,actor,options);
          else if(input.action==='read')value=await readStorageCandidateCheck(env,input.id,actor);
          else if(input.action==='list')value=await listStorageCandidateChecks(env,input.profileId,actor);
          else if(input.action==='cleanup')value=await cleanupStorageCandidateCheck(env,input.id,actor,options);
          else if(input.action==='denyDelete'){denyDelete=input.value;value={ok:true};}
          else value={calls,remaining:objects.size};
          return Response.json(value);
        }catch(error){return Response.json({error:error.message},{status:error.status||503});}
      }};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
      bundle: true, format: "esm", platform: "browser", write: false });
    const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20", d1Databases: ["DB"],
      log: new Log(LogLevel.ERROR), bindings: { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test",
        STORAGE_CREDENTIAL_KEYRING: JSON.stringify({ version: 1, currentKeyId: "fixture-key", keys: { "fixture-key": btoa(String.fromCharCode(...new Uint8Array(32).fill(19))) } }) } });
    try {
      const db = await native.getD1Database("DB");
      for (const filename of ["0014_fp2_storage_configuration.sql", "0015_fp2_storage_candidate_checks.sql"]) {
        const sql = readFileSync(new URL(`../../migrations/${filename}`, import.meta.url), "utf8");
        const statements = sql.match(/CREATE (?:TABLE|(?:UNIQUE )?INDEX)[\s\S]*?;|CREATE TRIGGER[\s\S]*?\nEND;/g)!;
        await db.batch(statements.map(statement => db.prepare(statement)));
      }
      const call = async (value: unknown) => {
        const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify(value) });
        return { status: response.status, body: await response.json() };
      };
      const candidate = { expectedRevision: null, label: "Native check fixture", namespace: { kind: "s3", endpoint: "https://objects.example.test",
        bucket: "test-bucket", region: "region-one", root: "", forcePathStyle: true },
        credentials: { mode: "replace", value: { accessKeyId: "fixture-id-one", secretAccessKey: "fixture-secret-one" } } };
      const saved = await call({ action: "save", command: candidate }); expect(saved.status).toBe(200);
      const profileId = (saved.body as { profileId: string }).profileId;
      const command = { checkId: "55555555-5555-4555-8555-555555555555", profileId, expectedRevision: 1 };
      await call({ action: "denyDelete", value: true });
      const first = await call({ action: "start", command }); expect(first.status).toBe(200);
      expect(checkedStorageCandidateCheck(first.body)).toMatchObject({ status: "failed", write: "passed", read: "passed", metadata: "passed", cleanup: "required" });
      // Exercise the real D1-wrapped partial-index error. The fixture represents
      // an accepted execution that has not yet entered PUT, then is interrupted.
      const stored = await db.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").bind(command.checkId).first<Record<string, string | number | null>>();
      const activeId = "77777777-7777-4777-8777-777777777777", time = new Date().toISOString();
      const active = { ...stored!, id: activeId, probe_key: `__fp2_checks/${activeId}/native-active-fixture`, execution_token: "native-active-fixture",
        execution_deadline: new Date(Date.now() + 30_000).toISOString(), status: "running", write_outcome: "pending", read_outcome: "pending",
        metadata_outcome: "pending", delete_outcome: "pending", cleanup_outcome: "pending", result_code: null, created_at: time, updated_at: time, completed_at: null };
      const entries = Object.entries(active);
      await db.prepare(`INSERT INTO system_storage_candidate_checks (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`)
        .bind(...entries.map(([, value]) => value)).run();
      const competing = await call({ action: "start", command: { ...command, checkId: "88888888-8888-4888-8888-888888888888" } });
      expect(competing.status).toBe(409);
      expect(await db.prepare("SELECT id FROM system_storage_candidate_checks WHERE id=?").bind("88888888-8888-4888-8888-888888888888").first()).toBeNull();
      const interruptedAt = new Date().toISOString();
      await db.prepare("UPDATE system_storage_candidate_checks SET status='interrupted',cleanup_outcome='confirmed_absent',result_code='execution_interrupted',updated_at=?,completed_at=? WHERE id=?")
        .bind(interruptedAt, interruptedAt, activeId).run();
      const updated = await call({ action: "save", command: { ...candidate, profileId, expectedRevision: 1,
        namespace: { ...candidate.namespace, region: "region-two" }, credentials: { mode: "replace", value: { accessKeyId: "fixture-id-two", secretAccessKey: "fixture-secret-two" } } } });
      expect(updated.status).toBe(200);
      const repeated = await call({ action: "start", command }); expect(repeated.body).toEqual(first.body);
      expect((await call({ action: "start", command: { ...command, expectedRevision: 2 } })).status).toBe(409);
      await call({ action: "denyDelete", value: false });
      const cleaned = await call({ action: "cleanup", id: command.checkId }); expect(cleaned.status).toBe(200);
      expect(checkedStorageCandidateCheck(cleaned.body)).toMatchObject({ revision: 1, status: "failed", write: "passed", read: "passed", cleanup: "confirmed_absent" });
      const second = await call({ action: "start", command: { checkId: "66666666-6666-4666-8666-666666666666", profileId, expectedRevision: 2 } });
      expect(second.status).toBe(200); expect(checkedStorageCandidateCheck(second.body)).toMatchObject({ revision: 2, status: "succeeded", cleanup: "confirmed_absent" });
      const history = await call({ action: "list", profileId }); expect((history.body as { items: unknown[] }).items).toHaveLength(3);
      expect((await call({ action: "read", id: command.checkId })).body).toEqual(cleaned.body);
      const io = (await call({ action: "io" })).body as { calls: { method: string; authorization: string }[]; remaining: number };
      expect(io.calls.filter(entry => entry.method === "PUT")).toHaveLength(2); expect(io.remaining).toBe(0);
      const deletes = io.calls.filter(entry => entry.method === "DELETE");
      expect(deletes[1].authorization).toContain("Credential=fixture-id-one/");
      expect(deletes[1].authorization).toContain("/region-one/s3/aws4_request");
      expect(deletes[2].authorization).toContain("Credential=fixture-id-two/");
      expect((await db.prepare("SELECT count(*) AS n FROM system_storage_candidate_check_audit").first<{ n: number }>())!.n).toBeGreaterThan(10);
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await native.dispose(); }
  }, 30_000);
});

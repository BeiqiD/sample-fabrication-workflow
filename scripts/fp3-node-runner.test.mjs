import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const execute = promisify(execFile), root = new URL("../", import.meta.url);
test("two independent Node processes resume a persisted File job and a revoked actor cannot run its next job", { timeout: 120_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fp3-persisted-runner-"));
  let opened;
  try {
    const databasePath = join(scratch, "jobs.sqlite"), modulePath = join(scratch, "runtime.mjs"), bindingsPath = join(scratch, "bindings.mjs");
    await build({ entryPoints: [new URL("./lib/file-job-node-runtime.ts", import.meta.url).pathname], outfile: modulePath,
      bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const runtime = await import(pathToFileURL(modulePath).href);
    opened = runtime.openNodeFileJobRepository(databasePath);
    const sql = opened.database, migrations = new URL("migrations/", root);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) sql.exec(await readFile(new URL(name, migrations), "utf8"));
    // Qualified existing publications are the precondition of this runner test.
    // Only fixture construction bypasses their historical publication protocol;
    // every original guard is restored before accepting/executing any job.
    const triggers = sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY rowid").all();
    for (const trigger of triggers) sql.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    const now = new Date().toISOString(), bytes = new TextEncoder().encode("Persisted independent execution 验证"), sha = createHash("sha256").update(bytes).digest("hex");
    sql.prepare("UPDATE file_authority_control SET mode='active',activated_at=?,updated_at=?").run(now, now);
    sql.prepare("UPDATE file_authority_runtime_guard SET enabled=1,incarnation='fixture-authority',enabled_by='test',updated_at=?").run(now);
    for (const id of ["source", "target"]) {
      sql.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)")
        .run(id, JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: `node-fixture-${id}` }), now);
      sql.prepare("INSERT INTO storage_profile_runtime VALUES(?,'read_write',?,?,NULL)").run(id, now, now);
    }
    for (let index = 0; index < 2; index++) {
      sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES(?,'embedded_content','system',?,?,'unresolved',?)").run(`file-${index}`, bytes.length, sha, now);
      sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES(?,?,'source',?,'unresolved',?)").run(`source-${index}`, `file-${index}`, `original-${index}`, now);
      sql.prepare("INSERT INTO file_location_publications VALUES(?,?,'source',?,?,?,'full_read_sha256','fixture',?,?)")
        .run(`source-${index}`, `file-${index}`, `original-${index}`, bytes.length, sha, now, now);
      sql.prepare("INSERT INTO file_publications VALUES(?,'embedded_content','system',?,?,?,'ready',?,NULL)")
        .run(`file-${index}`, bytes.length, sha, `source-${index}`, now);
    }
    for (const trigger of triggers) sql.exec(trigger.sql);
    assert.deepEqual(sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY rowid").all(), triggers);
    assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
    const input = { requestId: "durable-process-restart", fileIds: ["file-0", "file-1"], target: { profileId: "target", configurationRevision: 1 } };
    const accepted = await opened.repository.accept(input, "admin@example.test");
    const profileRows = sql.prepare("SELECT id,namespace_identity FROM storage_profiles").all();
    opened.close(); opened = undefined;
    const objectsPath = join(scratch, "objects");
    const { mkdir } = await import("node:fs/promises"); await mkdir(objectsPath);
    const objectPath = (profile, key) => join(objectsPath, createHash("sha256").update(`${profile}\0${key}`).digest("hex"));
    for (let index = 0; index < 2; index++) await writeFile(objectPath("source", `original-${index}`), bytes);
    const bindings = authorized => `
      import {createHash} from 'node:crypto';
      import {readFile,writeFile,rename} from 'node:fs/promises';
      import {join} from 'node:path';
      const roots=new Map(${JSON.stringify(profileRows.map(row => [row.id, row.namespace_identity]))});
      const objectPath=(profile,key)=>join(${JSON.stringify(objectsPath)},createHash('sha256').update(profile+'\\0'+key).digest('hex'));
      export async function createFileJobBindings(){return {
        authorizeAdministrator:actor=>${authorized}&&actor==='admin@example.test',authorizeSystemCleanup:()=>true,
        async openStorage(target,access,guard){
          if(!roots.has(target.profileId)||target.configurationRevision!==1)throw new Error('Unknown fixture identity');
          return {namespaceIdentity:roots.get(target.profileId),adapterType:'r2',atomicSinglePut:true,
            createHash:()=>{const hash=createHash('sha256');return {async write(bytes){hash.update(bytes)},async finish(){return hash.digest('hex')},async abort(){}}},
            reader:{async read(key){if(!await guard({method:'GET',key}))return {outcome:'unavailable'};try{const bytes=await readFile(objectPath(target.profileId,key));return {outcome:'available',body:new Response(bytes).body,contentType:'application/octet-stream',etag:null,httpMetadata:{}}}catch{return {outcome:'missing'}}},async stat(){return {outcome:'unavailable'}}},
            ...(access==='write'?{writer:{accepts:'stream',async write(input){if(!await guard({method:'PUT',key:input.key}))throw new Error('Not authorized');const path=objectPath(target.profileId,input.key),tmp=path+'.staging';await writeFile(tmp,new Uint8Array(await new Response(input.body).arrayBuffer()));await rename(tmp,path);}}}:{}),
          };
        }
      }};`;
    // This test transport is an isolated disk fixture, not a Node R2 adapter or
    // real-provider qualification. The persisted repository/kernel are real.
    await writeFile(bindingsPath, bindings(true));
    const run = async enable => execute(process.execPath, [new URL("./run-file-jobs.mjs", import.meta.url).pathname,
      "--db", databasePath, "--bindings", bindingsPath, "--once", ...(enable ? ["--enable"] : [])], { timeout: 60_000, maxBuffer: 128 * 1024 });
    const beforeEnabling = (await readdir(objectsPath)).sort();
    await run(true);
    opened = runtime.openNodeFileJobRepository(databasePath);
    // Enabling an installation is not permission to replay previously queued
    // work. A restored disabled installation has the same boundary; only an
    // explicit per-job resume can authorize its next independently invoked step.
    assert.equal((await opened.repository.status(accepted.id)).state, "paused");
    assert.equal((await opened.repository.status(accepted.id)).moved, 0);
    assert.deepEqual((await readdir(objectsPath)).sort(), beforeEnabling);
    await opened.repository.control(accepted.id, "resume");
    opened.close(); opened = undefined;
    await run(false);
    opened = runtime.openNodeFileJobRepository(databasePath);
    assert.equal((await opened.repository.status(accepted.id)).moved, 1);
    const incarnation = opened.database.prepare("SELECT incarnation FROM file_job_runtime_guard").get().incarnation;
    opened.close(); opened = undefined;
    await run(false);
    opened = runtime.openNodeFileJobRepository(databasePath);
    assert.equal(opened.database.prepare("SELECT incarnation FROM file_job_runtime_guard").get().incarnation, incarnation);
    assert.equal((await opened.repository.status(accepted.id)).state, "completed");
    assert.equal((await opened.repository.status(accepted.id)).moved, 2);
    assert.equal(opened.database.prepare("SELECT count(*) AS count FROM file_migration_attempts WHERE state='published'").get().count, 2);
    assert.deepEqual(opened.database.prepare("SELECT id FROM files ORDER BY id").all().map(row => row.id), input.fileIds);
    const denied = await opened.repository.accept({ requestId: "revoked-next-process", fileIds: input.fileIds,
      target: { profileId: "source", configurationRevision: 1 } }, "admin@example.test");
    opened.close(); opened = undefined;
    const before = (await readdir(objectsPath)).sort(); await writeFile(bindingsPath, bindings(false));
    await run(false);
    opened = runtime.openNodeFileJobRepository(databasePath);
    assert.equal((await opened.repository.status(denied.id)).state, "paused");
    assert.equal((await opened.repository.status(denied.id)).reason, "administrator_revoked");
    assert.deepEqual((await readdir(objectsPath)).sort(), before);
    assert.deepEqual(opened.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { opened?.close(); await rm(scratch, { recursive: true, force: true }); }
});

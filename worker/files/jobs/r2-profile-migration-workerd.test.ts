import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { expect, it } from "vitest";
import { normalizeSchemaSql } from "../../../scripts/d1-migration-plan.mjs";

const installationId = "10000000-0000-4000-8000-000000000001";
const namespace = (bucketName: string) => JSON.stringify({ kind: "local-r2", installationId, bucketName });
const sourceNamespace = namespace("source-native-fixture"), targetNamespace = namespace("target-native-fixture");

it("migrates between distinct native R2 bindings while preserving a stable File and protecting reads and unresolved legacy occurrences from GC", async () => {
  const length = 8 * 1024 * 1024, hash = createHash("sha256");
  for (let offset = 0; offset < length; offset += 65536) hash.update(new Uint8Array(65536).fill(61));
  const sha256 = hash.digest("hex"), sourceKey = "original/%2F shared key";
  const bundle = await build({ stdin: { contents: `
    import { d1FileJobRepository } from './d1-repository';
    import { runFileJobStep,runFileJobCleanupStep } from './migration-kernel';
    import { openShadowProfile } from '../shadow-profile';
    import { readPublishedFile } from '../authority-reader';
    import { verifyByteStream } from '../byte-verification';
    import { cloudflareSha256 } from '../storage-adapters/cloudflare-sha256';
    import { runFileGarbageCollection } from '../authority-gc';
    import { FILE_JOB_SOURCE_GRACE_MS } from '../../../shared/contracts/file-jobs';
    import { BLOB_ORPHAN_GRACE_MS,BLOB_REGISTRATION_GRACE_MS } from '../../blob-lifecycle/reachability';
    export default {async fetch(request,env){
      const input=await request.json(),expected={byteSize:input.length,sha256:input.sha256};
      const fixed=new FixedLengthStream(input.length),writer=fixed.writable.getWriter();
      const fill=(async()=>{for(let at=0;at<input.length;at+=65536)await writer.write(new Uint8Array(Math.min(65536,input.length-at)).fill(61));await writer.close();})();
      await Promise.all([env.ASSETS.put(input.sourceKey,fixed.readable,{httpMetadata:{contentType:'image/png'}}),fill]);
      const targetInitiallyAbsent=await env.R2_TARGET.head(input.sourceKey)===null;
      const old=await readPublishedFile(env,{fileId:'stable-file',purpose:'embedded_content'});
      if(old.outcome!=='available')return Response.json({error:'original_read_unavailable',outcome:old.outcome});
      const holdCount=async()=>Number((await env.DB.prepare("SELECT count(*) n FROM file_location_holds WHERE location_id='source-location' AND hold_kind='read' AND released_at IS NULL").first()).n);
      const heldBefore=await holdCount();
      let instant=new Date(),maxHashChunk=0;
      const repository=d1FileJobRepository(env.DB,()=>instant);
      const capabilities={repository,incarnation:'native-r2-jobs',now:()=>instant,randomId:()=>crypto.randomUUID(),
        authorizeAdministrator:()=>true,authorizeSystemCleanup:()=>true,
        async openStorage(target,access,beforeRequest,signal){
          const opened=await openShadowProfile(env,target,access,{beforeRequest,signal});
          const createHash=()=>{const digest=opened.createHash();return {write(bytes){maxHashChunk=Math.max(maxHashChunk,bytes.length);return digest.write(bytes);},finish:()=>digest.finish(),abort:()=>digest.abort()};};
          return {...opened,namespaceIdentity:opened.storage.namespaceIdentity,adapterType:opened.storage.adapterType,atomicSinglePut:true,createHash};
        }};
      const job=await repository.accept({requestId:crypto.randomUUID(),fileIds:['stable-file'],target:{profileId:'target-profile',configurationRevision:1}},'fixture-admin');
      const moved=await runFileJobStep(capabilities);
      const current=await env.DB.prepare("SELECT f.file_id,l.storage_profile_id,l.object_key FROM file_publications f JOIN file_locations l ON l.id=f.active_location_id WHERE f.file_id='stable-file'").first();
      const fresh=await readPublishedFile(env,{fileId:'stable-file',purpose:'embedded_content'});
      if(fresh.outcome!=='available'){await old.body.cancel();return Response.json({error:'new_read_unavailable',moved,current,outcome:fresh.outcome});}
      const targetVerified=await verifyByteStream(fresh.body,expected,cloudflareSha256,'destination');
      await repository.requestCleanup(job.id,'fixture-cleanup');
      // Simulate elapsed source grace in the isolated fixture. The production
      // repository intentionally compares this scheduler field to SQLite time.
      await env.DB.prepare('UPDATE file_migration_items SET cleanup_not_before=? WHERE job_id=?')
        .bind(new Date(Date.now()-1000).toISOString(),job.id).run();
      instant=new Date(instant.getTime()+Math.max(FILE_JOB_SOURCE_GRACE_MS,BLOB_REGISTRATION_GRACE_MS)+1000);
      const cleanup=await runFileJobCleanupStep(capabilities);
      const blockedGc=await runFileGarbageCollection(env,instant);
      const heldDuring=await holdCount(),sourceDuring=await env.ASSETS.head(input.sourceKey)!==null;
      const oldVerified=await verifyByteStream(old.body,expected,cloudflareSha256,'source');
      const heldAfter=await holdCount();
      const unknownRetained=await env.DB.prepare("SELECT count(*) n FROM blob_retention_edges WHERE occurrence_id='unknown-event' AND occurrence_type='event' AND object_key=?").bind(input.sourceKey).first();
      const unknownBlockedGc=await runFileGarbageCollection(env,instant),sourceWithUnknown=await env.ASSETS.head(input.sourceKey)!==null;
      // Full native source/destination reads above have established this File's
      // content. Resolve the actual historical business occurrence, preserving
      // its opaque key and every installed fill-once/purpose/publication guard.
      await env.DB.prepare("UPDATE events SET asset_file_id='stable-file' WHERE id='unknown-event' AND asset_file_id IS NULL AND asset_key=?").bind(input.sourceKey).run();
      const resolvedUnknown=await env.DB.prepare("SELECT asset_key,asset_file_id FROM events WHERE id='unknown-event'").first();
      const marked=await runFileGarbageCollection(env,instant);
      const deleted=await runFileGarbageCollection(env,new Date(instant.getTime()+BLOB_ORPHAN_GRACE_MS+1000));
      const sourceAfter=await env.ASSETS.head(input.sourceKey)!==null,targetAfter=await env.R2_TARGET.head(current.object_key)!==null;
      const final=await readPublishedFile(env,{fileId:'stable-file',purpose:'embedded_content'});
      let finalVerified=null;if(final.outcome==='available')finalVerified=await verifyByteStream(final.body,expected,cloudflareSha256,'destination');
      const fk=await env.DB.prepare('PRAGMA foreign_key_check').all();
      return Response.json({targetInitiallyAbsent,heldBefore,heldDuring,heldAfter,moved,current,cleanup,blockedGc,marked,deleted,
        sourceDuring,sourceWithUnknown,sourceAfter,targetAfter,targetVerified,oldVerified,finalVerified,maxHashChunk,fk:fk.results,
        unknownRetained:Number(unknownRetained.n),resolvedUnknown,unknownBlockedGc,
        sourceRoots:(await env.DB.prepare("SELECT * FROM file_location_retention_edges WHERE location_id='source-location'").all()).results,
        keyRoots:(await env.DB.prepare("SELECT * FROM blob_retention_edges WHERE object_key=?").bind(input.sourceKey).all()).results,
        sourceLedger:await env.DB.prepare("SELECT * FROM file_location_gc_ledger WHERE location_id='source-location'").first(),
        alias:await env.DB.prepare("SELECT r2_key,file_id FROM assets WHERE id='historical-alias'").first()});
    }};`, loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)) },
    bundle: true, format: "esm", platform: "browser", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], d1Persist: mkdtempSync(join(tmpdir(), "native-r2-migration-d1-")),
    r2Buckets: { ASSETS: "source-native-fixture", R2_TARGET: "target-native-fixture" },
    bindings: { R2_BOOTSTRAP_NAMESPACE: sourceNamespace,
      R2_PROFILE_BINDINGS: JSON.stringify({ "target-profile": { namespaceIdentity: targetNamespace, bindingName: "R2_TARGET" } }) },
    log: new Log(LogLevel.ERROR) });
  const persistedD1 = native.unsafeGetPersistPaths().get("d1")!;
  let disposed = false;
  try {
    const db = await native.getD1Database("DB"), migrations = new URL("../../../migrations/", import.meta.url);
    const chain = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()
      .map(filename => ({ filename, sql: readFileSync(new URL(filename, migrations), "utf8") }));
    await db.prepare("CREATE TABLE d1_migrations(name TEXT PRIMARY KEY NOT NULL)").run();
    for (const entry of chain.filter(entry => entry.filename < "0018_")) {
      await db.batch([...splitSql(entry.sql).map(sql => db.prepare(sql)), db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(entry.filename)]);
    }
    await db.batch(splitSql(readFileSync(new URL("../../fixtures/reference-graph.sql", import.meta.url), "utf8")).map(sql => db.prepare(sql)));
    const retainedNow = "2026-10-05T00:00:00.000Z", retainedSha = "a".repeat(64);
    await db.batch([
      db.prepare(`INSERT INTO storage_profiles(rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
        VALUES(-9007199254740993,'retained-profile','r2',?,'bootstrap',NULL,1,'historical',?)`).bind(namespace("retained-native-fixture"), retainedNow),
      db.prepare(`INSERT INTO r2_upload_requests(id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,request_input_json,request_scope,
        storage_profile_id,storage_profile_revision,storage_policy_revision,candidate_asset_id,candidate_object_key,status,created_at,expires_at)
        VALUES('10000000-0000-4000-8000-000000000011','retained@example.test','10000000-0000-4000-8000-000000000012',
          '10000000-0000-4000-8000-000000000013','ordinary_image','embedded_content',?,?,'system','retained-profile',1,1,
          '10000000-0000-4000-8000-000000000014','retained/candidate','pending',?,'2026-10-06T00:00:00.000Z')`)
        .bind(retainedSha, JSON.stringify({ schema: "r2-upload-request/1", ingress: "ordinary_image", purpose: "embedded_content", scope: "system",
          file: { originalName: "retained.png", mimeType: "image/png", byteSize: 4, sha256: retainedSha } }), retainedNow),
      db.prepare("UPDATE assets SET rowid=9223372036854775806 WHERE id='reference-execution-asset'"),
    ]);
    const oldTables = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name<>'d1_migrations' ORDER BY name").all()).results as { name: string; sql: string }[];
    const information = await db.batch(oldTables.map(table => db.prepare(`PRAGMA table_info("${table.name}")`)));
    const captures = oldTables.map((table, index) => {
      const columns = information[index].results as { name: string; pk: number }[];
      const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const withoutRowid = /\bWITHOUT ROWID\b/i.test(table.sql);
      const order = withoutRowid ? columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => quoted(column.name)).join(",") : "rowid";
      // Cast before crossing the JS/RPC boundary: every signed int64 cell and
      // rowid is compared exactly, including values beyond Number precision.
      const cells = columns.flatMap(column => [`typeof(${quoted(column.name)})`, `iif(typeof(${quoted(column.name)})='blob',hex(${quoted(column.name)}),CAST(${quoted(column.name)} AS TEXT))`]);
      return { name: table.name, sql: `SELECT ${withoutRowid ? "" : "CAST(rowid AS TEXT) rowid,"}json_array(${cells.join(",")}) cells FROM ${quoted(table.name)} ORDER BY ${order}` };
    });
    const before = (await db.batch(captures.map(capture => db.prepare(capture.sql)))).map(result => result.results);
    for (const entry of chain.filter(entry => entry.filename >= "0018_")) {
      const statements = splitSql(entry.sql);
      await db.batch([...statements.map(sql => db.prepare(sql)), db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(entry.filename)]);
    }
    const after = (await db.batch(captures.map(capture => db.prepare(capture.sql)))).map(result => result.results);
    for (let index = 0; index < captures.length; index++) expect(after[index], `Native D1 previous cells/rowids: ${captures[index].name}`).toEqual(before[index]);
    expect((await db.prepare("SELECT CAST(rowid AS TEXT) rowid FROM assets WHERE id='reference-execution-asset'").first())!.rowid).toBe("9223372036854775806");
    expect((await db.prepare("SELECT CAST(rowid AS TEXT) rowid FROM storage_profiles WHERE id='retained-profile'").first())!.rowid).toBe("-9007199254740993");
    expect((await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all()).results.map(row => row.name)).toEqual(chain.map(entry => entry.filename));
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    // workerd v1.20260714.1 util/sqlite.c++ sets SQLITE_LIMIT_VDBE_OP=25000;
    // its pinned SQLite 3.47.0 src/vdbeaux.c::growOpArray doubles allocation
    // and returns SQLITE_NOMEM at that compiler ceiling. The 0020 schema's
    // whole quick_check exceeds the last supported allocation (21504 ops).
    // Native table checks retain each table/index B-tree, row count and
    // CHECK/NOT NULL check, including the sqlite_schema freelist check. They
    // do not establish cross-table page ownership or detect unused pages;
    // a whole check on the exact closed native file below covers that gap.
    const tableCoverageSql = "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' ORDER BY name";
    const checkedTables = ["sqlite_schema", ...(await db.prepare(tableCoverageSql).all()).results.map(row => String(row.name))].sort();
    const nativeChecks = await db.batch(checkedTables.map(name => db.prepare(`PRAGMA quick_check("${name.replaceAll('"', '""')}")`)));
    for (let index = 0; index < checkedTables.length; index++) expect(nativeChecks[index].results, `Native table/index quick_check: ${checkedTables[index]}`).toEqual([{ quick_check: "ok" }]);
    const catalogSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name<>'d1_migrations' ORDER BY type,name";
    const normalize = (rows: { sql: string | null }[]) => rows.map(row => ({ ...row, sql: row.sql === null ? null : normalizeSchemaSql(row.sql) }));
    const expected = new DatabaseSync(":memory:");
    try {
      expected.exec("PRAGMA foreign_keys=ON");
      for (const entry of chain) expected.exec(entry.sql);
      expect(checkedTables).toEqual(["sqlite_schema", "d1_migrations", ...expected.prepare(tableCoverageSql).all().map(row => String(row.name))].sort());
      expect(normalize((await db.prepare(catalogSql).all()).results as { sql: string | null }[])).toEqual(normalize(expected.prepare(catalogSql).all() as { sql: string | null }[]));
    } finally { expected.close(); }
    const triggers = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all()).results as { name: string; sql: string }[];
    const now = new Date().toISOString();
    // The existing development fixture models authority cutover once. Reinstall
    // every real guard before any read, accepted job, transport or collector.
    const seed = [
      ...triggers.map(trigger => db.prepare(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`)),
      db.prepare("UPDATE file_authority_control SET mode='active',activated_at=?,updated_at=?").bind(now, now),
      db.prepare("UPDATE file_authority_runtime_guard SET enabled=1,incarnation='native-r2-authority',enabled_by='test',updated_at=?").bind(now),
      db.prepare("UPDATE file_job_runtime_guard SET enabled=1,incarnation='native-r2-jobs'"),
      ...[["source-profile", sourceNamespace], ["target-profile", targetNamespace]].flatMap(([id, physical]) => [
        db.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)").bind(id, physical, now),
        db.prepare("INSERT INTO storage_profile_runtime VALUES(?,'read_write',?,?,NULL)").bind(id, now, now),
      ]),
      db.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES('stable-file','embedded_content','system',?,?,'unresolved',?)").bind(length, sha256, now),
      db.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES('source-location','stable-file','source-profile',?,'unresolved',?)").bind(sourceKey, now),
      db.prepare("INSERT INTO file_location_publications VALUES('source-location','stable-file','source-profile',?,?,?,'full_read_sha256','fixture',?,?)").bind(sourceKey, length, sha256, now, now),
      db.prepare("INSERT INTO file_publications VALUES('stable-file','embedded_content','system',?,?,'source-location','ready',?,NULL)").bind(length, sha256, now),
      db.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','R2-NATIVE','Native R2 migration',?,?)").bind(now, now),
      db.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('historical-alias',?,'source.png','image/png',?,'ready',?,?)").bind(sourceKey, length, sha256, now),
      db.prepare("INSERT INTO events(id,sample_id,kind,asset_key,asset_file_id,metadata_json,created_at) VALUES('event','sample','image',?,'stable-file',?,?)")
        .bind(sourceKey, JSON.stringify({ assetId: "historical-alias" }), now),
      db.prepare("INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at) VALUES('unknown-event','sample','image',?,'{\"action\":\"sample_record\"}',?)")
        .bind(sourceKey, now),
      db.prepare("INSERT INTO legacy_file_mappings VALUES('r2','r2',?,'stable-file','source-location','classified','{}',?)").bind(sourceKey, now),
      ...triggers.map(trigger => db.prepare(trigger.sql)),
    ];
    await db.batch(seed);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger'").first())!.n).toBe(triggers.length);
    const response = await native.dispatchFetch("https://native-r2.test", { method: "POST", body: JSON.stringify({ length, sha256, sourceKey }) });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as Record<string, any>;
    expect(result, JSON.stringify(result)).not.toHaveProperty("error");
    expect(result, JSON.stringify(result)).toMatchObject({ targetInitiallyAbsent: true, heldBefore: 1, heldDuring: 1, heldAfter: 0,
      moved: { outcome: "moved" }, current: { file_id: "stable-file", storage_profile_id: "target-profile" },
      cleanup: { outcome: "released_to_gc" }, sourceDuring: true, sourceAfter: false, targetAfter: true, fk: [],
      sourceWithUnknown: true, unknownRetained: 1, resolvedUnknown: { asset_key: sourceKey, asset_file_id: 'stable-file' },
      unknownBlockedGc: { orphanCandidatesMarked: 0, imageDeleted: 0 },
      blockedGc: { orphanCandidatesMarked: 0, imageDeleted: 0 }, marked: { orphanCandidatesMarked: 1 }, deleted: { imageDeleted: 1 },
      alias: { r2_key: sourceKey, file_id: null } });
    expect(result.targetVerified).toMatchObject({ byteSize: length, sha256 });
    expect(result.oldVerified).toMatchObject({ byteSize: length, sha256 });
    expect(result.finalVerified).toMatchObject({ byteSize: length, sha256 });
    expect(result.maxHashChunk).toBeLessThanOrEqual(65536);
    expect(await (await native.getR2Bucket("ASSETS")).head(sourceKey)).toBeNull();
    expect(await (await native.getR2Bucket("R2_TARGET")).head(result.current.object_key)).not.toBeNull();
    await native.dispose(); disposed = true;
    const files = readdirSync(persistedD1, { recursive: true }).filter((file): file is string => typeof file === "string" && file.endsWith(".sqlite") && !file.endsWith("metadata.sqlite"));
    expect(files).toHaveLength(1);
    const exactNative = new DatabaseSync(join(persistedD1, files[0]), { readOnly: true });
    try {
      // This is the persisted native database, not the empty expected catalog.
      expect(exactNative.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map(row => row.name)).toEqual(chain.map(entry => entry.filename));
      expect(exactNative.prepare("SELECT storage_profile_id FROM file_locations WHERE id=(SELECT active_location_id FROM file_publications WHERE file_id='stable-file')").get()).toEqual({ storage_profile_id: "target-profile" });
      expect(exactNative.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      expect(exactNative.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { exactNative.close(); }
  } finally { if (!disposed) await native.dispose(); rmSync(persistedD1, { recursive: true, force: true }); }
}, 120_000);

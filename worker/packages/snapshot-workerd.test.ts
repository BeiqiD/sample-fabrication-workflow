import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { expect, it } from "vitest";
import { RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES, RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES } from "../../shared/contracts/research-package";
import { fileShadowSchemaFingerprint } from "../../shared/contracts/export-file-shadow";
import { contentExportSchemaObjects } from "../../shared/contracts/storage-configuration-schema";
import { RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-research-packages";
import type { ExportSchemaObject } from "../../shared/contracts/export";

/** Real native D1 executes the production closure/capture statement set. The
 * source File is produced by the installed ordinary accepted writer and verified
 * against an isolated native R2 object; only future active-authority control is
 * simulated, with its exact guard restored before any upload/capture. */
it("captures verified native source bytes and exact export holds atomically, and rolls back invalid roots and oversized records", async () => {
  const namespace = JSON.stringify({ kind: "local-r2", installationId: "10000000-0000-4000-8000-000000000001", bucketName: "package-capture-native" });
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", contents: String.raw`
    import { buildPackageSnapshotStatements,previewPackageSnapshot,readPackageSnapshot } from './snapshot';
    import { d1FileJobDatabase } from '../files/jobs/d1-repository';
    import { acceptAndUploadR2Asset } from '../uploads/r2-upload-acceptance';
    import { setStorageRoleDefaults } from '../storage/storage-role-policy';
    import { validateResearchPackage,researchRecordsDocument,RESEARCH_PACKAGE_MAX_RECORD_BYTES } from '../../shared/contracts/research-package';
    import { checkedResearchPackagePreview } from '../../shared/contracts/research-package-api';
    const actor='capture-admin@example.test';
    export default {async fetch(request,env){const input=await request.json(),db=d1FileJobDatabase(env.DB).primary();
      if(input.setup){
        await setStorageRoleDefaults(env,{operationId:crypto.randomUUID(),expectedPolicyRevision:null,internalProfileId:'profile',originalsProfileId:'profile'},actor);
        const receipt=await acceptAndUploadR2Asset(env,{requestId:crypto.randomUUID(),actorEmail:actor,ingress:'ordinary_image',originalName:'native.png',mimeType:'image/png',bytes:new TextEncoder().encode('native capture bytes').buffer});
        if(receipt.state.status!=='ready')throw new Error('Source publication failed');
        const result=receipt.state.result;
        const file=await env.DB.prepare('SELECT c.result_file_id FROM file_acceptance_candidates c JOIN r2_upload_requests r ON r.id=c.acceptance_id WHERE c.acceptance_kind=\'r2_upload\' AND c.item_id=\'\' AND c.state=\'ready\' AND r.actor_email=? AND r.client_request_id=? AND r.status=\'ready\' AND r.candidate_asset_id=? AND c.candidate_object_key=r.candidate_object_key AND c.storage_profile_id=r.storage_profile_id').bind(actor,receipt.state.requestId,result.id).first();
        if(!file)throw new Error('Ready source receipt has no matching published File');
        const now=new Date().toISOString();
        await env.DB.batch([env.DB.prepare('INSERT INTO samples(id,code,title,created_at,updated_at) VALUES(\'selected\',\'SELECTED\',\'Selected source\',?,?)').bind(now,now),
          env.DB.prepare('INSERT INTO samples(id,code,title,created_at,updated_at) VALUES(\'unrelated\',\'UNRELATED\',\'Other source\',?,?)').bind(now,now),
          env.DB.prepare('INSERT INTO events(id,sample_id,kind,asset_key,asset_file_id,metadata_json,created_at) VALUES(\'source-event\',\'selected\',\'image\',?,?,?,?)').bind(result.key,file.result_file_id,JSON.stringify({assetId:result.id}),now)]);
        return Response.json({ready:true,fileId:file.result_file_id});
      }
      if(input.preview){const statements=[],track=base=>({...base,prepare(sql){return{bind(...values){statements.push({sql,values});return base.prepare(sql).bind(...values)}}},primary(){return track(base.primary())}});
        try{return Response.json(checkedResearchPackagePreview(await previewPackageSnapshot(track(db),{actor,roots:[{kind:'sample',id:'selected'}],kind:'data_package'})));}
        catch(cause){for(const[index,statement]of statements.entries())try{await env.DB.prepare('EXPLAIN '+statement.sql).bind(...statement.values).first();}catch(compilation){throw new Error('Native preview read '+index+': '+statement.sql.slice(-300).replace(/\s+/g,' ')+'; '+String(compilation),{cause:compilation});}throw cause;}}
      const id=crypto.randomUUID(),now=new Date().toISOString(),identity=await db.prepare('SELECT installation_id FROM research_package_source_identity WHERE singleton=1').first();
      const roots=[{kind:'sample',id:input.invalidRoot?'absent':'selected'}];
      if(input.oversized)await env.DB.prepare('UPDATE samples SET title=? WHERE id=\'selected\'').bind('x'.repeat(RESEARCH_PACKAGE_MAX_RECORD_BYTES)).run();
      const source={jobId:id,actor,roots,packageId:id,sourceInstallationId:identity.installation_id,createdAt:now};
      const before=await db.prepare('SELECT count(*) n FROM file_location_holds WHERE hold_kind=\'export\'').first();
      const started=performance.now();let committed=true,error=null;
      const compiled=[],captureDb={...db,prepare(sql){return{bind(...values){compiled.push({sql,values});return db.prepare(sql).bind(...values)}}}};
      try{await db.batch([db.prepare('INSERT INTO research_package_jobs(id,request_id,actor,kind,input_json,package_id,source_installation_id,accepted_at,target_policy_json,state,phase,updated_at) VALUES(?,?,?,\'data_package\',?,?,?,?,\'{}\',\'queued\',\'snapshot\',?)').bind(id,id,actor,JSON.stringify({kind:'data_package',roots}),id,identity.installation_id,now,now),...buildPackageSnapshotStatements(captureDb,source)]);}catch(cause){committed=false;error=String(cause);
        if(/too many (?:terms in compound SELECT|references to)/.test(error))for(const [index,statement]of compiled.entries())try{await env.DB.prepare('EXPLAIN '+statement.sql).bind(...statement.values).first();}catch(compilation){error+='; capture statement '+index+': '+statement.sql.slice(-300).replace(/\s+/g,' ')+'; '+String(compilation);break;}}
      const elapsedMs=performance.now()-started;
      const counts=await db.prepare('SELECT (SELECT count(*) FROM research_package_jobs WHERE id=?) jobs,(SELECT count(*) FROM research_package_records WHERE job_id=?) records,(SELECT count(*) FROM research_package_files WHERE job_id=?) files,(SELECT count(*) FROM file_location_holds WHERE hold_kind=\'export\') holds').bind(id,id,id).first();
      let snapshot=null,pinned=null,holds=[];
      if(committed){snapshot=await readPackageSnapshot(db,id);const {records,...manifest}=snapshot;await validateResearchPackage(manifest,researchRecordsDocument(records));
        pinned=await db.prepare('SELECT f.source_file_id,f.source_location_id,f.source_profile_id,f.source_object_key,p.active_location_id,l.storage_profile_id,l.object_key FROM research_package_files f JOIN file_publications p ON p.file_id=f.source_file_id JOIN file_location_publications l ON l.location_id=p.active_location_id WHERE f.job_id=?').bind(id).first();
        holds=(await db.prepare('SELECT h.location_id,h.hold_kind,h.released_at FROM file_location_holds h JOIN research_package_files f ON f.hold_operation_id=h.operation_id WHERE f.job_id=?').bind(id).all()).results;}
      return Response.json({committed,error,elapsedMs,before:before.n,counts,snapshot,pinned,holds,fk:(await db.prepare('PRAGMA foreign_key_check').all()).results});
    }};` }, bundle: true, platform: "browser", format: "esm", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], r2Buckets: { ASSETS: "package-capture-native" }, log: new Log(LogLevel.ERROR),
    bindings: { R2_BOOTSTRAP_NAMESPACE: namespace, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "capture-admin@example.test" } });
  try {
    const db = await native.getD1Database("DB"), directory = new URL("../../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql") && name <= "0020_fp4_research_packages.sql").sort()) {
      const statements = splitSql(readFileSync(new URL(name, directory), "utf8"));
      try { await db.batch(statements.map(sql => db.prepare(sql))); }
      catch (cause) {
        if (name === "0020_fp4_research_packages.sql") for (const [index, sql] of statements.entries()) {
          try { await db.prepare(sql).run(); }
          catch (statementCause) { throw new Error(`Native capture schema ${name} statement ${index}: ${sql.slice(0, 220).replace(/\s+/g, " ")}`, { cause: statementCause }); }
        }
        throw new Error(`Native capture schema installation failed at ${name}`, { cause });
      }
    }
    const schema = (await db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name")
      .all<ExportSchemaObject>()).results;
    expect(await fileShadowSchemaFingerprint(contentExportSchemaObjects(schema))).toBe(RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256);
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'capture-fixture',? FROM file_shadow_control").bind(now).run();
    await db.prepare("INSERT INTO storage_profiles VALUES('profile','r2',?,'bootstrap',NULL,1,'historical',?)").bind(namespace, now).run();
    await db.prepare("INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'capture-fixture',?)").bind(now).run();
    const control = await db.prepare("SELECT sql FROM sqlite_schema WHERE name='file_authority_control_update_guard'").first<{ sql: string }>();
    await db.batch([db.prepare("DROP TRIGGER file_authority_control_update_guard"),
      db.prepare("UPDATE file_authority_control SET mode='active',updated_at=?").bind(now),
      db.prepare("UPDATE file_authority_runtime_guard SET incarnation='capture-native-authority',enabled=1,enabled_by='test',updated_at=?").bind(now), db.prepare(control!.sql)]);
    const invoke = async (value: object) => {
      const response = await native.dispatchFetch("https://capture.test", { method: "POST", body: JSON.stringify(value) });
      expect(response.status, await response.clone().text()).toBe(200); return await response.json() as Record<string, any>;
    };
    expect(await invoke({ setup: true })).toMatchObject({ ready: true });
    const preview = await invoke({ preview: true });
    expect(preview.dependencies).toEqual([{ targetType: "sample", id: "selected", outcome: "included", reason: "owning_context", label: "SELECTED: Selected source" }]);
    expect(preview.counts.files).toBe(1);
    expect(await db.prepare("SELECT (SELECT count(*) FROM research_package_jobs) jobs,(SELECT count(*) FROM file_location_holds WHERE hold_kind='export') holds").first())
      .toEqual({ jobs: 0, holds: 0 });
    const valid = await invoke({});
    expect(valid.committed, valid.error).toBe(true); expect(valid.counts).toMatchObject({ jobs: 1, files: 1 });
    expect(preview.counts.records).toBe(valid.counts.records);
    expect(valid.pinned.source_location_id).toBe(valid.pinned.active_location_id);
    expect(valid.pinned.source_profile_id).toBe(valid.pinned.storage_profile_id); expect(valid.pinned.source_object_key).toBe(valid.pinned.object_key);
    expect(valid.holds).toEqual([{ location_id: valid.pinned.source_location_id, hold_kind: "export", released_at: null }]);
    expect(valid.snapshot.records.some((record: any) => record.sourceId === "unrelated")).toBe(false);
    expect(valid.fk).toEqual([]);
    for (const rejected of [await invoke({ invalidRoot: true }), await invoke({ oversized: true })]) {
      expect(rejected.committed).toBe(false); expect(rejected.counts).toEqual({ jobs: 0, records: 0, files: 0, holds: rejected.before }); expect(rejected.fk).toEqual([]);
    }
    // Qualify the actual D1 TEXT-cell boundary using inert, paused metadata
    // receipts. These rows carry no File, provider claim, or execution grant.
    for (const [column, maximum] of [["domain_plan_json", RESEARCH_PACKAGE_MAX_IMPORT_PLAN_BYTES],
      ["frozen_archive_json", RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES]] as const) {
      const identity = await db.prepare("SELECT installation_id FROM research_package_source_identity").first<{ installation_id: string }>();
      const empty = JSON.stringify({ padding: "" }), exact = JSON.stringify({ padding: "x".repeat(maximum - new TextEncoder().encode(empty).byteLength) });
      expect(new TextEncoder().encode(exact)).toHaveLength(maximum);
      const insert = (id: string, value: string) => db.prepare(`INSERT INTO research_package_jobs(id,request_id,actor,kind,input_json,package_id,
        source_installation_id,accepted_at,target_policy_json,state,phase,updated_at,${column})
        VALUES(?,?,?,'report','{"kind":"report","roots":[{"kind":"sample","id":"selected"}]}',?,?,?,'{}','paused','snapshot',?,?)`)
        .bind(id, id, "capture-admin@example.test", id, identity!.installation_id, now, now, value);
      await insert(`exact-${column}`, exact).run();
      expect(await db.prepare(`SELECT length(CAST(${column} AS BLOB)) bytes,json_valid(${column}) valid FROM research_package_jobs WHERE id=?`)
        .bind(`exact-${column}`).first()).toEqual({ bytes: maximum, valid: 1 });
      const over = JSON.stringify({ padding: "x".repeat(maximum - new TextEncoder().encode(empty).byteLength + 1) });
      await expect(insert(`over-${column}`, over).run()).rejects.toThrow();
      expect(await db.prepare("SELECT count(*) n FROM research_package_jobs WHERE id=?").bind(`over-${column}`).first()).toEqual({ n: 0 });
    }
    console.info(`Native capture prepare+execution: ${Math.round(valid.elapsedMs)} ms, ${valid.counts.records} records, ${valid.counts.files} exact source File.`);
  } finally { await native.dispose(); }
}, 30_000);

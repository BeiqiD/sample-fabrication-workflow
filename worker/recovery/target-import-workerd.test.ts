import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { expect, it } from "vitest";
import { RECOVERY_MIGRATIONS } from "./trusted-schema";

/** The production target engine runs against native D1, native R2 source
 * objects and native signed S3 streams backed by an isolated provider bucket.
 * There are no network requests or live deployment/credential bindings. */
it("restores a nonempty native recovery image with cyclic references, signed physical IDs, BLOBs and verified R2-to-S3 copies, then rebacks up and restores another fresh target", async () => {
  const namespace = JSON.stringify({ kind: "local-r2", installationId: "10000000-0000-4000-8000-000000000001", bucketName: "recovery-source-native" });
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", contents: String.raw`
    import {createRecoveryTargetEngine} from './target-import';
    import {captureSystemBackupSnapshot} from './backup-snapshot';
    import {finishSystemBackupManifest,planSystemBackupSources} from '../../shared/contracts/system-backup';
    import {stableJson,sha256Hex} from '../../shared/domain/content-addressing';
    import {acceptAndUploadR2Asset} from '../uploads/r2-upload-acceptance';
    import {setStorageRoleDefaults} from '../storage/storage-role-policy';
    import {saveStorageCandidate} from '../storage/configuration-registry';
    import {startStorageCandidateCheck} from '../storage/candidate-check-service';
    import {registerStorageProfile} from '../storage/storage-profile-admission-service';
    import {activateNativeStorageProfile} from '../storage/native-profile-activation';
    import {openShadowProfile} from '../files/shadow-profile';
    import {hasRecoveryAssetAliasEvidence,qualifiedRecoveryLegacyAssetAliasSql} from '../files/native-asset-alias';
    import {readImportDestinationSnapshot} from '../packages/import-domain-snapshot';
    import {recoverySourceProfileId} from './target-files';
    let providerEnv,calls=[];
    globalThis.fetch=async(input,init)=>{
      const request=input instanceof Request&&!init?input:new Request(input,init);
      if(!request.url.startsWith('https://s3.us-east-1.amazonaws.com/qualification-recovery/'))throw new Error('Unexpected provider request');
      if(!request.headers.get('authorization')?.includes('AWS4-HMAC-SHA256')||request.headers.get('x-amz-expected-bucket-owner')!=='111122223333')throw new Error('Unsigned provider request');
      calls.push({method:request.method,url:request.url});const key=await sha256Hex(request.url);
      if(request.method==='PUT'){await providerEnv.PROVIDER_BYTES.put(key,request.body);return new Response(null);}
      if(request.method==='DELETE'){await providerEnv.PROVIDER_BYTES.delete(key);return new Response(null,{status:204});}
      const object=await providerEnv.PROVIDER_BYTES.get(key);if(!object)return new Response(null,{status:404});
      return new Response(request.method==='HEAD'?null:object.body,{headers:{'content-length':String(object.size),etag:object.httpEtag}});
    };
    const actor='recovery-admin@example.test';
    function diagnosedTarget(db){
      const compiled=new Map();
      const remember=(sql,statement,values=[])=>{compiled.set(statement,{sql,values});const bind=statement.bind.bind(statement);statement.bind=(...next)=>remember(sql,bind(...next),next);return statement;};
      const tracked={prepare:sql=>remember(sql,db.prepare(sql)),withSession(){return tracked;},async batch(statements){
        try{return await db.batch(statements);}catch(error){
          if(/out of memory|SQLITE_NOMEM/.test(String(error)))for(const[index,statement]of statements.entries()){
            const item=compiled.get(statement);if(!item)continue;
            try{await db.prepare('EXPLAIN '+item.sql).bind(...item.values).all();}catch(compile){
              throw new Error('Native target compile statement '+index+' ('+item.sql.slice(0,96)+'; '+new TextEncoder().encode(item.sql).length+' SQL bytes): '+String(compile));
            }
          }throw error;
        }
      }};return tracked;
    }
    async function packageSnapshot(env,db,backupId){
      const compiled=[],tracked={prepare(sql){const statement=db.prepare(sql),item={sql,values:[]};compiled.push(item);const original=statement.bind.bind(statement);statement.bind=(...values)=>{item.values=values;return original(...values);};return statement;},batch:statements=>db.batch(statements),withSession(){return tracked;}};
      let records;try{records=await captureSystemBackupSnapshot(tracked,{backupId,acquireHolds:false});}catch(error){
        if(/too many/.test(String(error)))for(const [index,item]of compiled.entries())try{await db.prepare('EXPLAIN '+item.sql).bind(...item.values).all();}catch(compile){throw new Error('Native system capture statement '+index+': '+item.sql.slice(0,250)+' ... '+item.sql.slice(-250)+'; '+String(compile));}throw error;
      }const files=[];
      for(const source of planSystemBackupSources(records.content)){
        let body;if(source.source.storageProfileId){
          const storage=await openShadowProfile(env,{profileId:source.source.storageProfileId,configurationRevision:1},'read');
          const found=await storage.reader.read(source.source.objectKey);if(found.outcome!=='available')throw new Error('Missing source payload');body=found.body;
        }else{const object=await env.ASSETS.get(source.source.objectKey);if(!object)throw new Error('Missing legacy source');body=object.body;}
        const bytes=new Uint8Array(await new Response(body).arrayBuffer()),sha256=await sha256Hex(bytes.buffer);
        await env.ASSETS.put('qualification-payload/'+backupId+'/'+source.id,bytes);
        files.push({...source,path:'files/'+source.id,outcome:'packaged',byteSize:bytes.length,sha256});
      }
      const manifest=await finishSystemBackupManifest(records,files);
      await env.ASSETS.put('qualification-records/'+backupId,stableJson({records,manifest}));return{records,manifest};
    }
    export default{async fetch(request,bindings){try{
      const input=await request.json(),env={...bindings};providerEnv=env;
      if(input.setup){
        const now=new Date().toISOString();
        await setStorageRoleDefaults(env,{operationId:crypto.randomUUID(),expectedPolicyRevision:null,internalProfileId:'r2-profile',originalsProfileId:'r2-profile'},actor);
        const accepted=await acceptAndUploadR2Asset(env,{requestId:crypto.randomUUID(),actorEmail:actor,ingress:'ordinary_image',originalName:'source.png',mimeType:'image/png',bytes:new TextEncoder().encode('Native source bytes remain untouched across recovery').buffer});
        if(accepted.state.status!=='ready')throw new Error('Source did not publish');const asset=accepted.state.result;
        const file=await env.DB.prepare("SELECT c.result_file_id file_id FROM file_acceptance_candidates c JOIN r2_upload_requests r ON r.id=c.acceptance_id WHERE c.acceptance_kind='r2_upload' AND c.item_id='' AND c.state='ready' AND r.candidate_asset_id=?").bind(asset.id).first();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(CAST(? AS INTEGER),'signed-source','SIGNED','Native signed source',?,?,?)").bind('-9223372036854775807','Retained\u0000text',now,now),
          env.DB.prepare("INSERT INTO events(id,sample_id,kind,asset_key,asset_file_id,metadata_json,created_at) VALUES('native-event','signed-source','image',?,?,?,?)").bind(asset.key,file.file_id,JSON.stringify({assetId:asset.id}),now),
          env.DB.prepare("INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('real-project','Real coordinates','create',?,?,?,?)").bind(actor,actor,now,now),
          env.DB.prepare("INSERT INTO reference_targets(id,target_type,target_id,first_registered_at,last_validated_at) VALUES('real-reference','sample','signed-source',?,?)").bind(now,now),
          env.DB.prepare("INSERT INTO project_items(id,project_id,item_type,reference_target_id,created_sequence,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('real-item','real-project','reference','real-reference',1,'create',?,?,?,?)").bind(actor,actor,now,now),
          env.DB.prepare("INSERT INTO project_map_placements(id,project_item_id,x,y,width,height,z_index,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('real-placement','real-item',1.25,-2.5,200.75,120.125,0,'create',?,?,?,?)").bind(actor,actor,now,now),
        ]);
        const saved=await saveStorageCandidate(env,{expectedRevision:null,label:'Native recovery destination',namespace:{kind:'s3',endpoint:'https://s3.us-east-1.amazonaws.com',region:'us-east-1',bucket:'qualification-recovery',root:'destination',forcePathStyle:true,expectedBucketOwner:'111122223333'},credentials:{mode:'replace',value:{accessKeyId:'qualification-access',secretAccessKey:'qualification-secret'}}},actor);
        const check=await startStorageCandidateCheck(env,{checkId:crypto.randomUUID(),profileId:saved.profileId,expectedRevision:1},actor,{fetch:globalThis.fetch});
        if(check.status!=='succeeded')throw new Error('Isolated provider check failed');
        const admitted=await registerStorageProfile(env,{operationId:crypto.randomUUID(),profileId:saved.profileId,expectedRevision:1,expectedEnvelopeRevision:1,checkId:check.id},actor);
        await activateNativeStorageProfile(env,{operationId:crypto.randomUUID(),nativeProfileId:admitted.nativeProfileId,candidateProfileId:saved.profileId,expectedCandidateRevision:1,expectedEnvelopeRevision:1,checkId:check.id,expectedBindingRevision:null},actor);
        // A separate inactive protected envelope qualifies BLOB storage-class
        // preservation without granting a native binding or decrypting it.
        const opaque=await saveStorageCandidate(env,{expectedRevision:null,label:'Opaque retained history',namespace:{kind:'webdav',endpoint:'https://inactive.invalid/dav',root:'inert'},credentials:{mode:'replace',value:{username:'inert-user',password:'inert-password'}}},actor);
        const guard=await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE name='system_storage_credential_payloads_update_guard'").first();
        await env.DB.batch([env.DB.prepare('DROP TRIGGER system_storage_credential_payloads_update_guard'),env.DB.prepare('UPDATE system_storage_credential_payloads SET nonce=CAST(nonce AS BLOB),ciphertext=CAST(ciphertext AS BLOB) WHERE credential_ref=?').bind(opaque.credentials.ref),env.DB.prepare(guard.sql)]);
        const snapshot=await packageSnapshot(env,env.DB,input.backupId);calls=[];
        return Response.json({profileId:admitted.nativeProfileId,fileId:file.file_id,originalKey:asset.key,physicalSources:snapshot.manifest.files.length,sourceTablesSha256:await sha256Hex(stableJson(snapshot.records.image.tables)),preview:await createRecoveryTargetEngine(env).preview({...input,...snapshot,mapping:[...new Set(snapshot.manifest.files.map(recoverySourceProfileId))].map(sourceProfileId=>({sourceProfileId,destinationProfileId:admitted.nativeProfileId,configurationRevision:1})),mode:'historical'})});
      }
      if(input.rebackup){
        const snapshot=await packageSnapshot(env,env.RECOVERY_DB,input.backupId);
        return Response.json({sources:snapshot.manifest.files.length,relocated:snapshot.records.content.relocatedSources.length,sourceTablesSha256:await sha256Hex(stableJson(snapshot.records.image.tables))});
      }
      if(input.interop){
        const diagnosedRead=async(stage,read)=>{
          try{return await read();}catch(error){throw new Error('Native recovery interop '+stage+': '+String(error));}
        };
        const database=env.RECOVERY_DB;
        const installed=await diagnosedRead('schema probe',()=>hasRecoveryAssetAliasEvidence(database));
        const expectedAlias=await diagnosedRead('original alias metadata',()=>database.prepare("SELECT a.r2_key,a.original_name,a.mime_type,a.file_id,f.purpose FROM assets a JOIN files f ON f.id=a.file_id WHERE a.r2_key=? AND a.status='ready'")
          .bind(input.originalKey).first());
        const aliasQuery=[
          'SELECT a.r2_key,a.original_name,a.mime_type,f.file_id,f.purpose',
          'FROM assets a JOIN file_usable_publications f ON f.file_id=a.file_id',
          "WHERE a.r2_key=? AND a.status='ready' AND f.access_scope='system'",
          "AND(a.import_id IS NULL OR EXISTS(SELECT 1 FROM imports i WHERE i.id=a.import_id AND i.status='ready'))",
          'AND '+qualifiedRecoveryLegacyAssetAliasSql('a','f'),
          'ORDER BY f.file_id LIMIT 1',
        ].join('\n');
        const qualifiedAlias=await diagnosedRead('qualified alias',()=>database.prepare(aliasQuery).bind(input.originalKey).first());
        const absentAlias=await diagnosedRead('absent qualified alias',()=>database.prepare(aliasQuery).bind('qualification/nonexistent-alias').first());
        // No State definitions are requested, but native D1 must still prepare
        // and execute the production State-media query with its recovery branch.
        const destinationSnapshot=await diagnosedRead('State destination snapshot',()=>readImportDestinationSnapshot({primary:()=>database},{records:[]}));
        return Response.json({installed,expectedAlias,qualifiedAlias,absentAlias,destinationSnapshot});
      }
      if(input.sourceProof||input.targetProof){const records=await captureSystemBackupSnapshot(input.targetProof?env.RECOVERY_DB:env.DB,{backupId:crypto.randomUUID(),acquireHolds:false});return Response.json({sourceTablesSha256:await sha256Hex(stableJson(records.image.tables)),calls});}
      const document=JSON.parse(await(await env.ASSETS.get('qualification-records/'+input.backupId)).text());
      const engineEnv=input.second?{...env,RECOVERY_DB:diagnosedTarget(env.SECOND_DB),RECOVERY_TARGET_ID:'second-native-target'}:{...env,RECOVERY_DB:diagnosedTarget(env.RECOVERY_DB)};
      const command={...input,...document,mapping:[...new Set(document.manifest.files.map(recoverySourceProfileId))].map(sourceProfileId=>({sourceProfileId,destinationProfileId:input.destinationProfileId,configurationRevision:1})),mode:'historical',current:async()=>!input.revoked,
        openPayload:async file=>{const object=await env.ASSETS.get('qualification-payload/'+input.backupId+'/'+file.id);if(!object)throw new Error('Payload unavailable');return object.body;}};
      const engine=createRecoveryTargetEngine(engineEnv);
      const result=input.verify?await engine.verify(command):await engine.step(command);
      return Response.json(result);
    }catch(error){return Response.json({error:String(error),stack:error.stack},{status:500});}}};
  ` }, bundle: true, platform: "browser", format: "esm", write: false });
  const persist=await mkdtemp(join(tmpdir(),'fp5-native-target-')),targetUuid=crypto.randomUUID();
  const options = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    d1Databases: {DB:crypto.randomUUID(),RECOVERY_DB:targetUuid,SECOND_DB:crypto.randomUUID()},d1Persist:join(persist,'v3','d1'),
    r2Buckets: { ASSETS: "recovery-source-native", PROVIDER_BYTES: "isolated-recovery-provider" },r2Persist:join(persist,'v3','r2'), log: new Log(LogLevel.ERROR),
    bindings: { R2_BOOTSTRAP_NAMESPACE: namespace, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "recovery-admin@example.test",
      ACCESS_TEAM_DOMAIN: "https://qualification.cloudflareaccess.com", ACCESS_AUD: "qualification", RECOVERY_TARGET_ID: "first-native-target",
      STORAGE_CREDENTIAL_KEYRING: JSON.stringify({ version: 1, currentKeyId: "qualification", keys: { qualification: btoa(String.fromCharCode(...new Uint8Array(32).fill(47))) } }) } };
  let native = new Miniflare(options), ownsNative = true;
  let primaryFailure: { error: unknown } | undefined;
  try {
    const source = await native.getD1Database("DB"), destination = await native.getD1Database("RECOVERY_DB"), second = await native.getD1Database("SECOND_DB");
    const migrations = new URL("../../migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql") && name <= "0022_fp5_recovery_evidence.sql").sort())
      await source.batch(splitSql(readFileSync(new URL(name, migrations), "utf8")).map(sql => source.prepare(sql)));
    const now = new Date().toISOString();
    await source.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'recovery-native-fixture',? FROM file_shadow_control").bind(now).run();
    await source.prepare("INSERT INTO storage_profiles VALUES('r2-profile','r2',?,'bootstrap',NULL,1,'historical',?)").bind(namespace, now).run();
    await source.prepare("INSERT INTO file_shadow_profile_enablements VALUES('r2-profile',1,'recovery-native-fixture',?)").bind(now).run();
    const authority = await source.prepare("SELECT sql FROM sqlite_schema WHERE name='file_authority_control_update_guard'").first<{ sql: string }>();
    await source.batch([source.prepare("DROP TRIGGER file_authority_control_update_guard"),source.prepare("UPDATE file_authority_control SET mode='active',updated_at=?").bind(now),
      source.prepare("UPDATE file_authority_runtime_guard SET incarnation='source-qualification',enabled=1,enabled_by='fixture',updated_at=?").bind(now),source.prepare(authority!.sql)]);
    const invoke = async (input: object) => {
      const response = await native.dispatchFetch("https://recovery.test", { method: "POST", body: JSON.stringify(input) });
      const result = await response.json() as Record<string, any>; expect(response.status, JSON.stringify(result)).toBe(200); return result;
    };
    const firstInput = { backupId: crypto.randomUUID(), jobId: crypto.randomUUID(), incarnation: crypto.randomUUID().replaceAll("-", ""), expectedTargetId: "first-native-target" };
    const setup = await invoke({ ...firstInput, setup: true }); expect(setup.preview).toMatchObject({ available: true, files: setup.physicalSources });
    const drain = async (input: object) => {
      for (let generation = 1; generation <= 180; generation++) {
        const result = await invoke({ ...input, ownerToken: crypto.randomUUID(), generation });
        if (result.done) return { report: result.report, generation };
      }
      throw new Error("Native recovery exceeded the bounded stage count");
    };
    const first = await drain({ ...firstInput, destinationProfileId: setup.profileId }); expect(first.report.verified).toBe(true);
    expect(await destination.prepare("SELECT CAST(rowid AS TEXT) rowid,description FROM samples WHERE id='signed-source'").first())
      .toEqual({ rowid: "-9223372036854775807", description: "Retained\u0000text" });
    expect(await destination.prepare("SELECT x,y,width,height,typeof(x) storage_class FROM project_map_placements WHERE id='real-placement'").first())
      .toEqual({ x: 1.25, y: -2.5, width: 200.75, height: 120.125, storage_class: "real" });
    expect((await destination.prepare("SELECT count(*) n FROM system_storage_credential_payloads WHERE typeof(nonce)='blob' AND typeof(ciphertext)='blob'").first<{ n: number }>())?.n).toBe(1);
    const location = await destination.prepare("SELECT p.file_id,l.object_key,l.storage_profile_id FROM file_publications p JOIN file_location_publications l ON l.location_id=p.active_location_id WHERE p.file_id=?").bind(setup.fileId).first<Record<string, string>>();
    expect(location).toMatchObject({ file_id: setup.fileId, storage_profile_id: setup.profileId }); expect(location!.object_key).toMatch(new RegExp(`^fp5-recovery/${firstInput.incarnation}/`));
    expect(await destination.prepare("SELECT enabled,incarnation FROM file_authority_runtime_guard").first()).toEqual({ enabled: 0, incarnation: null });
    expect(await destination.prepare("SELECT count(*) n FROM system_storage_native_bindings").first()).toEqual({ n: 0 });
    // The initial R2 upload retains a historical alias. Recovery binds it to
    // independently verified bytes without changing its original locator.
    const interop = await invoke({ interop: true, originalKey: setup.originalKey });
    expect(interop.installed).toBe(true);
    expect(interop.expectedAlias).toMatchObject({
      r2_key: setup.originalKey, original_name: "source.png", mime_type: "image/png", file_id: expect.any(String),
    });
    expect(interop.qualifiedAlias).toEqual(interop.expectedAlias);
    expect(interop.absentAlias).toBeNull();
    expect(interop.destinationSnapshot).toEqual({
      columns: {}, names: { sample: [], recipeFamily: [], recipeRevision: [], project: [] }, definitions: [], stateMedia: [],
    });
    const backupId = crypto.randomUUID(), recaptured = await invoke({ rebackup: true, backupId });
    expect(recaptured.sources).toBeGreaterThan(0); expect(recaptured.relocated).toBeGreaterThan(0);
    const secondInput = { backupId, jobId: crypto.randomUUID(), incarnation: crypto.randomUUID().replaceAll("-", ""), expectedTargetId: "second-native-target", second: true, destinationProfileId: "r2-profile" };
    const restoredAgain = await drain(secondInput); expect(restoredAgain.report.verified).toBe(true);
    const secondLocation = await second.prepare("SELECT l.object_key,l.storage_profile_id FROM file_publications p JOIN file_location_publications l ON l.location_id=p.active_location_id WHERE p.file_id=?").bind(setup.fileId).first<Record<string,string>>();
    expect(secondLocation!.object_key).toMatch(new RegExp(`^fp5-recovery/${secondInput.incarnation}/`)); expect(secondLocation!.storage_profile_id).toBe("r2-profile");
    const sourceProof = await invoke({ sourceProof: true }); expect(sourceProof.sourceTablesSha256).toBe(setup.sourceTablesSha256);
    const targetPuts=sourceProof.calls.filter((call:{method:string})=>call.method==='PUT');
    expect(targetPuts).toHaveLength(setup.physicalSources);expect(new Set(targetPuts.map((call:{url:string})=>call.url)).size).toBe(targetPuts.length);
    expect((await source.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await destination.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await second.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const revalidated = await invoke({ ...firstInput, destinationProfileId: setup.profileId, ownerToken: crypto.randomUUID(), generation: first.generation + 1, verify: true });
    expect(revalidated.targetCheckpoint).toBe(first.report.targetCheckpoint);
    const targetProof=await invoke({targetProof:true});
    expect(await destination.prepare('SELECT count(*) n FROM d1_migrations').first()).toEqual({n:22});
    // This test restores the frozen version-1, 22-migration catalog. Asking
    // Wrangler to inspect the repository's newer migrations would qualify an
    // upgrade instead of proving that this recovered baseline needs no replay.
    const ledgerMigrations=join(persist,'reviewed-v1-migrations');
    await mkdir(ledgerMigrations,{mode:0o700});
    expect(RECOVERY_MIGRATIONS).toHaveLength(22);
    for(const migration of RECOVERY_MIGRATIONS){
      const bytes=readFileSync(new URL(migration.name,migrations));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(migration.sha256);
      await writeFile(join(ledgerMigrations,migration.name),bytes,{flag:'wx',mode:0o600});
    }
    const config=join(persist,'wrangler.toml');
    await writeFile(config,`name = "fp5-target-ledger-qualification"\ncompatibility_date = "2026-07-20"\n[[d1_databases]]\nbinding = "RECOVERY_DB"\ndatabase_name = "fp5-target-ledger-qualification"\ndatabase_id = "${targetUuid}"\nmigrations_dir = "${ledgerMigrations}"\n`);
    ownsNative=false;
    await native.dispose();
    const execute=promisify(execFile),cwd=fileURLToPath(new URL('../../',import.meta.url));
    const cli=async(action:string)=>execute(process.execPath,[join(cwd,'node_modules/wrangler/bin/wrangler.js'),'d1','migrations',action,'RECOVERY_DB','--local','--persist-to',persist,'--config',config],
      {cwd,timeout:30_000,env:{...process.env,CI:'1',XDG_CONFIG_HOME:'/workspace/.config',WRANGLER_SEND_METRICS:'false'}});
    const listed=await cli('list');expect(listed.stdout).toMatch(/No migrations (?:to apply|found)|No pending migrations/i);
    const applied=await cli('apply');expect(applied.stdout).toMatch(/No migrations (?:to apply|found)|No pending migrations/i);
    native=new Miniflare(options);
    ownsNative=true;
    expect((await invoke({targetProof:true})).sourceTablesSha256).toBe(targetProof.sourceTablesSha256);
  } catch(error) {
    primaryFailure={error};
    throw error;
  } finally {
    const cleanupErrors: unknown[]=[];
    if(ownsNative){
      ownsNative=false;
      try { await native.dispose(); } catch(error) { cleanupErrors.push(error); }
    }
    try { await rm(persist,{recursive:true,force:true}); } catch(error) { cleanupErrors.push(error); }
    if(cleanupErrors.length) throw new AggregateError(
      primaryFailure ? [primaryFailure.error,...cleanupErrors] : cleanupErrors,
      'Native recovery qualification cleanup failed',
      primaryFailure ? {cause:primaryFailure.error} : undefined,
    );
  }
}, 180_000);

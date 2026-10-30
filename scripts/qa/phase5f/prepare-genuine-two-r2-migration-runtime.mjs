// Source-only authored installation/fixture preparation. The separately sealed
// native browser helper must validate copied inputs/roots/actual CF build and
// retain this returned original owner. No migration execution is invoked here.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareHistoricalR2Profiles } from './prepare-file-migration-historical-r2-profiles.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item instanceof ArrayBuffer
  ?{bytes:Buffer.from(item).toString('hex')}:ArrayBuffer.isView(item)?{bytes:Buffer.from(item.buffer,item.byteOffset,item.byteLength).toString('hex')}:item);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
const sourceProfileId='storage-profile:r2:bootstrap',targetProfileId='storage-profile:r2:qa-migration-target';
async function refused(port){await new Promise((done,fail)=>{
  const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(2000);
  socket.once('connect',()=>{socket.destroy();fail(new Error('Original owned loopback port is still open.'));});
  socket.once('timeout',()=>{socket.destroy();fail(new Error('Original port closure is unknown.'));});
  socket.once('error',error=>{socket.destroy();error.code==='ECONNREFUSED'?done():fail(error);});
});}
async function rows(db,table){assert(/^[a-zA-Z0-9_]+$/.test(table));const result=await db.prepare(`SELECT * FROM "${table}"`).all();
  assert.equal(result.success,true);assert(result.results.length<10000);return result.results;}
async function snapshot(db){
  const value=await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.equal(value.success,true);assert(value.results.length>0&&value.results.length<3000);const tables={};
  for(const item of value.results.filter(item=>item.type==='table'&&!item.name.startsWith('_cf_'))){
    const values=await rows(db,item.name);tables[item.name]={count:values.length,sha256:hash(values.map(canonical).sort().join('\n'))};}
  return {schemaSha256:hash(canonical(value.results)),tables};
}
function freshShadow(value){
  assert.equal(value.mode,'legacy');assert.equal(value.enabled,0);assert(Number.isSafeInteger(value.epoch)&&value.epoch>=0);
  for(const name of ['current_count','resolved_count','unresolved_count','pending_count','unfinished_attempts'])assert.equal(value[name],0);
}
function freshAuthority(value,expectedMode){
  assert(['legacy','overlap'].includes(expectedMode));assert.equal(value.mode,expectedMode);assert.equal(value.enabled,0);assert.equal(value.shadow_enabled,0);
  assert(Number.isSafeInteger(value.epoch)&&value.epoch>=0);
  for(const name of ['current_count','resolved_count','unfinished_attempts','pending_receipts','unfinished_failed_imports',
    'unattached_ready_uploads','unpublished_candidates','legacy_deleting','file_deleting'])assert.equal(value[name],0);
}

export async function prepareGenuineTwoR2MigrationRuntime({source,artifact,config}){
  assert(process.stdin.isTTY,'The original retained interactive control channel is required before any owner is created.');
  assert.equal(config.vars.AUTH_MODE,'disabled');assert.equal(config.d1_databases.length,1);
  assert.equal(config.d1_databases[0].binding,'DB');assert.equal(config.d1_databases[0].database_id,'00000000-0000-4000-8000-000000000000');
  assert.equal(config.r2_buckets.length,1);assert.equal(config.r2_buckets[0].binding,'ASSETS');
  for(const item of [...config.d1_databases,...config.r2_buckets])for(const key of ['remote','preview_database_id','preview_bucket_name','jurisdiction'])assert.equal(item[key],undefined);
  const require=createRequire(resolve(source,'package.json'));
  const {Miniflare,Log,LogLevel}=require('miniflare');
  const {generateKeyPair,exportJWK,SignJWT}=await import(pathToFileURL(require.resolve('jose')));
  const {build,stop}=require('esbuild');let canonicalNamespace,validateUpload;
  const moduleSources=[];
  try{
    for(const [name,exportName] of [['worker/files/r2-profile-bindings.ts','canonicalR2ProfileNamespace'],['shared/contracts/r2-upload.ts','validateFileUploadResult']]){
      const contents=await readFile(resolve(source,name),'utf8');
      const compiled=await build({stdin:{contents,loader:'ts',sourcefile:name,resolveDir:resolve(source,name.slice(0,name.lastIndexOf('/')))},
        bundle:true,write:false,platform:'node',format:'esm',target:'es2022',logLevel:'silent'});
      assert.equal(compiled.outputFiles.length,1);assert.equal(compiled.warnings.length,0);
      const executable=compiled.outputFiles[0].text;assert(!/\bimport\s*(?:\(|[^;]*\bfrom\b)/.test(executable));
      const value=(await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`))[exportName];
      assert.equal(typeof value,'function');if(exportName==='canonicalR2ProfileNamespace')canonicalNamespace=value;else validateUpload=value;
      moduleSources.push({path:name,sourceSha256:hash(contents),executableSha256:hash(executable)});
    }
  }finally{await stop();} // Public esbuild stop request is not native-child exit proof.
  const base=new URL('http://127.0.0.1:4219/'),installationId=randomUUID(),suffix=randomUUID().replaceAll('-','');
  const sourceBucketName=`qa-source-${suffix}`,targetBucketName=`qa-target-${suffix}`;
  assert.notEqual(sourceBucketName,targetBucketName);assert.notEqual(sourceBucketName,config.r2_buckets[0].bucket_name);
  assert.notEqual(installationId,JSON.parse(config.vars.R2_BOOTSTRAP_NAMESPACE).installationId);
  const namespaces={source:canonicalNamespace(JSON.stringify({kind:'local-r2',installationId,bucketName:sourceBucketName})),
    target:canonicalNamespace(JSON.stringify({kind:'local-r2',installationId,bucketName:targetBucketName}))};
  const actor='migration-administrator@two-r2-fixture.invalid',reader='migration-reader@two-r2-fixture.invalid',audience=`migration-${randomUUID()}`;
  const report={status:'preparing',sessionId:randomUUID(),sessionPid:process.pid,startedAt:new Date().toISOString(),
    preparationPhase:'original-owner-setup',
    scope:'Isolated local current24 D1 and two genuine distinct local R2 buckets. Original Access JOSE verification plus separate system-admin and File evidence-operator deployment allowlists. No provider acceptance, job/executor/transfer/GC/ZIP or recovery target.',
    source,derivedRuntimeNamespace:{installationId,sourceBucketName,targetBucketName,namespaces,originalCopiedConfigChanged:false},
    originalContractModuleCompilation:moduleSources,requests:[],jwksRequests:[],actorSha256:hash(actor),ownedClosure:null};
  let runtime,database,jwksServer,issuerPort,readerToken,adminToken,closePromise;const requestWork=[],outboundWork=[];
  const safeError=error=>({kind:error instanceof Error?error.name:'other-private-error',phase:report.preparationPhase,
    code:['ERR_ASSERTION','SQLITE_ERROR','SQLITE_CONSTRAINT','D1_ERROR'].includes(error?.code)?error.code:undefined,
    fixedMessage:['All original tables/indexes/triggers/views stay installed byte-exact.','Fresh isolated profile preparation boundary changed',
      'Original historical profile admission did not complete','Original owned loopback port is still open.','Original port closure is unknown.'].includes(error?.message)?error.message:undefined});
  async function close(){return closePromise??=(async()=>{
    const closure={status:'closing',startedAt:new Date().toISOString()};
    const requests=await Promise.allSettled(requestWork);closure.originalRequestsAwaited={count:requests.length,rejected:requests.filter(x=>x.status==='rejected').length};
    if(database){try{report.databaseAtClosure=await snapshot(database);}catch(error){closure.snapshotError=safeError(error);}}
    if(runtime){try{await runtime.dispose();closure.workerDisposeAwaited=true;await refused(4219);closure.workerPortRefused=true;}catch(error){closure.workerCloseError=safeError(error);}}
    const outbound=await Promise.allSettled(outboundWork);closure.originalOutboundWorkAwaited={count:outbound.length,rejected:outbound.filter(x=>x.status==='rejected').length};
    if(jwksServer){try{await new Promise((done,fail)=>jwksServer.close(error=>error?fail(error):done()));closure.jwksCloseAwaited=true;
      if(issuerPort){await refused(issuerPort);closure.jwksPortRefused=true;}}catch(error){closure.jwksCloseError=safeError(error);}}
    closure.status=Object.keys(closure).some(name=>name.endsWith('Error'))?'failed':'closed';closure.completedAt=new Date().toISOString();report.ownedClosure=closure;return closure;
  })();}
  function originalRequest(path,expected,{method='GET',body,headers={},binary=false}={}){
    const entry={ordinal:report.requests.length+1,path,method,expectedStatus:expected,startedAt:new Date().toISOString(),outcome:'registered'};
    report.requests.push(entry);
    const original=(async()=>{
      const oldPermits=method==='POST'?await rows(database,'system_recovery_write_leases'):null;
      entry.outcome='issued';const response=await fetch(new URL(path,base),{method,headers:{...headers,'cf-access-jwt-assertion':adminToken},
        body,redirect:'error',signal:AbortSignal.timeout(20000)});
      const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<131072);entry.status=response.status;
      entry.body='completed';entry.responseSha256=hash(bytes);entry.completedAt=new Date().toISOString();assert.equal(response.status,expected);
      if(oldPermits){
        const permits=await rows(database,'system_recovery_write_leases'),known=new Set(oldPermits.map(item=>item.id));
        const added=permits.filter(item=>!known.has(item.id));assert.equal(added.length,1);const permit=added[0];
        assert.equal(hash(permits.filter(item=>known.has(item.id)).map(canonical).sort().join('\n')),hash(oldPermits.map(canonical).sort().join('\n')));
        assert.equal(permit.owner,actor);assert.equal(permit.kind,'http');assert.equal(permit.generation,report.maintenanceGeneration);assert(permit.released_at);
        assert.equal(Date.parse(permit.expires_at)-Date.parse(permit.created_at),300000);
        assert(Date.parse(permit.created_at)>=Date.parse(entry.startedAt)&&Date.parse(permit.created_at)<=Date.parse(entry.completedAt));
        assert(Date.parse(permit.released_at)>=Date.parse(permit.created_at)&&Date.parse(permit.released_at)<=Date.parse(entry.completedAt));
        entry.originalSingleReleasedWritePermit={id:permit.id,sha256:hash(canonical(permit)),ownerMatches:true,kind:'http',
          generation:permit.generation,expiryMs:300000,observedRequestWindowMatched:true,allEarlierRowsExact:true};
      }
      entry.outcome='response_accepted';return binary?bytes:JSON.parse(bytes.toString('utf8'));
    })();requestWork.push(original);original.catch(()=>{});return original;
  }
  const post=(path,input)=>originalRequest(path,200,{method:'POST',body:JSON.stringify(input),headers:{'content-type':'application/json'}});
  try{
    report.preparationPhase='original-loopback-and-jwks-setup';
    await refused(4219);const keys=await generateKeyPair('RS256');
    const publicKey={...await exportJWK(keys.publicKey),kid:'two-local-r2-fixture',alg:'RS256',use:'sig'};
    const publicBytes=Buffer.from(JSON.stringify({keys:[publicKey]}));
    jwksServer=createServer((request,response)=>{report.jwksRequests.push({method:request.method,path:request.url,at:new Date().toISOString()});
      if(request.method!=='GET'||request.url!=='/cdn-cgi/access/certs'){response.writeHead(404).end();return;}
      response.writeHead(200,{'content-type':'application/json','cache-control':'no-store','content-length':publicBytes.length});response.end(publicBytes);});
    await new Promise((done,fail)=>{jwksServer.once('error',fail);jwksServer.listen(0,'127.0.0.1',done);});issuerPort=jwksServer.address().port;
    report.jwksOwner={host:'127.0.0.1',port:issuerPort,listeningAwaited:true};
    const issuer=`http://127.0.0.1:${issuerPort}`;
    const token=email=>new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'two-local-r2-fixture'}).setIssuer(issuer).setAudience(audience)
      .setSubject(`fixture:${email}`).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    readerToken=await token(reader);adminToken=await token(actor);
    const vars={...config.vars,AUTH_MODE:'access',ACCESS_TEAM_DOMAIN:issuer,ACCESS_AUD:audience,ALLOWED_EMAILS:`${actor},${reader}`,
      SYSTEM_ADMIN_EMAILS:actor,FILE_EVIDENCE_OPERATOR_EMAILS:actor,R2_BOOTSTRAP_NAMESPACE:namespaces.source,
      R2_PROFILE_BINDINGS:JSON.stringify({[sourceProfileId]:{namespaceIdentity:namespaces.source,bindingName:'ASSETS'},
        [targetProfileId]:{namespaceIdentity:namespaces.target,bindingName:'MIGRATION_TARGET'}})};
    for(const key of ['RECOVERY_TARGET_ID','STORAGE_CREDENTIALS_KEYRING'])assert.equal(vars[key],undefined);
    report.preparationPhase='original-Miniflare-ready-and-D1';
    runtime=new Miniflare({...artifact,rootPath:source,modulesRoot:source,modules:true,host:'127.0.0.1',port:4219,bindings:vars,
      d1Databases:{DB:config.d1_databases[0].database_id},d1Persist:resolve(source,'.wrangler/state/v3/d1'),
      r2Buckets:{ASSETS:sourceBucketName,MIGRATION_TARGET:targetBucketName},r2Persist:resolve(source,'.wrangler/state/v3/r2'),log:new Log(LogLevel.ERROR),
      outboundService:request=>{const work=(async()=>{assert.equal(request.url,`${issuer}/cdn-cgi/access/certs`);assert.equal(request.method,'GET');
        const response=await fetch(request.url,{redirect:'error',signal:AbortSignal.timeout(5000)});return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});})();
        outboundWork.push(work);work.catch(()=>{});return work;}});
    // The original Miniflare handle is held before ready/getD1 can fail.
    assert.equal(new URL((await runtime.ready).href).origin,base.origin);database=await runtime.getD1Database('DB');
    report.preparationPhase='original-current24-schema-admission';
    const migrations=(await readdir(resolve(source,'migrations'))).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
    assert.equal(migrations.length,24);assert.equal(migrations.at(-1).slice(0,4),'0024');
    assert.deepEqual((await rows(database,'d1_migrations')).map(row=>row.name).sort(),migrations);
    report.preparationPhase='original-empty-file-graph-admission';
    report.beforePreparation=await snapshot(database);
    // Pure template metadata may retain dependency-version observations, while
    // the actual typed File graph and original jobs must still be empty.
    for(const name of ['files','file_locations','file_location_publications','file_publications','file_holds','file_location_holds',
      'file_acceptance_candidates','file_shadow_occurrences','file_shadow_heads','file_shadow_operations','file_shadow_attempts',
      'file_shadow_decisions','file_shadow_checkpoints','file_migration_jobs','file_migration_items','file_migration_attempts',
      'assets','imports','r2_upload_requests','storage_profiles','storage_profile_runtime','storage_role_defaults','system_recovery_write_leases'])
      assert.equal(report.beforePreparation.tables[name].count,0,`Fresh original File preparation requires empty ${name}`);
    const jobRuntime=await rows(database,'file_job_runtime_guard');assert.equal(jobRuntime.length,1);assert.equal(jobRuntime[0].enabled,0);
    const maintenance=await rows(database,'system_recovery_maintenance');assert.equal(maintenance.length,1);assert.equal(maintenance[0].state,'open');
    report.maintenanceGeneration=maintenance[0].generation;
    await prepareHistoricalR2Profiles(database,namespaces,new Date().toISOString(),phase=>{report.preparationPhase=phase;});
    report.preparationPhase='original-admin-operator-capabilities-and-fresh-legacy-status';
    const adminCapability=await originalRequest('/api/storage/configuration/capability',200);assert.equal(adminCapability.canManage,true);
    const operatorCapability=await originalRequest('/api/files/shadow/evidence/capabilities',200);assert.equal(operatorCapability.canAdjudicate,true);
    let shadow=await originalRequest('/api/files/shadow/status',200);freshShadow(shadow);
    let authority=await originalRequest('/api/files/authority/status',200);freshAuthority(authority,'legacy');
    report.preparationPhase='original-explicit-shadow-enable';
    const incarnation=randomUUID();shadow=await post('/api/files/shadow/enable',{requestId:incarnation,expectedEpoch:shadow.epoch,expectedIncarnation:shadow.incarnation});
    assert.equal(shadow.enabled,1);assert.equal(shadow.incarnation,incarnation);
    report.preparationPhase='original-explicit-profile-enablements';
    for(const profileId of [sourceProfileId,targetProfileId]){
      shadow=await post('/api/files/shadow/profiles/enable',{profile:{profileId,configurationRevision:1},runtimeIncarnation:incarnation,expectedEpoch:shadow.epoch});
      assert.equal(shadow.enabled,1);assert.equal(shadow.incarnation,incarnation);
    }
    report.preparationPhase='original-writable-profile-verification';
    const profileRows=await rows(database,'storage_profile_runtime');assert.equal(profileRows.length,2);
    for(const row of profileRows){assert.equal(row.state,'read_write');assert(row.activated_at);assert.equal(row.retired_at,null);}
    report.preparationPhase='original-shadow-disable-and-overlap-status';
    shadow=await post('/api/files/shadow/disable',{runtimeIncarnation:incarnation,expectedEpoch:shadow.epoch});assert.equal(shadow.enabled,0);
    authority=await originalRequest('/api/files/authority/status',200);freshAuthority(authority,'overlap');assert.equal(authority.shadow_incarnation,incarnation);
    report.preparationPhase='original-explicit-authority-activation';
    const authorityIncarnation=randomUUID();authority=await post('/api/files/authority/activate',{requestId:authorityIncarnation,expectedEpoch:authority.epoch,expectedShadowIncarnation:incarnation});
    assert.equal(authority.mode,'active');assert.equal(authority.enabled,1);assert.equal(authority.incarnation,authorityIncarnation);
    report.preparationPhase='original-native-project-png-upload';
    const uploadRequestId=randomUUID();
    const upload=validateUpload(await originalRequest('/api/project-assets',201,{method:'POST',body:png,
      headers:{'content-type':'image/png','x-project-filename-uri':encodeURIComponent('isolated-migration-source.png'),'x-upload-request-id':uploadRequestId}}));
    // Active R2 keeps its original id/key result; native S3 aliases alone expose file-assets URLs.
    assert.deepEqual(Object.keys(upload).sort(),['deduplicated','id','key']);assert.equal(typeof upload.key,'string');assert.equal(upload.deduplicated,false);
    report.preparationPhase='original-native-publication-and-r2-bytes-verification';
    const download=await originalRequest(`/api/assets/${upload.key}`,200,{binary:true});assert.deepEqual(download,png);
    const published=await database.prepare(`SELECT f.file_id,f.active_location_id,f.purpose,f.access_scope,l.storage_profile_id,l.object_key,
      f.verified_byte_size,f.verified_sha256 FROM r2_upload_requests r
      JOIN file_acceptance_candidates c ON c.acceptance_kind='r2_upload' AND c.acceptance_id=r.id AND c.state='ready'
      JOIN file_usable_publications f ON f.file_id=c.result_file_id
      JOIN file_locations l ON l.id=f.active_location_id
      JOIN assets a ON a.id=json_extract(r.accepted_result_json,'$.id') AND a.r2_key=json_extract(r.accepted_result_json,'$.key')
      WHERE r.actor_email=? AND r.client_request_id=? AND r.status='ready' AND r.purpose='research_source'
        AND r.storage_profile_id=? AND r.storage_profile_revision=1 AND a.id=? AND a.r2_key=? AND a.status='ready'
        AND a.byte_size=f.verified_byte_size AND a.sha256=f.verified_sha256`).bind(actor,uploadRequestId,sourceProfileId,upload.id,upload.key).all();
    assert.equal(published.success,true);assert.equal(published.results.length,1);const publication=published.results[0];
    assert.equal(publication.purpose,'research_source');assert.equal(publication.access_scope,'system');assert.equal(publication.object_key,upload.key);
    assert.equal(publication.storage_profile_id,sourceProfileId);assert.equal(publication.verified_byte_size,png.length);assert.equal(publication.verified_sha256,hash(png));
    const sourceBucket=await runtime.getR2Bucket('ASSETS'),targetBucket=await runtime.getR2Bucket('MIGRATION_TARGET');assert.notEqual(sourceBucket,targetBucket);
    const object=await sourceBucket.get(publication.object_key);assert(object);assert.deepEqual(Buffer.from(await object.arrayBuffer()),png);
    const sourceObjects=await sourceBucket.list(),targetObjects=await targetBucket.list();assert.equal(sourceObjects.truncated,false);assert.equal(targetObjects.truncated,false);
    assert.equal(sourceObjects.objects.length,1);assert.equal(sourceObjects.objects[0].key,publication.object_key);assert.equal(targetObjects.objects.length,0);
    report.preparationPhase='original-six-write-permits-and-browser-baseline';
    const leases=await rows(database,'system_recovery_write_leases');assert.equal(leases.length,6);
    const posts=report.requests.filter(item=>item.method==='POST');assert.equal(posts.length,6);assert(posts.every(item=>item.outcome==='response_accepted'));
    for(const lease of leases){assert.equal(lease.kind,'http');assert.equal(lease.owner,actor);assert.equal(lease.generation,maintenance[0].generation);assert(lease.released_at);
      assert.equal(Date.parse(lease.expires_at)-Date.parse(lease.created_at),300000);}
    report.setupWritePermitEvidence={count:6,actorSha256:hash(actor),kind:'http',generation:maintenance[0].generation,
      allReleased:true,expiryMs:300000,rowsSha256:hash(leases.map(canonical).sort().join('\n'))};
    report.sourceFile={assetId:upload.id,fileId:publication.file_id,locationId:publication.active_location_id,sourceProfileId,targetProfileId,
      objectKey:publication.object_key,byteSize:png.length,sha256:hash(png),sourceBucketRealBytesMatched:true,targetBucketEmpty:true};
    report.browserBaseline=await snapshot(database);assert.equal(report.beforePreparation.schemaSha256,report.browserBaseline.schemaSha256);
    report.status='prepared';report.completedAt=new Date().toISOString();
    // Tokens and capabilities stay private in this original process; callers
    // must never serialize them. Only the safe report is eligible for artifacts.
    return {runtime,database,sourceBucket,targetBucket,adminToken,readerToken,report,close,
      originalBaselinePermits:leases,snapshot:()=>snapshot(database)};
  }catch(error){report.status='failed';report.error=safeError(error);await close();throw Object.assign(new Error('Original two-R2 fixture preparation failed; original owner closure retained.'),{fixtureReport:report});}
}

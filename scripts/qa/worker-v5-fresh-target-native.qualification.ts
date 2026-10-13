import { afterAll, afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build, stop } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { PORTABLE_RUNTIME_RECOVERY_MIGRATIONS } from "../../shared/contracts/portable-runtime-v26-recovery-catalog";

const ORIGINAL_PRODUCER_HEAD = "9c7c916d9647ffac8efc163c2b7213b40617cb41";
const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const titles = [
  "constructs an exact fresh inert native D1 V28 target from the original complete zero-File Node V5 archive",
  "constructs an exact fresh inert native D1 V28 target and explicit R2 plan from the original genuine nonempty LOCAL Node V5 archive",
] as const;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("worker_v5_native_" + reason);
}
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "object"); return value as Record<string, unknown>;
}

// The full source documents stay private in the isolate. Only fixed proof facts
// leave it. DB and RECOVERY_DB are the actual Miniflare native D1 bindings.
const workerCode = String.raw`
  import {Hono} from 'hono';
  import {createWorkerV5FreshTargetCandidate} from './v5-fresh-target-candidate';
  import {admitV5SystemBackupArchiveCandidate} from '../../shared/contracts/system-backup-v5-archive-admission-candidate';
  import {sourceFromBlob} from '../../shared/domain/research-archive';
  import {stableJson,sha256Hex} from '../../shared/domain/content-addressing';
  import {recoveryTableSnapshotSql} from '../../shared/contracts/system-recovery-image';
  import {PORTABLE_RUNTIME_RECOVERY_TABLES as sourceSpecs} from '../../shared/contracts/portable-runtime-v26-recovery-catalog';
  import {V5_RECOVERY_CATALOG_CANDIDATE as catalog} from './v5-catalog-candidate';
  import {inspectV28CloudflareSchemaCandidate} from './v28-cloudflare-schema-candidate';
  import {inspectRecoveryMigrationLedger} from './target-migrations';
  import {ensureR2BootstrapProfile} from '../files/r2-bootstrap-profile';
  import {shadowRoutes} from '../files/shadow-routes';
  const actor='isolated-v5-constructor-owner@example.invalid';
  const controls=new Hono();
  controls.use('*',async(c,next)=>{c.set('userEmail',actor);await next();});
  controls.route('/',shadowRoutes);
  let profile;
  function require(value,reason){if(!value)throw new Error('worker_v5_native_'+reason);}
  async function table(db,spec){
    const rows=await db.prepare(recoveryTableSnapshotSql(spec)).all();
    require(rows.success,'typed_read');
    return {columns:[...spec.columns],rows:rows.results.map(row=>({rowid:row.rowid,cells:JSON.parse(row.cells)}))};
  }
  const sortedRows=value=>value.rows.map(stableJson).sort();
  async function sourceHash(db){
    const values={};
    for(let offset=0;offset<sourceSpecs.length;offset+=64){
      const group=sourceSpecs.slice(offset,offset+64);
      const results=await db.batch(group.map(spec=>db.prepare(recoveryTableSnapshotSql(spec))));
      for(let index=0;index<group.length;index++){
        require(results[index].success,'source_read');
        values[group[index].name]=results[index].results.map(row=>({rowid:row.rowid,cells:JSON.parse(row.cells)})).map(stableJson).sort();
      }
    }
    return sha256Hex(stableJson(values));
  }
  async function command(env,path,value){
    const response=await controls.fetch(new Request('https://constructor-control.invalid'+path,
      {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}),env);
    require(response.status===200,'original_profile_command');
    return response.json();
  }
  async function independentProof(target,records,admission){
    const objects=await target.prepare('SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name').all();
    require(objects.success,'target_schema_read');
    const inspected=await inspectV28CloudflareSchemaCandidate(objects.results);
    const tableNames=inspected.applicationObjects.filter(object=>object.type==='table').map(object=>object.name).sort();
    require(stableJson(tableNames)===stableJson(catalog.tables.map(spec=>spec.name).sort()),'native_table_catalog_coverage');
    await inspectRecoveryMigrationLedger(target,true,catalog.migrations);
    let exactNonlocal=true,accountRows=0,disabledAccounts=0,typedRows=0,nulCells=0,blobCells=0,wideIntegerCells=0;
    for(const spec of catalog.tables.filter(spec=>!spec.local)){
      const original=records.image.tables[spec.name],actual=await table(target,spec);
      const expected={columns:[...original.columns],rows:original.rows.map(row=>({rowid:row.rowid,cells:row.cells.map(cell=>({...cell}))}))};
      if(spec.name==='local_accounts'){
        const enabled=expected.columns.indexOf('enabled');require(enabled>=0,'account_columns');
        accountRows=expected.rows.length;
        for(const row of expected.rows)row.cells[enabled]={type:'integer',value:'0'};
        disabledAccounts=actual.rows.filter(row=>row.cells[enabled].type==='integer'&&row.cells[enabled].value==='0').length;
      }
      exactNonlocal&&=stableJson(expected.columns)===stableJson(actual.columns)&&stableJson(sortedRows(expected))===stableJson(sortedRows(actual));
      typedRows+=original.rows.length;
      for(const row of original.rows)for(const cell of row.cells){
        if(cell.type==='text'&&cell.value.includes('\u0000'))nulCells++;
        if(cell.type==='blob')blobCells++;
        if(cell.type==='integer'&&(BigInt(cell.value)>9007199254740991n||BigInt(cell.value)<-9007199254740991n))wideIntegerCells++;
      }
    }
    const singletons=new Set(['file_authority_runtime_guard','file_shadow_runtime_guard','file_job_runtime_guard',
      'system_recovery_runtime','system_recovery_maintenance','collaboration_control']);
    let emptyLocal=true,singletonsExact=true;
    for(const spec of catalog.tables.filter(spec=>spec.local)){
      const actual=await table(target,spec);
      if(!singletons.has(spec.name)){emptyLocal&&=actual.rows.length===0;continue;}
      singletonsExact&&=actual.rows.length===1;
      if(actual.rows.length!==1)continue;
      const get=name=>actual.rows[0].cells[actual.columns.indexOf(name)];
      const equals=(name,cell)=>stableJson(get(name))===stableJson(cell);
      singletonsExact&&=equals('singleton',{type:'integer',value:'1'});
      if(spec.name==='collaboration_control')singletonsExact&&=equals('schema_version',{type:'integer',value:'2'})
        &&equals('enforcement',{type:'text',value:'disabled'})&&equals('revision',{type:'integer',value:'1'});
      else if(spec.name==='system_recovery_maintenance')singletonsExact&&=equals('state',{type:'text',value:'fenced'})
        &&equals('generation',{type:'integer',value:'0'})&&['token','requested_by','backup_job_id','checkpoint_sha256','started_at','fenced_at'].every(name=>equals(name,{type:'null'}));
      else{
        singletonsExact&&=equals('enabled',{type:'integer',value:'0'});
        if(spec.name==='system_recovery_runtime')singletonsExact&&=equals('installation_id',{type:'text',value:admission.destinationInstallationId})
          &&equals('incarnation',{type:'text',value:admission.destinationIncarnation})&&equals('last_heartbeat_at',{type:'null'});
        else singletonsExact&&=equals('incarnation',{type:'null'})
          &&equals(spec.name==='file_job_runtime_guard'?'last_heartbeat_at':'enabled_by',{type:'null'});
      }
    }
    const fk=await target.prepare('PRAGMA foreign_key_check').all();
    const checkedTables=['sqlite_schema',...objects.results.filter(object=>object.type==='table'
      &&object.name!=='_cf_KV'&&object.name!=='_cf_METADATA').map(object=>object.name)].sort();
    require(new Set(checkedTables).size===checkedTables.length,'native_table_inventory');
    let tableIntegrity=true;
    for(const name of checkedTables){
      const quoted='"'+name.replaceAll('"','""')+'"';
      const quick=await target.prepare('PRAGMA quick_check('+quoted+')').all();
      tableIntegrity&&=quick.success&&quick.results.length===1&&Object.values(quick.results[0])[0]==='ok';
    }
    return {exactNonlocal,accountRows,disabledAccounts,typedRows,nulCells,blobCells,wideIntegerCells,emptyLocal,singletonsExact,
      foreignKeys:fk.success&&fk.results.length===0,tableIntegrity,checkedTables,globalNativeIntegrity:false};
  }
  export default{async fetch(request,bindings){
    let phase='setup';
    try{
      if(new URL(request.url).pathname==='/setup'){
        profile=await ensureR2BootstrapProfile(bindings.DB,bindings,new Date().toISOString());
        let status=await bindings.DB.prepare('SELECT epoch FROM file_shadow_control WHERE singleton=1').first();
        const runtime=await bindings.DB.prepare('SELECT incarnation FROM file_shadow_runtime_guard WHERE singleton=1').first();
        const enabled=await command(bindings,'/files/shadow/enable',{requestId:crypto.randomUUID(),expectedEpoch:status.epoch,expectedIncarnation:runtime.incarnation});
        status=await bindings.DB.prepare('SELECT epoch FROM file_shadow_control WHERE singleton=1').first();
        await command(bindings,'/files/shadow/profiles/enable',{profile:{profileId:profile.id,configurationRevision:1},
          runtimeIncarnation:enabled.incarnation,expectedEpoch:status.epoch});
        return Response.json({setup:true});
      }
      require(profile,'setup_required');
      const count=Number(request.headers.get('x-original-file-count'));
      require(count===0||count===1,'selection');
      phase='archive';
      const archive=await admitV5SystemBackupArchiveCandidate(sourceFromBlob(await request.blob()),
        {expectedSha256:request.headers.get('x-original-archive-sha256')});
      require(archive.format==='v5'&&archive.manifest.completeness==='complete'&&archive.manifest.files.length===count,'original_archive_inventory');
      require(archive.records.sourceMigrationLedger.kind==='node-reviewed-migrations/1'
        &&archive.records.origin.capturePolicy==='quiesced-writers-and-bytes/1','original_node_source');
      require(count===0||archive.manifest.files[0].source.provider==='local','original_local_payload');
      const sourceBefore=await sourceHash(bindings.DB),calls={put:0,delete:0};
      // Observe actual native R2 calls; every method forwards to that binding.
      // D1 is passed directly, without a host or isolate SQL adapter.
      const nativeBucket=bindings.ASSETS,observedBucket=new Proxy(nativeBucket,{get(target,key){
        const value=Reflect.get(target,key);
        if(typeof value!=='function')return value;
        return(...args)=>{if(key==='put'||key==='delete')calls[key]++;return value.apply(target,args);};
      }});
      const env={...bindings,ASSETS:observedBucket};
      const mappings=[...new Set(archive.manifest.files.map(file=>file.source.storageProfileId))].map(sourceProfileId=>{
        require(typeof sourceProfileId==='string'&&sourceProfileId.length>0,'original_source_profile');
        return {sourceProfileId,destinationProfileId:profile.id,configurationRevision:1};
      });
      phase='admission';
      const owner=createWorkerV5FreshTargetCandidate(env);
      let missingMappingRejected=count===0;
      if(count===1){
        try{await owner.admit({manifest:archive.manifest,records:archive.records,expectedTargetId:bindings.RECOVERY_TARGET_ID,mapping:[]});}
        catch{missingMappingRejected=true;}
        require(missingMappingRejected,'missing_mapping_admitted');
      }
      const admission=await owner.admit({manifest:archive.manifest,records:archive.records,
        expectedTargetId:bindings.RECOVERY_TARGET_ID,mapping:mappings});
      require(admission.payloadPublication===false&&admission.executionEnabled===false,'admission_flags');
      const mappingExact=admission.mappings.every(mapping=>{
        const original=archive.manifest.files.find(file=>file.id===mapping.sourceId);
        return original&&stableJson(original.source)===stableJson(mapping.source)
          &&original.source.storageProfileId===mapping.sourceProfileId&&mapping.destinationProfileId===profile.id
          &&mapping.configurationRevision===1&&mapping.destinationNamespaceIdentity===profile.namespaceIdentity
          &&mapping.destinationBindingName==='ASSETS'&&mapping.bytesPublished===false
          &&mapping.objectKey.startsWith('fp5-recovery/'+admission.destinationIncarnation+'/');
      });
      phase='construction';
      const original=owner.construct(admission,async()=>true);
      require(owner.construct(admission,async()=>false)===original,'first_promise_identity');
      const receipt=await original;
      phase='independent_proof';
      const proof=await independentProof(bindings.RECOVERY_DB,archive.records,admission);
      const sourceAfter=await sourceHash(bindings.DB);
      const targetIdentity=await bindings.RECOVERY_DB.prepare('SELECT installation_id FROM system_recovery_runtime WHERE singleton=1').first();
      const sourceIdentity=await bindings.DB.prepare('SELECT installation_id FROM system_recovery_runtime WHERE singleton=1').first();
      return Response.json({format:archive.format,sourceFileCount:count,archiveSha256:archive.sha256,receipt,proof,
        mappingCount:admission.mappings.length,mappingExact,missingMappingRejected,calls,sourceUnchanged:sourceBefore===sourceAfter,
        sourceInstallationId:sourceIdentity.installation_id,targetInstallationId:targetIdentity.installation_id,
        freshIdentity:targetIdentity.installation_id!==sourceIdentity.installation_id
          &&targetIdentity.installation_id!==archive.records.sourceMigrationLedger.installationId.replaceAll('-','')});
    }catch(error){
      const message=error instanceof Error?error.message:'other';
      const reason=/^(?:v5_fresh_target_|v5_recovery_catalog_candidate_|worker_v5_native_)[a-z0-9_:.-]+$/i.test(message)?message:'original_native_error';
      // Retain the original native error only in the private response artifact;
      // the host assertion prints fixed phase/reason facts, never source rows.
      return Response.json({error:'worker-v5-native-qualification-failed',phase,reason,
        originalError:error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:null},{status:500});
    }
  }};
`;

interface Owner { native?: Miniflare; work: Promise<unknown>[]; closing?: Promise<void> }
const owners = new Set<Owner>();
function original<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
  let result: Promise<T>; try { result = operation(); } catch (error) { result = Promise.reject(error); }
  owner.work.push(result); void result.catch(() => undefined); return result;
}
function close(owner: Owner): Promise<void> {
  return owner.closing ??= (async () => {
    const failures: unknown[] = [];
    // Rejected operation identities belong to the caller; join them before
    // native disposal without replacing its already preserved first failure.
    await Promise.allSettled(owner.work);
    if (owner.native) try { await owner.native.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Original native V5 close failed");
    owners.delete(owner);
  })();
}
afterEach(() => { expect(owners.size, "Original native V5 owner remains retained").toBe(0); });
afterAll(async () => {
  const results = await Promise.allSettled([...owners].map(close));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
  if (errors.length) throw new AggregateError(errors, "Original native V5 teardown remains unproven");
});

async function retainedInput(kind: "ZERO" | "NONEMPTY") {
  const prefix = "WORKER_V5_" + kind;
  const archive = process.env[prefix + "_ARCHIVE"], expectedSha256 = process.env[prefix + "_SHA256"];
  const receiptPath = process.env[prefix + "_PRODUCER_RECEIPT"];
  ensure(archive && receiptPath && expectedSha256 && /^[a-f0-9]{64}$/.test(expectedSha256), "original_input_missing");
  for (const path of [archive, receiptPath]) ensure(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, "original_input_path");
  const stat = await lstat(archive); ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.size > 0 && stat.size <= 8 * 1024 * 1024, "original_archive_file");
  const bytes = await readFile(archive), receiptBytes = await readFile(receiptPath);
  expect(hash(bytes)).toBe(expectedSha256);
  const receipt = object(JSON.parse(receiptBytes.toString("utf8"))), results = object(receipt.actualResults);
  expect(receipt.head).toBe(ORIGINAL_PRODUCER_HEAD); expect(receipt.status).toBe("PASS");
  expect(receipt.ownedClosureProven).toBe(true); expect(receipt.originalChildWaited).toBe(true);
  expect(results.actualTotal).toBe(1); expect(results.actualPassed).toBe(1); expect(results.actualFailed).toBe(0);
  expect(results.actualPending).toBe(0); expect(results.exactOriginalSelection).toBe(true);
  return { archive, expectedSha256, receiptPath, receiptHash: hash(receiptBytes), bytes };
}
/** Read-only whole checks of the exact original files, after owned Miniflare
 * disposal. These are neither a reconstructed expected catalog nor a host D1
 * adapter. Include platform tables and global page ownership/unused-page checks
 * unavailable from workerd's bounded table quick_check operations. */
async function verifyClosedNativeD1(directory: string, identities: { source: string; target: string }) {
  ensure(isAbsolute(directory) && resolve(directory) === directory && await realpath(directory) === directory, "closed_native_path");
  const entries = await readdir(directory, { recursive: true });
  const files = entries.filter(name => name.endsWith(".sqlite") && !name.endsWith("metadata.sqlite")).sort();
  expect(files, "Exactly the two original native D1 files must remain").toHaveLength(2);
  const before = new Map<string, string>();
  for (const name of entries.filter(name => /\.sqlite(?:-wal|-shm)?$/.test(name)).sort()) {
    const path = join(directory, name), stat = await lstat(path);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && await realpath(path) === path, "closed_native_file");
    before.set(name, hash(await readFile(path)));
  }
  const observed: string[] = [];
  for (const name of files) {
    const native = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      const identity = native.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1").get();
      ensure(identity && typeof identity.installation_id === "string", "closed_native_identity");
      observed.push(identity.installation_id);
      expect(native.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { native.close(); }
  }
  expect(observed.sort()).toEqual([identities.source, identities.target].sort());
  const after = (await readdir(directory, { recursive: true })).filter(name => /\.sqlite(?:-wal|-shm)?$/.test(name)).sort();
  expect(after).toEqual([...before.keys()].sort());
  for (const [name, expected] of before) expect(hash(await readFile(join(directory, name))), "Read-only original native file changed: " + name).toBe(expected);
}
async function run(kind: "ZERO" | "NONEMPTY") {
  const input = await retainedInput(kind), parent = process.env.WORKER_V5_NATIVE_FIXTURE_PARENT;
  ensure(parent && isAbsolute(parent) && resolve(parent) === parent && await realpath(parent) === parent, "private_parent");
  const root = await mkdtemp(join(parent, ".native-v5-target-")); await chmod(root, 0o700);
  const owner: Owner = { work: [] }; owners.add(owner);
  let failed = false, failure: unknown, persistedD1: string | undefined;
  let closedIdentities: { source: string; target: string } | undefined;
  try {
    let bundle: Awaited<ReturnType<typeof build>> | undefined, buildFailed = false, buildFailure: unknown;
    try { bundle = await original(owner, () => build({ stdin: { resolveDir: join(SOURCE_ROOT, "worker/recovery"),
      loader: "ts", contents: workerCode }, bundle: true, platform: "browser", format: "esm", target: "es2022", write: false, logLevel: "silent" })); }
    catch (error) { buildFailed = true; buildFailure = error; }
    try { await stop(); } catch (cleanup) { throw buildFailed ? new AggregateError([buildFailure, cleanup], "Original build and stop failed") : cleanup; }
    if (buildFailed) throw buildFailure;
    ensure(bundle?.outputFiles?.length === 1, "bundle"); expect(bundle.warnings).toEqual([]);
    const bucketName = "v5-target-" + randomUUID().replaceAll("-", "");
    const namespace = JSON.stringify({ kind: "local-r2", installationId: randomUUID(), bucketName });
    owner.native = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-07-20",
      d1Databases: { DB: randomUUID(), RECOVERY_DB: randomUUID() }, d1Persist: join(root, "d1"),
      r2Buckets: { ASSETS: bucketName }, r2Persist: join(root, "r2"), log: new Log(LogLevel.ERROR),
      bindings: { R2_BOOTSTRAP_NAMESPACE: namespace, RECOVERY_TARGET_ID: "isolated-v5-native-target", AUTH_MODE: "access" } });
    persistedD1 = owner.native.unsafeGetPersistPaths().get("d1");
    ensure(persistedD1, "original_persisted_d1_path");
    await original(owner, () => owner.native!.ready);
    const source = await original(owner, () => owner.native!.getD1Database("DB"));
    for (const migration of PORTABLE_RUNTIME_RECOVERY_MIGRATIONS) {
      const sql = await readFile(join(SOURCE_ROOT, "migrations", migration.name), "utf8");
      expect(hash(sql)).toBe(migration.sha256);
      const results = await original(owner, () => source.batch(splitSql(sql).map(statement => source.prepare(statement))));
      expect(results.every(result => result.success)).toBe(true);
    }
    const setup = await original(owner, () => owner.native!.dispatchFetch("https://native-v5.invalid/setup", { method: "POST" }));
    expect(setup.status).toBe(200); expect(await original(owner, () => setup.json())).toEqual({ setup: true });
    const response = await original(owner, () => owner.native!.dispatchFetch("https://native-v5.invalid/construct",
      { method: "POST", body: Uint8Array.from(input.bytes).buffer, headers: { "content-type": "application/zip", "x-original-archive-sha256": input.expectedSha256,
        "x-original-file-count": kind === "ZERO" ? "0" : "1" } }));
    const responseBytes = await original(owner, () => response.arrayBuffer());
    await original(owner, () => writeFile(join(root, "original-native-response.json"), new Uint8Array(responseBytes), { flag: "wx", mode: 0o600 }));
    const answer = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)));
    expect(response.status, JSON.stringify({ phase: answer.phase, reason: answer.reason })).toBe(200);
    expect(answer.format).toBe("v5"); expect(answer.sourceFileCount).toBe(kind === "ZERO" ? 0 : 1);
    expect(answer.archiveSha256).toBe(input.expectedSha256); expect(answer.sourceUnchanged).toBe(true);
    expect(answer.freshIdentity).toBe(true);
    ensure(typeof answer.sourceInstallationId === "string" && /^[a-f0-9]{32}$/.test(answer.sourceInstallationId)
      && typeof answer.targetInstallationId === "string" && /^[a-f0-9]{32}$/.test(answer.targetInstallationId)
      && answer.sourceInstallationId !== answer.targetInstallationId, "closed_native_identities");
    closedIdentities = { source: answer.sourceInstallationId, target: answer.targetInstallationId };
    expect(answer.mappingExact).toBe(true); expect(answer.missingMappingRejected).toBe(true);
    expect(answer.mappingCount).toBe(kind === "ZERO" ? 0 : 1); expect(answer.calls).toEqual({ put: 0, delete: 0 });
    expect(answer.receipt).toMatchObject({ checkpointId: "portable-runtime/v28", accountsDisabled: true, collaborationEnabled: false,
      localBindingsRestored: false, executionEnabled: false, maintenanceState: "fenced", payloadPublication: false,
      recoveryReady: false, rawMigrationExecution: false, targetLedger: "reviewed-code-catalog", deploymentChanged: false });
    const proof = object(answer.proof);
    expect(proof.exactNonlocal).toBe(true); expect(proof.emptyLocal).toBe(true); expect(proof.singletonsExact).toBe(true);
    expect(proof.foreignKeys).toBe(true); expect(proof.tableIntegrity).toBe(true);
    expect(proof.globalNativeIntegrity).toBe(false);
    ensure(Array.isArray(proof.checkedTables) && proof.checkedTables.includes("sqlite_schema")
      && proof.checkedTables.includes("d1_migrations") && proof.checkedTables.includes("sqlite_sequence"), "native_ledger_table_coverage");
    expect(proof.accountRows).toBeGreaterThan(0); expect(proof.disabledAccounts).toBe(proof.accountRows);
    const bucket = await original(owner, () => owner.native!.getR2Bucket("ASSETS"));
    const objects = await original(owner, () => bucket.list());
    expect(objects.truncated).toBe(false); expect(objects.objects).toEqual([]);
    // The original Node producer/ZIP are distinct historical scopes. Verify
    // neither is changed by the new native constructor or its mapped R2 plan.
    expect(hash(await readFile(input.archive))).toBe(input.expectedSha256);
    expect(hash(await readFile(input.receiptPath))).toBe(input.receiptHash);
  } catch (error) { failed = true; failure = error; }
  try { await close(owner); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original operation and close failed") : cleanup; }
  if (failed) throw failure;
  ensure(persistedD1 && closedIdentities && !owners.has(owner), "original_native_close_before_whole_check");
  await verifyClosedNativeD1(persistedD1, closedIdentities);
}
it(titles[0], () => run("ZERO"), 60_000);
it(titles[1], () => run("NONEMPTY"), 120_000);

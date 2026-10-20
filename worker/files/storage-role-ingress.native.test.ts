import { build } from "esbuild";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "native-role-assets" });
const ingresses = ["image", "project", "metrology", "import"] as const;
type Ingress = typeof ingresses[number];
const receiptTable = (kind: Ingress) => kind === "import" ? "imports"
  : kind === "metrology" ? "metrology_reference_upload_requests" : "r2_upload_requests";

// Exercise the public HTTP handlers against workerd's actual D1 sessions,
// atomic batch API, R2 binding and SQL guards. The wrapper only introduces
// explicitly named timing/acknowledgement faults; every SQL statement is
// executed by native D1 with the released migrations installed.
const workerSource = `
import { Hono } from 'hono';
import { routes as imageRoutes } from '../blob-lifecycle/attachment-routes';
import { routes as projectRoutes } from '../project-foundation-routes';
import { routes as metrologyRoutes } from '../process-definition/routes';
import { routes as importRoutes } from '../imports/fabublox-routes';
import { activateFileAuthority } from './authority-activation';
import { handleError } from '../platform/http';
const app = new Hono();
app.onError(handleError);
app.use('*', async (c,next)=>{c.set('userEmail','native-owner@example.test');await next();});
app.route('/',imageRoutes);app.route('/',projectRoutes);app.route('/',metrologyRoutes);app.route('/',importRoutes);
const stats={puts:[],gets:[],heads:[],acceptedBeforePut:[],lostAcceptanceAcknowledgements:0};
const acceptanceSql=sql=>/INSERT INTO (?:r2_upload_requests|metrology_reference_upload_requests|imports)\\b/.test(sql);
async function activate(db){
  const cutoff=await db.prepare('SELECT c.epoch,r.incarnation FROM file_shadow_control c JOIN file_shadow_runtime_guard r ON r.singleton=c.singleton').first();
  return activateFileAuthority(db,'native-operator@example.test',{requestId:crypto.randomUUID(),expectedEpoch:cutoff.epoch,expectedShadowIncarnation:cutoff.incarnation});
}
async function barrier(env,group){
  const response=await env.QUALIFICATION_GATE.fetch('https://qualification-gate.test/',{method:'POST',body:group});
  if(response.status!==204)throw new Error('Native qualification gate did not admit both requests');
}
async function sha(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export default {async fetch(request,env,ctx){
  const input=await request.json(),rawDb=env.DB;
  if(input.action==='bootstrap'){
    const now=new Date().toISOString();
    await rawDb.prepare("INSERT INTO storage_profiles VALUES('native-role-profile','r2',?,'bootstrap',NULL,1,'historical',?)").bind(env.R2_BOOTSTRAP_NAMESPACE,now).run();
    await rawDb.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'native-operator',? FROM file_shadow_control").bind(now).run();
    await rawDb.prepare("INSERT INTO file_shadow_profile_enablements VALUES('native-role-profile',1,'native-operator',?)").bind(now).run();
    await rawDb.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='native-operator',updated_at=?").bind(crypto.randomUUID(),now).run();
    await rawDb.prepare('UPDATE file_shadow_runtime_guard SET enabled=0').run();
    if(input.active!==false)await activate(rawDb);
    await rawDb.prepare("INSERT INTO recipe_families(id,name,template_type,created_at) VALUES('native-metrology-family','Native metrology','module',?)").bind(now).run();
    await rawDb.prepare("INSERT INTO template_versions(id,recipe_family_id,name,template_type,version,manifest_hash,content_json,created_at,template_kind) VALUES('native-metrology-template','native-metrology-family','Native metrology','module',1,?,'{}',?,'metrology')").bind('b'.repeat(64),now).run();
    return Response.json({ok:true});
  }
  if(input.action==='stats')return Response.json(stats);
  let lost=false,activated=false;
  async function beforeAcceptance(){
    if(input.activateBeforeAcceptance&&!activated){activated=true;await activate(rawDb);}
    if(input.raceGroup)await barrier(env,input.raceGroup);
  }
  function database(native){
    function statement(sql,inner){return {sql,inner,
      bind(...values){return statement(sql,inner.bind(...values));},
      first(...args){if(input.rejectRoleReads&&/FROM storage_role_defaults\\b/.test(sql))throw new Error('fixture fresh role read forbidden');return inner.first(...args);},
      all(...args){if(input.rejectRoleReads&&/FROM storage_role_defaults\\b/.test(sql))throw new Error('fixture fresh role read forbidden');return inner.all(...args);},
      raw(...args){return inner.raw(...args);},
      async run(...args){
        if(acceptanceSql(sql))await beforeAcceptance();
        const result=await inner.run(...args);
        if(input.loseAcceptanceAcknowledgement&&!lost&&acceptanceSql(sql)){lost=true;stats.lostAcceptanceAcknowledgements++;throw new Error('fixture committed acceptance acknowledgement lost');}
        return result;
      }
    };}
    return {prepare(sql){return statement(sql,native.prepare(sql));},
      withSession(constraint){return database(typeof native.withSession==='function'?native.withSession(constraint):native);},
      async batch(statements){
        const accepting=statements.some(item=>acceptanceSql(item.sql));
        if(accepting)await beforeAcceptance();
        const result=await native.batch(statements.map(item=>item.inner));
        if(input.loseAcceptanceAcknowledgement&&!lost&&accepting){lost=true;stats.lostAcceptanceAcknowledgements++;throw new Error('fixture committed acceptance acknowledgement lost');}
        return result;
      }
    };
  }
  const bucket={async put(key,value,options){
    stats.puts.push(key);
    const table=input.kind==='import'?'imports':input.kind==='metrology'?'metrology_reference_upload_requests':'r2_upload_requests';
    const receipts=(await (input.kind==='import'
      ? rawDb.prepare("SELECT item.storage_profile_id,item.storage_profile_revision,item.role_policy_revision FROM import_file_acceptances item JOIN imports parent ON parent.id=item.import_id WHERE parent.client_request_id=? AND parent.file_targets_protocol=1 AND item.candidate_object_key=? AND item.status='pending'").bind(input.requestId,key)
      : rawDb.prepare('SELECT storage_profile_id,storage_profile_revision,role_policy_revision FROM '+table+' WHERE client_request_id=?').bind(input.requestId)).all()).results;
    const defaults=(await rawDb.prepare('SELECT role,storage_profile_id,storage_profile_revision FROM storage_role_defaults ORDER BY role').all()).results;
    stats.acceptedBeforePut.push({receipts,defaults});
    return env.BUCKET.put(key,value,options);
  },get(key,options){stats.gets.push(key);return env.BUCKET.get(key,options);},
  head(key){stats.heads.push(key);return env.BUCKET.head(key);},delete(){throw new Error('fixture ingress must not delete bytes');}};
  const routeEnv={DB:database(rawDb),ASSETS:bucket,AUTH_MODE:'disabled',R2_BOOTSTRAP_NAMESPACE:input.missingNamespace?undefined:env.R2_BOOTSTRAP_NAMESPACE};
  let path,body,headers;
  if(input.kind==='import'){
    const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
    const manifest={schemaVersion:2,title:'Native role import '+input.requestId,
      source:{fileName:'source.xlsx',fileSha256:await sha(bytes),sheetName:'Process'},initialSubstrateStep:null,initialStateImageIds:[],warnings:[],
      steps:[{localId:'step',sourceRow:2,position:0,stepNumber:'1',sectionName:null,name:'Etch',toolName:null,parametersText:null,commentsText:null,imageIds:['image'],rawCells:{}}],
      images:[{localId:'image',sourcePart:'xl/media/image.png',mimeType:'image/png',assignedStepLocalId:'step',anchor:{}}]};
    body=new FormData();body.set('workbook',new File([bytes],'source.xlsx'));body.set('manifest',new File([JSON.stringify(manifest)],'manifest.json',{type:'application/json'}));body.set('image:image',new File([bytes],'image.png',{type:'image/png'}));
    path='/imports/fabublox';headers={'X-Import-Request-Id':input.requestId};
  }else{
    path=input.kind==='image'?'/assets':input.kind==='project'?'/project-assets':'/metrology-templates/native-metrology-template/references';
    body=new TextEncoder().encode('native role bytes '+input.kind+' '+input.requestId);
    headers={'Content-Type':input.kind==='image'?'image/png':'application/pdf','X-Upload-Request-Id':input.requestId,'X-Filename-Uri':encodeURIComponent('native-file.pdf'),'X-Project-Filename-Uri':encodeURIComponent('native-file.pdf')};
  }
  return app.fetch(new Request('https://fixture.test'+path,{method:'POST',headers,body}),routeEnv,ctx);
}};`;
let bundlePromise: Promise<string> | undefined;
function bundledWorker() {
  return bundlePromise ??= build({ stdin: { contents: workerSource, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, format: "esm", platform: "browser", write: false }).then(result => result.outputFiles[0].text);
}
async function fixture(active = true) {
  // Keep shared synchronization in Node. Each Worker remains active through
  // its own outbound service fetch rather than another request's Promise.
  const gates = new Map<string, { arrivals: number; ready: Promise<boolean>; release: (admitted: boolean) => void;
    timer: ReturnType<typeof setTimeout> }>();
  const native = new Miniflare({ modules: true, script: await bundledWorker(), compatibilityDate: "2026-07-20",
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
    d1Databases: ["DB"], r2Buckets: ["BUCKET"], log: new Log(LogLevel.ERROR), bindings: { R2_BOOTSTRAP_NAMESPACE: namespace } });
  const dispose = async () => {
    for (const gate of gates.values()) { clearTimeout(gate.timer); gate.release(false); }
    await native.dispose();
  };
  try {
    const db = await native.getD1Database("DB"), directory = new URL("../../migrations/", import.meta.url);
    for (const filename of readdirSync(directory).filter(filename => filename.endsWith(".sql")).sort())
      await db.batch(splitSql(readFileSync(new URL(filename, directory), "utf8")).map(statement => db.prepare(statement)));
    const call = async (input: unknown) => {
      const response = await native.dispatchFetch("https://fixture.test", { method: "POST", body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    };
    expect((await call({ action: "bootstrap", active })).status).toBe(200);
    const rows = async (table: string) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
    const stats = async () => (await call({ action: "stats" })).body as { puts: string[]; gets: string[]; heads: string[];
      acceptedBeforePut: Array<{ receipts: unknown[]; defaults: unknown[] }>; lostAcceptanceAcknowledgements: number };
    return { db, call, rows, stats, gateArrivals: (group: string) => gates.get(group)?.arrivals, dispose };
  } catch (error) { await dispose(); throw error; }
}

describe("fresh role acceptance with native Worker D1 and R2", () => {
  it("rolls role initialization back with a rejected business receipt at every public ingress", async () => {
    const f = await fixture();
    try {
      for (const [kind, rejection] of ingresses.flatMap(kind => ["ABORT", "IGNORE"].map(rejection => [kind, rejection] as const))) {
        const table = receiptTable(kind);
        await f.db.prepare(`CREATE TRIGGER reject_native_role_receipt BEFORE INSERT ON ${table} BEGIN SELECT RAISE(${rejection === "ABORT" ? "ABORT,'fixture business receipt rejected'" : "IGNORE"}); END;`).run();
        const result = await f.call({ kind, requestId: crypto.randomUUID() });
        expect(result.status, `${kind}: ${JSON.stringify(result.body)}`).toBe(503);
        expect(JSON.stringify(result.body)).not.toContain("fixture business receipt rejected");
        expect(await f.rows(table)).toEqual([]);
        expect(await f.rows("storage_role_defaults")).toEqual([]);
        expect((await f.stats()).puts).toEqual([]);
        expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
        await f.db.prepare("DROP TRIGGER reject_native_role_receipt").run();
      }
    } finally { await f.dispose(); }
  }, 60_000);

  it("reconciles lost acceptance acknowledgements, preserves recorded defaults and replays before unavailable fresh selection", async () => {
    const f = await fixture();
    try {
      let recordedDefaults: unknown[] | undefined;
      for (const kind of ingresses) {
        const requestId = crypto.randomUUID();
        const first = await f.call({ kind, requestId, loseAcceptanceAcknowledgement: true });
        expect(first.status, `${kind}: ${JSON.stringify(first.body)}`).toBe(201);
        const defaults = await f.rows("storage_role_defaults");
        if (recordedDefaults) expect(defaults).toEqual(recordedDefaults);
        else { recordedDefaults = defaults; expect(defaults).toHaveLength(2); }
        const receipt = (await f.rows(receiptTable(kind))).find(row => row.client_request_id === requestId);
        expect(receipt).toMatchObject(kind === "import"
          ? { status: "ready", file_targets_protocol: 1, role_policy_revision: 3,
            storage_profile_id: null, storage_profile_revision: null, storage_policy_revision: null }
          : { status: "ready", storage_profile_id: "native-role-profile", storage_profile_revision: 1, storage_policy_revision: 1, role_policy_revision: 3 });
        const accepted = await f.rows(receiptTable(kind)), before = await f.stats();
        const replay = await f.call({ kind, requestId, missingNamespace: kind === "import", rejectRoleReads: true });
        expect(replay.status, `${kind}: ${JSON.stringify(replay.body)}`).toBe(200);
        expect(replay.body).toEqual(first.body);
        expect(await f.rows(receiptTable(kind))).toEqual(accepted);
        expect(await f.rows("storage_role_defaults")).toEqual(recordedDefaults);
        expect((await f.stats()).puts).toEqual(before.puts);
        const rejected = await f.call({ kind, requestId: crypto.randomUUID(), rejectRoleReads: true });
        expect(rejected.status).toBe(503);
        expect(await f.rows(receiptTable(kind))).toEqual(accepted);
        expect(await f.rows("storage_role_defaults")).toEqual(recordedDefaults);
        expect((await f.stats()).puts).toEqual(before.puts);
      }
      const stats = await f.stats();
      expect(stats.lostAcceptanceAcknowledgements).toBe(4);
      expect(stats.puts).toHaveLength(6);
      for (const observation of stats.acceptedBeforePut) {
        expect(observation.receipts).toEqual([{ storage_profile_id: "native-role-profile", storage_profile_revision: 1, role_policy_revision: 3 }]);
        expect(observation.defaults).toEqual([
          { role: "internal", storage_profile_id: "native-role-profile", storage_profile_revision: 1 },
          { role: "originals", storage_profile_id: "native-role-profile", storage_profile_revision: 1 },
        ]);
      }
      expect((await f.rows("file_location_publications")).map(row => row.storage_profile_id)).toEqual(Array(6).fill("native-role-profile"));
      expect((await f.rows("file_acceptance_candidates")).filter(row => row.acceptance_kind === "import_file")).toHaveLength(3);
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await f.dispose(); }
  }, 60_000);

  it("fences a cutover that happens after legacy selection and before the receipt transaction", async () => {
    for (const kind of ingresses) {
      const f = await fixture(false);
      try {
        const result = await f.call({ kind, requestId: crypto.randomUUID(), activateBeforeAcceptance: true });
        expect(result.status, `${kind}: ${JSON.stringify(result.body)}`).toBe(503);
        expect((await f.db.prepare("SELECT mode FROM file_authority_control").first())!.mode).toBe("active");
        expect(await f.rows(receiptTable(kind))).toEqual([]);
        expect(await f.rows("storage_role_defaults")).toEqual([]);
        expect((await f.stats()).puts).toEqual([]);
        const fresh = await f.call({ kind, requestId: crypto.randomUUID() });
        expect(fresh.status, `${kind}: ${JSON.stringify(fresh.body)}`).toBe(201);
        expect(await f.rows("storage_role_defaults")).toHaveLength(2);
      } finally { await f.dispose(); }
    }
  }, 60_000);

  it("gives one native D1 execution owner to simultaneous requests with the same accepted identity", async () => {
    const f = await fixture();
    try {
      for (const kind of ingresses) {
        const requestId = crypto.randomUUID(), before = await f.stats();
        const results = await Promise.all([0, 1].map(() => f.call({ kind, requestId, raceGroup: `${kind}:${requestId}` })));
        expect(f.gateArrivals(`${kind}:${requestId}`)).toBe(2);
        expect(results.filter(result => result.status === 201)).toHaveLength(1);
        const replay = results.find(result => result.status !== 201)!;
        expect(kind === "import" ? [200, 409] : [200, 202]).toContain(replay.status);
        if (replay.status === 200) expect(replay.body).toEqual(results.find(result => result.status === 201)!.body);
        expect((await f.rows(receiptTable(kind))).filter(row => row.client_request_id === requestId)).toHaveLength(1);
        expect((await f.stats()).puts.length - before.puts.length).toBe(kind === "import" ? 3 : 1);
      }
      expect(await f.rows("storage_role_defaults")).toHaveLength(2);
      expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await f.dispose(); }
  }, 60_000);
});

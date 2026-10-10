import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReferenceTarget, ResolveReferencesResponse } from "../shared/reference-types";
import { REFERENCE_TARGET_TYPES } from "../shared/reference-types";
import { getReferenceTargetsReadOnly, resolveReferencesReadOnly } from "../worker/references/read-resolver";
import { listReferenceChildrenReadOnly } from "../worker/references/read-children";
import { searchReferencesReadOnly } from "../worker/references/read-search";
import { createReferenceReadService } from "../worker/references/read-service";
import { createReferenceReadHandlers, createReferenceReadSurface } from "../worker/references/read-surface";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "./installation-catalog";
import { installReviewedSqliteCatalog } from "./migrations";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { asStorageConfigurationSqlDatabase } from "./storage-configuration-sql";

// Genuine installed native SQL and actual Hono/body-limit library scope, not
// Node HTTP/session/physical lease/app activation or media/provider acceptance.
const actor = "local-account:reference_read_fixture", timestamp = "2026-08-01T00:00:00.000Z";
const graph = readFileSync(new URL("../worker/fixtures/reference-graph.sql", import.meta.url), "utf8");
const targets: ReferenceTarget[] = [
  {type:"sample",id:"reference-sample-a"},{type:"run",id:"reference-run-a"},
  {type:"run_step",id:"reference-step-a"},{type:"comment",id:"reference-comment"},
  {type:"comment_occurrence",id:"reference-comment-occurrence-a"},
  {type:"comment_attachment",id:"reference-comment-attachment"},
  {type:"execution_image",id:"reference-execution-image"},
  {type:"metrology_reference",id:"reference-metrology-reference"},
  {type:"recipe_revision",id:"reference-process-template"},
];
let directory = "", pristine = "", sequence = 0;
const cores: SqliteCapability[] = [];
beforeAll(() => {
  directory=mkdtempSync(join(tmpdir(),"rt1-reference-reads-"));pristine=join(directory,"pristine.sqlite");
  console.info("Private Reference read fixtures:",directory);
  const native=new DatabaseSync(pristine,{allowExtension:false,enableForeignKeyConstraints:true});
  try {
    native.exec("PRAGMA journal_mode=WAL");
    const receipt=installReviewedSqliteCatalog(native,CURRENT_NODE_INSTALLATION_CATALOG);
    expect(receipt.checkpointId).toBe("portable-runtime/v25");expect(receipt.appliedMigrations).toBe(23);
    native.exec(graph);expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }finally {native.close();}
});
afterEach(()=>{for(const core of cores.splice(0))core.close();}); // Retain isolated files, including failures.
function fixture() {
  const filename=join(directory,`${++sequence}.sqlite`);copyFileSync(pristine,filename);
  const native=new DatabaseSync(filename,{allowExtension:false,enableForeignKeyConstraints:true});
  const core=createSqliteCapability(native);cores.push(core);
  return {native,sql:asStorageConfigurationSqlDatabase(core)};
}
function metadata(native:DatabaseSync) {
  return native.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row=>{const name=row.name;if(typeof name!=="string")throw new TypeError("Invalid fixture table name");
      const statement=native.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY 1`);statement.setReadBigInts(true);
      return [name,statement.all()];});
}
const ids=(rows:readonly {target:ReferenceTarget}[])=>rows.map(row=>`${row.target.type}:${row.target.id}`);
function service(f:ReturnType<typeof fixture>) {
  return createReferenceReadService({database:()=>f.sql,admit:async selected=>{
    if(selected!==actor)throw new HTTPException(403,{message:"Fixture actor denied"});
  }});
}
function installErrorHandler<Bindings extends object>(app:Hono<{Bindings:Bindings;Variables:{userEmail:string}}>) {
  app.onError((error,c)=>error instanceof HTTPException?c.json({error:error.message},error.status):c.json({error:"Unexpected error"},500));
  app.use("*",async(c,next)=>{c.set("userEmail",actor);await next();});
}
function request(path:string,input:unknown) {
  return new Request(`https://fixture.test${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
}

describe("Three shared Reference metadata reads over actual native SQL: six scopes",()=>{
  it("preserves nine sources, original duplicates/order, canonical destinations and sparse registry without writes",async()=>{
    const f=fixture(),before=metadata(f.native),ordered=[...targets,{type:"sample",id:"missing"} as const,targets[0]];
    expect(targets.map(t=>t.type)).toEqual([...REFERENCE_TARGET_TYPES]);
    const response=await service(f).resolve(ordered,actor);
    expect(ids(response.results)).toEqual(ids(ordered.map(target=>({target}))));
    expect(response.results.slice(0,9).map(r=>r.resolution)).toEqual(Array(9).fill("resolved"));
    expect(response.results[9].resolution).toBe("not_found");expect(response.results[10]).toEqual(response.results[0]);
    expect(response.results[3].contexts).toHaveLength(2);
    expect(response.results[0].destination).not.toBeNull();
    expect(await getReferenceTargetsReadOnly(f.sql,targets)).toEqual(new Map());
    expect(metadata(f.native)).toEqual(before);
    f.native.prepare(`INSERT INTO reference_targets(id,target_type,target_id,first_registered_at,last_validated_at,tombstoned_at,last_known_contexts_json)
      VALUES('tombstone','sample','reference-sample-a',?,?,?,'[]')`).run(timestamp,timestamp,timestamp);
    const seeded=metadata(f.native),[tombstone]=await resolveReferencesReadOnly(f.sql,[targets[0]]);
    expect(tombstone).toMatchObject({resolution:"tombstoned",source:null,contexts:[]});
    expect((await getReferenceTargetsReadOnly(f.sql,[targets[0]])).values().next().value).toMatchObject({registryVersion:1});
    expect(metadata(f.native)).toEqual(seeded);
  });
  it("preserves child hierarchy/order, eligible parents, bounded truncation and lifecycle filtering",async()=>{
    const f=fixture(),before=metadata(f.native);
    const sample=await listReferenceChildrenReadOnly(f.sql,{parent:targets[0]});expect(ids(sample.children)).toEqual(["run:reference-run-a"]);
    const step=await listReferenceChildrenReadOnly(f.sql,{parent:targets[2],limit:1});
    expect(ids(step.children)).toEqual(["comment:reference-comment"]);expect(step.truncated).toBe(true);
    const comment=await listReferenceChildrenReadOnly(f.sql,{parent:targets[3]});
    expect(ids(comment.children)).toEqual(["comment_occurrence:reference-comment-occurrence-a","comment_occurrence:reference-comment-occurrence-b","comment_attachment:reference-comment-attachment"]);
    const leaf=await listReferenceChildrenReadOnly(f.sql,{parent:targets[6]});expect(leaf.parentEligible).toBe(true);expect(leaf.children).toEqual([]);
    const missing=await listReferenceChildrenReadOnly(f.sql,{parent:{type:"sample",id:"missing"}});expect(missing.parentEligible).toBe(false);expect(missing.children).toEqual([]);
    expect(metadata(f.native)).toEqual(before);
    f.native.prepare("UPDATE runs SET deleted_at=? WHERE id='reference-run-a'").run(timestamp);
    const changed=metadata(f.native),hidden=await listReferenceChildrenReadOnly(f.sql,{parent:targets[0]});
    expect(hidden.children).toEqual([]);expect(metadata(f.native)).toEqual(changed);
  });
  it("preserves literal Unicode matching, exact-ID ranking, Sample/time filters and bounded candidate truncation",async()=>{
    const f=fixture();f.native.prepare("INSERT INTO samples(id,code,title,description,created_at,updated_at) VALUES('literal','LITERAL','实验 100%_ready\\path','Unique literal',?,?)").run(timestamp,timestamp);
    const add=f.native.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES(?,?,?, ?,?)");
    for(let i=0;i<165;i++)add.run(`limit-${i}`,`LIMIT-${i}`,"bounded match",timestamp,timestamp);
    const before=metadata(f.native);
    const exact=await searchReferencesReadOnly(f.sql,{query:"reference-sample-a",types:["sample"]});
    expect(exact.results[0]).toMatchObject({target:targets[0],match:{tier:"exact_id"}});
    expect(ids((await searchReferencesReadOnly(f.sql,{query:"%_ready\\path",types:["sample"]})).results)).toEqual(["sample:literal"]);
    expect(ids((await searchReferencesReadOnly(f.sql,{query:"实验",types:["sample"]})).results)).toEqual(["sample:literal"]);
    const scoped=await searchReferencesReadOnly(f.sql,{query:"Shared reference",types:["comment"],sampleId:"reference-sample-a",from:"2026-08-01",to:"2026-08-02"});
    expect(ids(scoped.results)).toEqual(["comment:reference-comment"]);
    expect((await searchReferencesReadOnly(f.sql,{query:"Shared reference",types:["comment"],from:"2026-08-02"})).results).toEqual([]);
    const limited=await searchReferencesReadOnly(f.sql,{query:"bounded match",types:["sample"],limit:2});
    expect(limited.results).toHaveLength(2);expect(limited.truncated).toBe(true);
    expect(limited.results.map(r=>r.target.id)).toEqual(["limit-0","limit-1"]);
    const boundaryService=service(f);
    for(const input of [{query:"Reference",types:["sample"],to:"0001-01-01T00:00:00+01:00"},
      {query:"Reference",types:["sample"],from:"9999-12-31T23:59:59-01:00"}]) {
      // Preserve the existing ISO TEXT comparison, including expanded years;
      // assert genuine service/direct parity rather than changing SQL chronology.
      const actual=await boundaryService.search(input,actor);
      expect(actual).toEqual(await searchReferencesReadOnly(f.sql,input));
      if("to" in input)expect(actual.results).toEqual([]);
      else expect(ids(actual.results)).toEqual(["sample:reference-sample-a","sample:reference-sample-b"]);
    }
    expect(metadata(f.native)).toEqual(before);
  });
  it("keeps exact native cells and decodes only consumed version/specificity fields with named bounds",async()=>{
    const f=fixture(),cells=await f.sql.prepare("SELECT 9007199254740993 AS exact_integer,0.25 fraction,x'00ff' bytes,NULL absent").first();
    expect(cells).toEqual({exact_integer:9007199254740993n,fraction:0.25,bytes:new Uint8Array([0,255]),absent:null});
    f.native.prepare("UPDATE template_versions SET version=9007199254740991 WHERE id='reference-process-template'").run();
    expect((await resolveReferencesReadOnly(f.sql,[targets[8]]))[0].source?.title).toContain("9007199254740991");
    f.native.prepare("UPDATE template_versions SET version=9007199254740993 WHERE id='reference-process-template'").run();
    await expect(resolveReferencesReadOnly(f.sql,[targets[8]])).rejects.toThrow(/reference.recipe_version/);
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("captures each original Request before actual bodyLimit replacement, supports concurrent contexts and owns only POST methods",async()=>{
    const f=fixture(),selected:Request[]=[],replaced:Request[]=[],app=new Hono<{Bindings:{};Variables:{userEmail:string}}>();
    installErrorHandler(app);const actualService=service(f);
    let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
    const handlers=createReferenceReadHandlers<{}>((original)=>{
      selected.push(original);
      return createReferenceReadService({database:()=>f.sql,admit:async selectedActor=>{
        if(selectedActor!==actor)throw new HTTPException(403);if(original.url.includes("held=1"))await held;
      }});
    });
    app.post("/references/resolve",handlers.captureIngressRequest,bodyLimit({maxSize:4096}),async(c,next)=>{replaced.push(c.req.raw);await next();},handlers.resolve);
    const first=request("/references/resolve?held=1",{targets:[targets[0]]}),second=request("/references/resolve",{targets:[targets[8]]});
    const firstResult=Promise.resolve(app.fetch(first,{}));firstResult.catch(()=>undefined);
    let secondResponse:Response,firstResponse:Response;
    try {secondResponse=await app.fetch(second,{});}finally {release();firstResponse=await firstResult;}
    expect(secondResponse.status).toBe(200);
    expect((await secondResponse.json() as ResolveReferencesResponse).results[0].target).toEqual(targets[8]);
    expect(firstResponse.status).toBe(200);
    expect(selected).toContain(first);expect(selected).toContain(second);expect(replaced).not.toContain(first);expect(replaced).not.toContain(second);
    let otherSelections=0;const surface=new Hono<{Bindings:{};Variables:{userEmail:string}}>();installErrorHandler(surface);
    surface.route("/",createReferenceReadSurface<{}>(()=>{otherSelections++;return actualService;}));
    const before=metadata(f.native);
    expect((await surface.fetch(new Request("https://fixture.test/references/resolve"),{})).status).toBe(404);
    expect((await surface.fetch(new Request("https://fixture.test/references/media/execution_image/a"),{})).status).toBe(404);
    const malformed=new Request("https://fixture.test/references/resolve",{method:"POST",body:"{"});
    expect((await surface.fetch(malformed,{})).status).toBe(400);expect(otherSelections).toBe(0);expect(metadata(f.native)).toEqual(before);
  });
  it("denies stale admission before returning an actual projection and denies new callers before SQL without business writes",async()=>{
    const f=fixture(),before=metadata(f.native),prepare=vi.spyOn(f.sql,"prepare");let allowed=false;
    const current=createReferenceReadService({database:()=>f.sql,admit:async selected=>{
      if(!allowed || selected!==actor)throw new HTTPException(403,{message:"Fixture admission revoked"});
    }});
    await expect(current.resolve([targets[0]],actor)).rejects.toThrow("Fixture admission revoked");expect(prepare).not.toHaveBeenCalled();
    allowed=true;
    const codes=constants as unknown as Record<string,number>;
    const authorizer=f.native as DatabaseSync & {setAuthorizer(callback:((action:number,table:string|null)=>number)|null):void};
    authorizer.setAuthorizer((action,table)=>{if(action===codes.SQLITE_READ&&table==="samples")allowed=false;return codes.SQLITE_OK;});
    try {await expect(current.resolve([targets[0]],actor)).rejects.toThrow("Fixture admission revoked");}
    finally {authorizer.setAuthorizer(null);}
    expect(prepare).toHaveBeenCalled();expect(metadata(f.native)).toEqual(before);
  });
});

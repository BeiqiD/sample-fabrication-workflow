// SOURCE-ONLY. Native/HTTP eight UNRUN; no default Worker/application mount.
// Positive authority is closed genuine e39 enrollment plus stopped named root
// allocation or a real existing Bob manager Request. Typed stopped metadata
// construction below proves read filtering, not HTTP business writes/File publication.
import {beforeAll,expect,it} from "vitest";
import type {ReferenceTarget,ResolveReferencesResponse} from "../shared/reference-types";
import type {SearchReferencesResponse} from "../shared/reference-search";
import type {ListReferenceChildrenResponse} from "../shared/reference-children";
import {resolveReferencesReadOnly} from "../worker/references/read-resolver";
import {searchReferencesReadOnly} from "../worker/references/read-search";
import {createLocalReferenceReadV28Candidate} from "./collaboration/local-reference-read-v28-candidate";
import {preparedReferences,referenceFilteredReadFixture,referenceTargets,type ReferenceFixture} from "./collaboration-reference-filtered-read-v28-fixture.qualification";
import {readLogicalSampleSource,type LogicalSampleSource} from "./collaboration-sample-v28-logical-artifact.qualification";
import {configureLogicalFixture,original,nativeOwner,privateCopy,rootOwnerUid,policy,V26_NODE_INSTALLATION_CATALOG,
  V27_INERT_NODE_INSTALLATION_CATALOG_CANDIDATE,installReviewedSqliteCatalog,admitInstallationRecoverySource} from "./collaboration-sample-v28-logical-fixture.qualification";
import {createInstalledLocalIdentity} from "./auth/identity";
import {createLocalAuthentication} from "./auth/local-auth-http";
import {createLoopbackLocalAuthTransport} from "./auth/local-auth-transport";
import {createPasswordHasher} from "./auth/passwords";
import {asProjectReadDatabase} from "./project-read-sql";
import type {SqliteStatement} from "./sqlite";

let source:LogicalSampleSource;
beforeAll(()=>original(async()=>{await configureLogicalFixture();source=await readLogicalSampleSource();}),20000);
const now="2026-10-11T00:00:00.000Z";
const resolveBody=(targets:readonly ReferenceTarget[]=referenceTargets)=>({targets});
function business(f:ReferenceFixture){return ["samples","runs","run_steps","run_step_comments","comment_submissions",
  "comment_submission_targets","comment_submission_items","run_step_assets","metrology_template_references","reference_targets","events"]
  .map(table=>({table,rows:f.native.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()}));}
async function shareB(f:ReferenceFixture){
  const bob=await f.login("bob");
  const result=await f.request(`/api/collaboration/resources/sample/reference-sample-b/grants/${source.aliceMember}`,"PUT",
    {operation:"grant",expectedResourceRevision:1,expectedGrantRevision:null,capability:"read",enabled:true},bob);
  expect(result.status).toBe(200);
}
async function typedSetup(path:string,statements:(owner:Awaited<ReturnType<typeof nativeOwner>>)=>SqliteStatement[]){
  const owner=await nativeOwner(path);let workFailed=false,workFailure:unknown;
  try{await owner.lease.withWriter(async()=>{const items=statements(owner);expect((await owner.database.batch(items)).length).toBe(items.length);
    expect(owner.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);});}
  catch(error){workFailed=true;workFailure=error;throw error;}
  finally{try{await owner.close();}catch(cleanup){if(workFailed)throw new AggregateError([workFailure,cleanup],"Original stopped Reference metadata and first close failed");throw cleanup;}}
}

it("delegates all nine complete mature resolutions and search metadata only after genuine current root sharing",()=>original(async()=>{
  const f=await referenceFilteredReadFixture(await preparedReferences(source)),alice=await f.login("alice"),before=business(f);
  const masked=await f.request("/api/references/resolve","POST",resolveBody(),alice);
  expect(masked.status).toBe(200);const hidden=masked.value as unknown as ResolveReferencesResponse;
  for(const index of [3,4,5]){expect(hidden.results[index]!.resolution).toBe("not_found");expect(hidden.results[index]!.source).toBeNull();expect(hidden.results[index]!.contexts).toEqual([]);}
  expect(masked.text).not.toContain("Shared reference Comment body");expect(masked.text).not.toContain("Reference sample B");
  await shareB(f);
  const expected=await f.lease.withWriter(()=>resolveReferencesReadOnly(asProjectReadDatabase(f.database),referenceTargets));
  expect(expected.map(row=>row.target.type)).toEqual(referenceTargets.map(row=>row.type));expect(expected.every(row=>row.resolution==="resolved")).toBe(true);
  const accepted=await f.request("/api/references/resolve","POST",resolveBody(),alice);expect(accepted.status).toBe(200);expect(accepted.value).toEqual({results:expected});
  const input={query:"Reference",limit:50};
  const baseline=await f.lease.withWriter(()=>searchReferencesReadOnly(asProjectReadDatabase(f.database),input));
  const stopNativeSqlTrace=f.beginNativeSqlTrace();
  try {
  const search=await f.request("/api/references/search","POST",input,alice);expect(search.status).toBe(200);expect(search.value).toEqual(baseline);
  } finally { stopNativeSqlTrace(); }
  expect(business(f)).toEqual(before);
  for(const route of ["/api/references/media/execution_image/reference-execution-image","/api/files","/api/export/full"])
    expect((await f.request(route,"GET",undefined,alice)).status).toBe(503);
}),20000);

it("filters denied runs before the original per-type search limit and global count or truncated flag",()=>original(async()=>{
  const path=await preparedReferences(source);
  await typedSetup(path,owner=>Array.from({length:161},(_,index)=>owner.database.prepare(`INSERT INTO runs
    (id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,template_name_snapshot,template_type_snapshot,
      template_version_snapshot,status,created_at,completed_at,run_kind)
    SELECT ?,sample_id,recipe_family_id,template_version_id,?,run_group_id,'Reference private limit row',template_type_snapshot,
      template_version_snapshot,'complete',?,?,run_kind FROM runs WHERE id='reference-run-b'`).bind(`private-search-run-${index}`,index+2,now,now)));
  const f=await referenceFilteredReadFixture(path),alice=await f.login("alice"),before=business(f);
  expect(f.native.prepare("SELECT count(*) n FROM runs WHERE sample_id='reference-sample-b'").get()?.n).toBe(162);
  expect(f.native.prepare("SELECT count(*) n FROM runs WHERE sample_id='reference-sample-b' AND status='complete' AND completed_at=? AND id LIKE 'private-search-run-%'").get(now)?.n).toBe(161);
  expect(f.native.prepare("SELECT count(*) n FROM runs WHERE sample_id='reference-sample-b' AND status='active' AND run_kind='process' AND deleted_at IS NULL").get()?.n).toBe(1);
  const response=await f.request("/api/references/search","POST",{query:"Reference",types:["run"],limit:1},alice);
  expect(response.status).toBe(200);const result=response.value as unknown as SearchReferencesResponse;
  expect(result.results.map(row=>row.target)).toEqual([{type:"run",id:"reference-run-a"}]);expect(result.truncated).toBe(false);
  expect(response.text).not.toContain("private-search-run");expect(response.text).not.toContain("Reference sample B");expect(business(f)).toEqual(before);
}),20000);

it("filters entire unreadable canonical child groups before the original 201-row child overflow and count",()=>original(async()=>{
  const path=await preparedReferences(source);
  await typedSetup(path,owner=>{
    const rows=JSON.stringify(Array.from({length:205},(_,index)=>({
      id:`private-child-comment-${index}`,group:`private-child-group-${index}`,
      occurrence:`private-child-comment-${index}-occurrence`,
    })));
    // Same fixed205 canonical groups/complete cloned cells and original row guards.
    // Three owned statements still run inside typedSetup's one original batch.
    return [owner.database.prepare(`INSERT INTO comment_submissions(id,context_kind,scope,body,status,actor_email,created_at,updated_at,completed_at)
      SELECT json_extract(j.value,'$.id'),'run_steps','common','Private child body',cs.status,cs.actor_email,cs.created_at,cs.updated_at,cs.completed_at
      FROM json_each(?) j JOIN comment_submissions cs ON cs.id='reference-comment'
      ORDER BY CAST(j.key AS INTEGER)`).bind(rows),
      owner.database.prepare(`INSERT INTO comment_submission_targets(submission_id,sample_id,run_id,run_step_id,expected_updated_at)
        SELECT json_extract(j.value,'$.id'),t.sample_id,t.run_id,t.run_step_id,t.expected_updated_at
        FROM json_each(?) j JOIN comment_submission_targets t ON t.submission_id='reference-comment'
        ORDER BY CAST(j.key AS INTEGER),t.run_step_id`).bind(rows),
      owner.database.prepare(`INSERT INTO run_step_comments(id,run_step_id,scope,operation_group_id,submission_id,actor_email,created_at,updated_at)
        SELECT json_extract(j.value,'$.occurrence'),rsc.run_step_id,rsc.scope,json_extract(j.value,'$.group'),json_extract(j.value,'$.id'),rsc.actor_email,rsc.created_at,rsc.updated_at
        FROM json_each(?) j JOIN run_step_comments rsc ON rsc.id='reference-comment-occurrence-a'
        ORDER BY CAST(j.key AS INTEGER)`).bind(rows)];
  });
  const f=await referenceFilteredReadFixture(path),alice=await f.login("alice"),before=business(f);
  expect(f.native.prepare("SELECT count(*) n FROM run_step_comments WHERE run_step_id='reference-step-a' AND deleted_at IS NULL").get()?.n).toBe(206);
  const response=await f.request("/api/references/children","POST",{parent:{type:"run_step",id:"reference-step-a"},limit:1},alice);
  expect(response.status).toBe(200);const result=response.value as unknown as ListReferenceChildrenResponse;
  expect(result.parentEligible).toBe(true);expect(result.children.map(row=>row.target)).toEqual([{type:"execution_image",id:"reference-execution-image"}]);expect(result.truncated).toBe(false);
  expect(response.text).not.toContain("Private child body");expect(response.text).not.toContain("private-child-comment");expect(business(f)).toEqual(before);
}),20000);

it("checks every actual canonical occurrence and every matching audit action while preserving authorized neutral Gone",()=>original(async()=>{
  const f=await referenceFilteredReadFixture(await preparedReferences(source)),alice=await f.login("alice");
  expect(f.independent("DELETE FROM comment_submission_targets WHERE submission_id='reference-comment' AND sample_id='reference-sample-b'")).toBe("1");
  expect(f.independent("UPDATE reference_targets SET last_known_contexts_json='[]' WHERE target_type IN('comment','comment_occurrence','comment_attachment')")).toBe("3");
  const target={type:"comment",id:"reference-comment"} as const;
  const occurrence=await f.request("/api/references/resolve","POST",resolveBody([target]),alice);
  expect(occurrence.status).toBe(200);expect((occurrence.value as unknown as ResolveReferencesResponse).results[0]!.resolution).toBe("not_found");expect(occurrence.text).not.toContain("Shared reference Comment body");
  expect(f.independent("UPDATE run_step_comments SET run_step_id='reference-step-a' WHERE id='reference-comment-occurrence-b'")).toBe("1");
  const visible=await f.request("/api/references/resolve","POST",resolveBody([target]),alice);expect(visible.status).toBe(200);expect(visible.text).toContain("Shared reference Comment body");
  expect(f.independent(`INSERT INTO events(id,sample_id,kind,body,metadata_json,actor_email,created_at)
    VALUES('private-reference-audit','reference-sample-b','comment','Private retained audit',?, ?,?)`,JSON.stringify({action:"comment_submission_deleted",submissionId:target.id}),`local-account:${source.alice}`,now)).toBe("1");
  for(const action of ["comment_submission_deleted","comment_submission_restored","unrecognized_retained_action"]){
    expect(f.independent("UPDATE events SET metadata_json=? WHERE id='private-reference-audit'",JSON.stringify({action,submissionId:target.id}))).toBe("1");
    const denied=await f.request("/api/references/resolve","POST",resolveBody([target]),alice);expect(denied.status).toBe(200);
    expect((denied.value as unknown as ResolveReferencesResponse).results[0]!.resolution).toBe("not_found");expect(denied.text).not.toContain("Private retained audit");expect(denied.text).not.toContain("Shared reference Comment body");
  }
  expect(f.independent("UPDATE reference_targets SET tombstoned_at=? WHERE target_type='comment'",now)).toBe("1");
  const prepare=f.native.prepare.bind(f.native),selected:unknown[]=[];
  f.native.prepare=(...args)=>{const statement=prepare(...args);if(/^\s*SELECT id, context_kind, scope, body, status/.test(args[0])){
    const all=statement.all.bind(statement);statement.all=(...values)=>{selected.push(JSON.parse(String(values[0])));return Reflect.apply(all,statement,values);};}return statement;};
  try{const gone=await f.request("/api/references/resolve","POST",resolveBody([target]),alice);expect(gone.status).toBe(200);
    const value=(gone.value as unknown as ResolveReferencesResponse).results[0]!;expect(value.resolution).toBe("tombstoned");expect(value.source).toBeNull();expect(value.contexts).toEqual([]);expect(selected).toEqual([[]]);}
  finally{f.native.prepare=prepare;}
  expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}),20000);

it("rejects late same-root native parent changes and revoked current membership before releasing body or retained history",()=>original(async()=>{
  const path=await preparedReferences(source);
  await typedSetup(path,owner=>[owner.database.prepare(`INSERT INTO runs
    (id,sample_id,recipe_family_id,template_version_id,sequence_no,run_group_id,template_name_snapshot,template_type_snapshot,
      template_version_snapshot,status,created_at,completed_at,run_kind)
    SELECT 'reference-other-run-a',sample_id,recipe_family_id,template_version_id,2,run_group_id,template_name_snapshot,
      template_type_snapshot,template_version_snapshot,'complete',created_at,?,run_kind FROM runs WHERE id='reference-run-a'`).bind(now),
    owner.database.prepare("UPDATE reference_targets SET last_known_contexts_json='[]' WHERE target_type='run_step'")]);
  const f=await referenceFilteredReadFixture(path),alice=await f.login("alice"),prepare=f.native.prepare.bind(f.native),exec=f.native.exec.bind(f.native);
  expect(f.native.prepare("SELECT status,completed_at FROM runs WHERE id='reference-other-run-a'").get()).toMatchObject({status:"complete",completed_at:now});
  expect(f.native.prepare("SELECT count(*) n FROM runs WHERE sample_id='reference-sample-a' AND status='active' AND run_kind='process' AND deleted_at IS NULL").get()?.n).toBe(1);
  let sourceRead=false,changed=false;
  f.native.prepare=(...args)=>{const statement=prepare(...args);if(/^\s*SELECT rs.id AS step_id/.test(args[0])){const all=statement.all.bind(statement);statement.all=(...values)=>{const rows=Reflect.apply(all,statement,values);sourceRead=true;return rows;};}return statement;};
  f.native.exec=sql=>{exec(sql);if(sql==="COMMIT"&&sourceRead&&!changed){changed=true;expect(f.independent("UPDATE run_steps SET run_id='reference-other-run-a' WHERE id='reference-step-a'")).toBe("1");}};
  try{const result=await f.request("/api/references/resolve","POST",resolveBody([{type:"run_step",id:"reference-step-a"}]),alice);expect(result.status).toBe(409);expect(changed).toBe(true);expect(result.text).not.toContain("Reference etch A");}
  finally{f.native.prepare=prepare;f.native.exec=exec;}
  const previous=f.capturedRead()!;
  const copy=new Request(previous.request.url,{method:"POST",headers:previous.request.headers,body:"{}"});
  await expect(f.reader.perform(copy,previous.token)).rejects.toMatchObject({status:403});
  const bodyReads=f.bodyReads();
  f.afterCapture(async()=>{expect(f.independent("UPDATE collaboration_identities SET enabled=0,revision=revision+1 WHERE member_id=?",source.aliceMember)).toBe("1");});
  const denied=await f.request("/api/references/resolve","POST",resolveBody(),alice);expect(denied.status).toBe(403);
  expect(f.bodyReads()).toBe(bodyReads);expect(denied.text).not.toContain("Shared reference Comment body");
}),20000);

it("refuses disabled V28 and changed Request scope without exposing a File capability",()=>original(async()=>{
  const f=await referenceFilteredReadFixture(await preparedReferences(source)),alice=await f.login("alice");
  expect((await f.request("/api/references/resolve","GET",undefined,alice)).status).toBe(503);
  expect((await f.request("/api/references/resolve?scope=workspace","POST",resolveBody(),alice)).status).toBe(403);
  expect(f.independent("UPDATE collaboration_control SET enforcement='disabled',revision=revision+1 WHERE singleton=1")).toBe("1");
  expect((await f.request("/api/references/resolve","POST",resolveBody(),alice)).status).toBe(503);
  await f.close();
  expect(rootOwnerUid).toBeDefined();
}),20000);

// Separate unchanged 20s case budgets: no two fresh old-schema installations
// are concealed inside one case or carried from unrelated qualification.
it.each([
  ["V26",V26_NODE_INSTALLATION_CATALOG],
  ["V27",V27_INERT_NODE_INSTALLATION_CATALOG_CANDIDATE],
] as const)("refuses original %s through its genuine current identity and physical lease",(_label,catalog)=>original(async()=>{
    const owner=await nativeOwner(await privateCopy());let workFailed=false,workFailure:unknown;
    try{await owner.lease.withWriter(async()=>{
      installReviewedSqliteCatalog(owner.native,catalog);const admission=admitInstallationRecoverySource(owner.native,catalog);
      const identity=await createInstalledLocalIdentity({database:owner.database,nativeDatabase:owner.native,admission,hasher:createPasswordHasher(),policy});
      const authentication=createLocalAuthentication({identity,transport:createLoopbackLocalAuthTransport({publicOrigin:"http://127.0.0.1:48173"}),now:Date.now});
      expect(()=>createLocalReferenceReadV28Candidate({database:owner.database,nativeDatabase:owner.native,writerLease:owner.lease,admission,authentication})).toThrow();
      expect(owner.native.prepare("SELECT count(*) n FROM local_sessions").get()?.n).toBe(0);
      expect(owner.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });}catch(error){workFailed=true;workFailure=error;throw error;}
    finally{try{await owner.close();}catch(cleanup){if(workFailed)throw new AggregateError([workFailure,cleanup],"Original old-catalog Reference denial and first close failed");throw cleanup;}}
  expect(rootOwnerUid).toBeDefined();
}),20000);

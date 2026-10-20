// SOURCE-ONLY genuine Sample text record/remove/history fixture, unmounted product.
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hashInitialSubstrateRepresentation, hashStepDefinition, hashRecipeManifest, logicalStepKey, stableJson, STEP_HASH_SCHEME } from "../shared/content-addressing";
import { createLocalSamplePermissionV28Candidate } from "./collaboration/local-sample-permission-candidate";
import { createLocalSampleRecordPermissionV28Candidate, type SampleRecordPermissionRequest } from "./collaboration/local-sample-record-permission-v28-candidate";
import { createLocalSampleRecordRemovePermissionV28Candidate, type SampleRecordRemovePermissionRequest } from "./collaboration/local-sample-record-remove-permission-v28-candidate";
import { executeDomainRootV28OperatorCandidate } from "./operations/collaboration-domain-roots-v28-candidate";
import { nativeOwner } from "./collaboration-sample-v28-logical-fixture.qualification";
import { expect } from "vitest";
import { createInstalledLocalIdentity } from "./auth/identity";
import { createLocalAuthentication, type LocalAuthEnvironment } from "./auth/local-auth-http";
import { createLoopbackLocalAuthTransport } from "./auth/local-auth-transport";
import { LocalRequestSubjectError } from "./auth/local-request-subject";
import { createPasswordHasher } from "./auth/passwords";
import { createLocalRunStartPreviewPermissionV28Candidate, type RunStartPreviewPermissionRequest, type RunStartPreviewPermissionScope } from "./collaboration/local-run-start-preview-permission-v28-candidate";
import { createLocalSampleDetailReadV28Candidate, type SampleDetailV28Request } from "./collaboration/local-sample-detail-read-v28-candidate";
import { createLocalRunStepCommentPermissionV28Candidate } from "./collaboration/local-run-step-comment-permission-v28-candidate";
import { createLocalRootManagementV28Candidate, type RootManagementChange, type RootManagementScope } from "./collaboration/local-root-management-v28-candidate";
import { createNodeHttpServer, stopNodeHttpServerAndDrain } from "./http";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "./installation-catalog-v28-candidate";
import { admitInstallationRecoverySource } from "./migrations";
import { acquireLinuxWriterLease, type LinuxWriterLease } from "./operations/writer-lease";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { assertLogicalSampleMembers, hashClosedLogicalDatabase, type LogicalSampleSource } from "./collaboration-sample-v28-logical-artifact.qualification";
import { password, policy, privateCopy, retain, rootOwnerUid } from "./collaboration-sample-v28-logical-fixture.qualification";

export const runA = "reference-run-a", runB = "reference-run-b", stepA = "reference-step-a";
export type RunStartPreviewSession = { cookie: string; csrf: string };
export const startFamily = "candidate-media-free-process-family", startTemplate = "candidate-media-free-process-v1";
export async function preparedStartSource(source: LogicalSampleSource, media = false) {
  const path = await privateCopy(source.databasePath);
  expect(await hashClosedLogicalDatabase(path)).toBe(source.databaseSha256);
  await assertLogicalSampleMembers(path, source);
  const f = await nativeOwner(path);
  let workFailed = false, workFailure: unknown;
  try { await f.lease.withWriter(async () => {
    admitInstallationRecoverySource(f.native,V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
    // Declared synthetic, stopped BUSINESS source metadata only. This is not
    // import/publishing route qualification or an authority/actor grant. Exact
    // mature canonical helpers derive a valid media-free Step0 and one step.
    const existingImports=f.native.prepare("SELECT * FROM imports ORDER BY id").all();
    const initial = { localId:"candidate-substrate",stepNumber:"0",name:"Substrate Stack",
      toolName:null,parametersText:"Silicon",commentsText:null,rawCells:{},imageIds:[] };
    const step = {name:"Candidate etch",stepNumber:"1",toolName:"RIE",parametersText:null,commentsText:null};
    const asset = media ? f.native.prepare("SELECT id,sha256 FROM assets WHERE id='reference-execution-asset' AND status='ready'").get() : undefined;
    if (media && (asset?.id !== "reference-execution-asset" || typeof asset.sha256 !== "string")) throw new Error("Real original ready media metadata required");
    const state = await hashInitialSubstrateRepresentation(initial,asset ? [String(asset.sha256)] : []), definition = await hashStepDefinition(step);
    const key = logicalStepKey(step,1), manifest = await hashRecipeManifest([{logicalStepKey:key,definitionHash:definition.hash,expectedStateHash:state.hash}]);
    const now = new Date().toISOString(), actor = `local-account:${source.alice}`;
    await f.database.batch([
      f.database.prepare("INSERT INTO recipe_families(id,name,template_type,created_by,created_at) VALUES(?,?,'process',?,?)")
        .bind(startFamily,"Synthetic media-free process source",actor,now),
      f.database.prepare("INSERT OR IGNORE INTO state_representations(hash,hash_scheme,representation_type,content_json,created_at) VALUES(?,?,?,?,?)")
        .bind(state.hash,String(state.canonical.schema),String(state.canonical.type),stableJson(state.canonical),now),
      f.database.prepare("INSERT OR IGNORE INTO step_definitions(hash,hash_scheme,name,tool_name,parameters_text,comments_text,canonical_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(definition.hash,STEP_HASH_SCHEME,definition.canonical.name,definition.canonical.toolName,definition.canonical.parametersText,definition.canonical.commentsText,stableJson(definition.canonical),now),
      f.database.prepare("INSERT INTO template_versions(id,recipe_family_id,name,template_type,template_kind,version,manifest_hash,initial_state_hash,content_json,created_by,created_at) VALUES(?,?,?,'process','process',1,?,?,?,?,?)")
        .bind(startTemplate,startFamily,"Synthetic media-free process source",manifest,state.hash,JSON.stringify({initialSubstrateStep:initial}),actor,now),
      f.database.prepare("INSERT INTO template_steps(id,template_version_id,logical_step_key,position,step_number,definition_hash,expected_state_hash,raw_json) VALUES(?,?,?,1000,'1',?,?,'{}')")
        .bind("candidate-media-free-process-step",startTemplate,key,definition.hash,state.hash),
      ...(asset ? [f.database.prepare("INSERT INTO state_representation_assets(state_hash,asset_id,position) VALUES(?,?,0)").bind(state.hash,String(asset.id))] : []),
    ]);
    expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.native.prepare("SELECT * FROM imports ORDER BY id").all()).toEqual(existingImports);
    expect(f.native.prepare("SELECT source_asset_key FROM template_versions WHERE id=?").get(startTemplate)).toEqual({source_asset_key:null});
    expect(f.native.prepare("SELECT count(*) n FROM collaboration_resources WHERE root_kind='template' AND root_id=?").get(startFamily)?.n).toBe(0);
  }); } catch (error) { workFailed = true; workFailure = error; }
  try { await f.close(); }
  catch (cleanup) {
    if (workFailed) throw new AggregateError([workFailure, cleanup], "Original stopped source work and first close both failed");
    throw cleanup;
  }
  if (workFailed) throw workFailure;
  // Every positive authority row comes from the genuine stopped operator.
  await executeDomainRootV28OperatorCandidate({kind:"allocate-existing-root",databasePath:path,filesystemRootOwnerUid:rootOwnerUid,
    principalId:source.alice,expectedMemberRevision:1,expectedControlRevision:2,rootKind:"template",rootId:startFamily,visibility:"restricted"});
  return path;
}

export async function sampleRecordLifecycleFixture(path: string) {
  let setup: Promise<unknown> | undefined, lease: LinuxWriterLease | undefined, native: DatabaseSync | undefined, core: SqliteCapability | undefined;
  let server: Server | undefined, reservation: Server | undefined, reservationClose: Promise<void> | undefined;
  let samplePermission: ReturnType<typeof createLocalSamplePermissionV28Candidate> | undefined;
  let detailPermission: ReturnType<typeof createLocalSampleDetailReadV28Candidate> | undefined;
  let recordPermission: ReturnType<typeof createLocalSampleRecordPermissionV28Candidate> | undefined;
  let removePermission: ReturnType<typeof createLocalSampleRecordRemovePermissionV28Candidate> | undefined;
  let commentPermission: ReturnType<typeof createLocalRunStepCommentPermissionV28Candidate> | undefined;
  let permission: ReturnType<typeof createLocalRunStartPreviewPermissionV28Candidate> | undefined, manager: ReturnType<typeof createLocalRootManagementV28Candidate> | undefined;
  let rawCloseAttempted = false, rawCloseFailed = false, rawCloseFailure: unknown;
  let nativeConstructionAttempted = false, nativeConstructionFailure: unknown;
  let clientAdmissionClosed = false;
  const pending = new Set<Promise<Response>>(), children = new Set<() => Promise<void>>();
  const responses = new Set<() => Promise<void>>(), observedResponses = new WeakSet<Response>();
  function retainResponse(response: Response): void {
    if (observedResponses.has(response)) return;
    observedResponses.add(response);
    const consumptions = new Set<Promise<unknown>>();
    let cleanup: Promise<void> | undefined;
    const responseClose = () => cleanup ??= (async () => {
      for (const original of consumptions) await original;
      if (!consumptions.size) {
        if (response.body?.locked) {
          const error = new Error("Original Run start/preview client response body ownership is uncertain");
          Object.defineProperty(error, "owner", { value: Object.freeze({ response, consumptions }) });
          throw error;
        }
        if (response.body) await response.body.cancel();
      }
      responses.delete(responseClose);
    })();
    responses.add(responseClose); // Strong exact Response owner BEFORE exposing any method.
    for (const name of ["arrayBuffer", "blob", "formData", "json", "text"] as const) {
      const method = response[name];
      Object.defineProperty(response, name, { configurable: true, writable: true,
        value: function(this: Response, ...args: unknown[]) {
          if (this !== response) return Reflect.apply(method, this, args);
          let original: Promise<unknown>;
          try { original = Reflect.apply(method, response, args) as Promise<unknown>; }
          catch (error) {
            original = Promise.reject(error); original.then(() => undefined, () => undefined);
            consumptions.add(original); throw error;
          }
          consumptions.add(original); original.then(() => undefined, () => undefined);
          return original;
        } });
    }
  }
  function clientFetch(url: string, input: RequestInit): Promise<Response> {
    if (clientAdmissionClosed) throw new Error("Original Run start/preview client admission is closed");
    let original: Promise<Response> | undefined, observation: Promise<void> | undefined, cleanup: Promise<void> | undefined;
    const requestClose = () => cleanup ??= (async () => {
      if (!original) throw new Error("Original Run start/preview client fetch ownership is unavailable");
      const delivered = await original;
      if (observation) await observation; else retainResponse(delivered);
      responses.delete(requestClose);
    })();
    responses.add(requestClose); // Exact request owner registered BEFORE actual fetch.
    try { original = fetch(url, input); } catch (error) { original = Promise.reject(error); }
    observation = original.then(retainResponse);
    observation.then(() => undefined, () => undefined);
    return original;
  }
  // Registered before listen/acquire/native/core/auth/owner construction. The
  // outer original() also retains the entire setup, case and later inspections.
  const close = retain(async () => {
    clientAdmissionClosed = true;
    if (setup) { try { await setup; } catch { /* Original setup outcome retained. */ } }
    if (reservationClose) await reservationClose;
    else if (reservation?.listening) {
      reservationClose = new Promise<void>((resolve, reject) => reservation!.close(error => error ? reject(error) : resolve())); await reservationClose;
    }
    for (const childOwner of children) await childOwner(); // Same parent FIRST ACK.
    if (server) await stopNodeHttpServerAndDrain(server);
    await Promise.allSettled([...pending]);
    for (const responseOwner of responses) await responseOwner(); // Cached original read/cancel ACK precedes Native release.
    if (lease) await lease.stopAdmissionAndDrain();
    permission?.discard(); manager?.discard(); detailPermission?.discard(); commentPermission?.discard(); recordPermission?.discard(); removePermission?.discard();
    if (nativeConstructionAttempted && !native) throw nativeConstructionFailure;
    if (core) core.close();
    else if (native) {
      if (!rawCloseAttempted) { rawCloseAttempted = true; try { native.close(); } catch (error) { rawCloseFailed = true; rawCloseFailure = error; } }
      if (rawCloseFailed) throw rawCloseFailure;
    }
    if (native?.isOpen) throw new Error("Original Run start/preview native close is unproven");
    if (lease) await lease.release();
  });
  const operation = (async () => {
    reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const address = reservation.address(); if (!address || typeof address === "string") throw new Error("Actual numeric listener required");
    const port = address.port, origin = `http://127.0.0.1:${port}`;
    reservationClose = new Promise<void>((resolve, reject) => reservation!.close(error => error ? reject(error) : resolve())); await reservationClose;
    lease = await acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid: rootOwnerUid });
    nativeConstructionAttempted = true;
    try { native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { nativeConstructionFailure = error; throw error; }
    core = createSqliteCapability(native); lease.bind(core, native);
    const nativeDatabase = native, database = core, writerLease = lease;

    const admission = admitInstallationRecoverySource(nativeDatabase, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);

    const transport = createLoopbackLocalAuthTransport({ publicOrigin: origin });

    const identity = await writerLease.withWriter(() => createInstalledLocalIdentity({ database, nativeDatabase, admission, hasher: createPasswordHasher(), policy }));

    const authentication = createLocalAuthentication({ identity, transport, now: Date.now });

    permission = createLocalRunStartPreviewPermissionV28Candidate({ database, nativeDatabase, admission, writerLease, authentication });
    samplePermission = createLocalSamplePermissionV28Candidate({database,nativeDatabase,admission,writerLease,authentication});
    detailPermission = createLocalSampleDetailReadV28Candidate({database,nativeDatabase,admission,writerLease,authentication});
    recordPermission = createLocalSampleRecordPermissionV28Candidate({database,nativeDatabase,admission,writerLease,authentication});
    removePermission = createLocalSampleRecordRemovePermissionV28Candidate({database,nativeDatabase,admission,writerLease,authentication});
    commentPermission = createLocalRunStepCommentPermissionV28Candidate({database,nativeDatabase,admission,writerLease,authentication});


    manager = createLocalRootManagementV28Candidate({ database, nativeDatabase, admission, writerLease, authentication });

    const selected = permission, sampleOwner = samplePermission, rootManager = manager, detail = detailPermission, comments = commentPermission, app = new Hono<LocalAuthEnvironment>();
    const record = recordPermission, remove = removePermission;
    let capturedRemove: {request:Request;token:SampleRecordRemovePermissionRequest} | undefined;
    let afterRemoveCapture: (()=>Promise<void>) | undefined;
    let capturedRecord: {request:Request;token:SampleRecordPermissionRequest} | undefined, recordBodyReads = 0;
    let afterRecordCapture: (()=>Promise<void>) | undefined, afterRecordBody: (()=>Promise<void>) | undefined;
    let capturedDetail: {request:Request;token:SampleDetailV28Request} | undefined;
    let afterDetailCapture: (()=>Promise<void>) | undefined;
    let captured: { request: Request; token: RunStartPreviewPermissionRequest } | undefined, bodyReads = 0;
    let afterCapture: (() => Promise<void>) | undefined, afterBody: (() => Promise<void>) | undefined;
    app.onError((error, c) => {
      const status = error instanceof HTTPException ? error.status : error instanceof LocalRequestSubjectError ? error.code === "authentication_required" ? 401 : 503
        : 503;
      return c.json({ error: error instanceof HTTPException ? error.message : "Run start/preview permission unavailable" }, status);
    });
    app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
    app.route("/api/auth", authentication.routes);
    const handle = async (request: Request, scope: RunStartPreviewPermissionScope) => {
      const token = await selected.capture(request, scope); captured = { request, token };
      if (afterCapture) await afterCapture();
      const input = async () => { bodyReads++; const value: unknown = await request.json(); if (afterBody) await afterBody(); return value; };
      const value = await selected.perform(request, token, input);
      return Response.json(value,{status:scope.operation === "start" ? 201 : 200});
    };
    app.post("/api/samples/:sample/runs/preview",c=>handle(c.req.raw,{sampleId:c.req.param("sample"),operation:"preview"}));
    app.post("/api/samples/:sample/runs",c=>handle(c.req.raw,{sampleId:c.req.param("sample"),operation:"start"}));
    app.post("/api/samples",async c=>{const request=c.req.raw,token=await sampleOwner.capture(request,{operation:"create"});
      return Response.json(await sampleOwner.create(request,token,await request.json()),{status:201});});
    app.post("/api/samples/:id/records", async c => {
      const request=c.req.raw,token=await record.capture(request,c.req.param("id"));capturedRecord={request,token};
      if(afterRecordCapture)await afterRecordCapture();
      return Response.json(await record.perform(request,token,async()=>{
        recordBodyReads++; const input:unknown=await request.json(); if(afterRecordBody)await afterRecordBody(); return input;
      }));
    });
    app.delete("/api/samples/:id/records/:event", async c => {
      const request=c.req.raw,token=await remove.capture(request,c.req.param("id"),c.req.param("event"));capturedRemove={request,token};
      if(afterRemoveCapture)await afterRemoveCapture();
      return Response.json(await remove.perform(request,token));
    });
    app.get("/api/samples/:id", async c => {
      const request=c.req.raw,token=await detail.capture(request);capturedDetail={request,token};
      if(afterDetailCapture)await afterDetailCapture();
      return Response.json(await detail.detail(request,token));
    });
    app.post("/api/run-step-comments",async c=>{const request=c.req.raw,token=await comments.capture(request);
      return Response.json(await comments.perform(request,token,()=>request.json()),{status:201});
    });
    const sharing = async (request: Request, scope: RootManagementScope) => {
      const token = await rootManager.capture(request, scope);
      return Response.json(await rootManager.change(request, token, await request.json() as RootManagementChange));
    };
    app.put("/api/collaboration/resources/sample/:id/visibility", c => sharing(c.req.raw, { root: { kind: "sample", id: c.req.param("id") }, operation: "visibility" }));
    app.put("/api/collaboration/resources/sample/:id/grants/:member", c => sharing(c.req.raw, { root: { kind: "sample", id: c.req.param("id") }, operation: "grant", memberId: c.req.param("member") }));
    app.put("/api/collaboration/resources/template/:id/visibility",c=>sharing(c.req.raw,{root:{kind:"template",id:c.req.param("id")},operation:"visibility"}));
    app.put("/api/collaboration/resources/template/:id/grants/:member",c=>sharing(c.req.raw,{root:{kind:"template",id:c.req.param("id")},operation:"grant",memberId:c.req.param("member")}));
    app.all("*", c => c.json({ error: "All other owners unavailable in this qualification fixture" }, 503));
    server = createNodeHttpServer(request => {
      const owned = writerLease.withWriter(() => Promise.resolve(app.fetch(request, {}))); pending.add(owned);
      return owned.finally(() => { pending.delete(owned); });
    }, { publicOrigin: origin, requestAdmission(request, incoming, actual) { transport.admit(request, incoming, actual); } });
    server.listen(port, "127.0.0.1"); await once(server, "listening");


    return { path, origin, native: nativeDatabase, database, lease: writerLease, authentication, admission, permission: selected, close,
      captured: () => captured, bodyReads: () => bodyReads,
      detail, capturedDetail: ()=>capturedDetail,
      record, capturedRecord: ()=>capturedRecord, recordBodyReads: ()=>recordBodyReads,
      remove, capturedRemove: ()=>capturedRemove,
      afterRemoveCapture(callback?:()=>Promise<void>){afterRemoveCapture=callback;},
      afterRecordCapture(callback?:()=>Promise<void>){afterRecordCapture=callback;},
      afterRecordBody(callback?:()=>Promise<void>){afterRecordBody=callback;},
      afterDetailCapture(callback?:()=>Promise<void>){afterDetailCapture=callback;},
      afterCapture(callback?: () => Promise<void>) { afterCapture = callback; }, afterBody(callback?: () => Promise<void>) { afterBody = callback; },
      async settled() { await Promise.allSettled([...pending]); },
      async request(route: string, method = "GET", body?: unknown, session?: RunStartPreviewSession, headers: Record<string, string> = {}, signal?: AbortSignal) {

        const response = await clientFetch(origin + route, { method, headers: { ...(session ? { cookie: session.cookie } : {}),
          ...(method === "GET" ? {} : { origin, "content-type": "application/json", ...(session ? { "x-sfw-csrf": session.csrf } : {}) }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(5000) });

        const text = await response.text();

        const media = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        return { status: response.status, headers: response.headers, text, value: text && media === "application/json" ? JSON.parse(text) as Record<string, unknown> : null };
      },
      async login(username: string): Promise<RunStartPreviewSession> {

        const response = await clientFetch(origin + "/api/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(5000) });
        const value = await response.json() as Record<string, unknown>; expect(response.status).toBe(200);

        expect(value).not.toHaveProperty("token"); expect(typeof value.csrf).toBe("string");
        const cookie = response.headers.get("set-cookie"); expect(cookie?.includes("HttpOnly")).toBe(true);
        return { cookie: cookie!.split(";")[0]!, csrf: value.csrf as string };
      },
      independent(sql: string, ...bindings: SQLInputValue[]) {
        let result: SpawnSyncReturns<string> | undefined, closing: Promise<void> | undefined;
        const acknowledge = () => { if (!result || result.error || result.status !== 0 || result.signal !== null) throw new Error("Original secondary native/process ACK unproven"); };
        const childOwner = () => closing ?? (closing = (async () => { acknowledge(); })());
        children.add(childOwner); // BEFORE actual secondary process/native construction.
        result = spawnSync(globalThis.process.execPath, ["--input-type=module", "-e", `
          import {DatabaseSync} from 'node:sqlite'; let db, workFailed=false, workError;
          try {
            try { db=new DatabaseSync(process.argv[1],{allowExtension:false,enableForeignKeyConstraints:true});db.exec('PRAGMA busy_timeout=20');
              const r=db.prepare(process.argv[2]).run(...JSON.parse(process.argv[3]));process.stdout.write(String(r.changes)); }
            catch(error){if(error?.errcode===5)process.stdout.write('busy');else throw error;}
          } catch(error){workFailed=true;workError=error;throw error;}
          finally{
            try{if(db)db.close();}
            catch(closeError){if(workFailed)throw new AggregateError([workError,closeError],'Original independent work and first native close failed');throw closeError;}
          }
        `, path, sql, JSON.stringify(bindings)], { encoding: "utf8", timeout: 3000 });
        acknowledge(); return String(result.stdout);
      },
      holdExpires(principal: string) {
        let process: ChildProcess | undefined, started: Promise<void> | undefined, ended: Promise<void> | undefined, closing: Promise<void> | undefined;
        const childOwner = () => closing ?? (closing = (async () => {
          let startFailed = false, startFailure: unknown;
          if (started) { try { await started; } catch (error) { startFailed = true; startFailure = error; } }
          let endFailed = false, endFailure: unknown;
          if (ended) { try { await ended; } catch (error) { endFailed = true; endFailure = error; } }
          if (startFailed && endFailed) throw new AggregateError([startFailure, endFailure], "Original expiry writer start and close remain unproven");
          if (startFailed) throw startFailure;
          if (endFailed) throw endFailure;
          if (!started || !ended) throw new Error("Original expiry writer construction and close are unproven");
        })()); children.add(childOwner); // Registered BEFORE spawn, holds the actual child.
        started = (async () => {
          process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", `
            import {DatabaseSync} from 'node:sqlite';let db, workFailed=false, workError;
            try { db=new DatabaseSync(process.argv[1],{allowExtension:false,enableForeignKeyConstraints:true});db.exec('PRAGMA busy_timeout=1000;BEGIN IMMEDIATE');
              if(db.prepare('UPDATE local_sessions SET absolute_expires_at=? WHERE principal_id=?').run(Date.now()+150,process.argv[2]).changes!==1)throw new Error('Exact current session missing');
              process.stdout.write('held\\n');await new Promise(resolve=>setTimeout(resolve,400));db.exec('COMMIT'); }
            catch(error){workFailed=true;workError=error;throw error;}
            finally{
              try{if(db)db.close();}
              catch(closeError){if(workFailed)throw new AggregateError([workError,closeError],'Original expiry writer work and first native close failed');throw closeError;}
            }
          `, path, principal], { stdio: ["ignore", "pipe", "pipe"] });
          const actual = process; let failed = false, failure: unknown;
          actual.on("error", error => { failed = true; failure = error; });
          ended = new Promise<void>((resolve, reject) => actual.once("close", (code, signal) => failed ? reject(failure)
            : code === 0 && signal === null ? resolve() : reject(new Error("Original expiry writer native/process close unproven"))));
          void ended.catch(() => undefined);
          await Promise.race([once(actual.stdout!, "data").then(([part]) => { expect(String(part)).toBe("held\n"); }), ended.then(() => { throw new Error("Expiry writer ended before held proof"); })]);
        })(); void started.catch(() => undefined); return { ready: started, close: childOwner };
      },
    };
  })(); setup = operation;
  try { return await operation; }
  catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Original Run start/preview setup and close remain unproven"); } throw error; }
}
export type SampleRecordLifecycleFixture = Awaited<ReturnType<typeof sampleRecordLifecycleFixture>>;

export function runRows(f: SampleRecordLifecycleFixture) {
  return { samples: f.native.prepare("SELECT * FROM samples ORDER BY id").all(),
    runs: f.native.prepare("SELECT * FROM runs ORDER BY id").all(),
    steps: f.native.prepare("SELECT * FROM run_steps ORDER BY run_id,position,id").all(),
    events: f.native.prepare("SELECT * FROM events ORDER BY id").all() };
}
export function authorities(f: SampleRecordLifecycleFixture) { return {
  resources: f.native.prepare("SELECT * FROM collaboration_resources ORDER BY root_kind,root_id").all(),
  grants: f.native.prepare("SELECT * FROM collaboration_grants ORDER BY root_kind,root_id,member_id").all() };
}

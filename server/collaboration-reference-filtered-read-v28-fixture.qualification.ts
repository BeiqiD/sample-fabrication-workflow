// SOURCE-ONLY genuine Reference metadata controls; no default application mount.
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import { observeOriginalReferenceNativeSql } from "./collaboration-reference-native-sql-trace.qualification";
import { writeSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ReferenceTarget } from "../shared/reference-types";
import { resolveReferencesReadOnly } from "../worker/references/read-resolver";
import { expect } from "vitest";
import { createInstalledLocalIdentity } from "./auth/identity";
import { createLocalAuthentication, type LocalAuthEnvironment } from "./auth/local-auth-http";
import { createLoopbackLocalAuthTransport } from "./auth/local-auth-transport";
import { LocalRequestSubjectError } from "./auth/local-request-subject";
import { createPasswordHasher } from "./auth/passwords";
import { createLocalReferenceReadV28Candidate, type ReferenceReadV28Request } from "./collaboration/local-reference-read-v28-candidate";
import { createLocalRootManagementV28Candidate, type RootManagementChange, type RootManagementScope } from "./collaboration/local-root-management-v28-candidate";
import { createNodeHttpServer, stopNodeHttpServerAndDrain } from "./http";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "./installation-catalog-v28-candidate";
import { admitInstallationRecoverySource } from "./migrations";
import { executeDomainRootV28OperatorCandidate } from "./operations/collaboration-domain-roots-v28-candidate";
import { acquireLinuxWriterLease, type LinuxWriterLease } from "./operations/writer-lease";
import { asProjectReadDatabase } from "./project-read-sql";
import { createSqliteCapability, type SqliteCapability } from "./sqlite";
import { assertLogicalSampleMembers, hashClosedLogicalDatabase, type LogicalSampleSource } from "./collaboration-sample-v28-logical-artifact.qualification";
import { nativeOwner, password, policy, privateCopy, retain, rootOwnerUid } from "./collaboration-sample-v28-logical-fixture.qualification";
export type ReferenceSession = { cookie: string; csrf: string };
export const referenceTargets: readonly ReferenceTarget[] = [
  {type:"sample",id:"reference-sample-a"},{type:"run",id:"reference-run-a"},{type:"run_step",id:"reference-step-a"},
  {type:"comment",id:"reference-comment"},{type:"comment_occurrence",id:"reference-comment-occurrence-a"},
  {type:"comment_attachment",id:"reference-comment-attachment"},{type:"execution_image",id:"reference-execution-image"},
  {type:"metrology_reference",id:"reference-metrology-reference"},{type:"recipe_revision",id:"reference-process-template"},
];
function timing(phase: string) {
  try { writeSync(2, `[Reference original phase] ${phase} ${performance.now().toFixed(3)}\n`); }
  catch { /* Passive fixed diagnostics never alter original owner outcomes. */ }
}
export async function preparedReferences(source: LogicalSampleSource) {
  const path=await privateCopy(source.databasePath);
  expect(await hashClosedLogicalDatabase(path)).toBe(source.databaseSha256);
  await assertLogicalSampleMembers(path,source);
  for(const rootId of ["reference-process-family","reference-metrology-family"])
    await executeDomainRootV28OperatorCandidate({kind:"allocate-existing-root",rootKind:"template",rootId,visibility:"restricted",
      databasePath:path,filesystemRootOwnerUid:rootOwnerUid,principalId:source.alice,expectedMemberRevision:1,expectedControlRevision:2});
  const owned=await nativeOwner(path); let workFailed=false,workFailure:unknown;
  try { await owned.lease.withWriter(async()=>{
    const resolutions=await resolveReferencesReadOnly(asProjectReadDatabase(owned.database),referenceTargets);
    expect(resolutions.every(value=>value.resolution==="resolved")).toBe(true);
    // Typed stopped metadata fixture only. Positive authority remains the
    // genuine closed producer and named stopped root allocations above.
    const now="2026-10-11T00:00:00.000Z";
    const statements=referenceTargets.map((target,index)=>owned.database.prepare(`INSERT INTO reference_targets
      (id,registry_version,target_type,target_id,first_registered_at,last_validated_at,last_known_contexts_json)
      VALUES(?,1,?,?,?,?,?)`).bind(`reference-private-registry-${index}`,target.type,target.id,now,now,JSON.stringify(resolutions[index]!.contexts)));
    expect((await owned.database.batch(statements)).length).toBe(statements.length);
    expect(owned.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }); } catch(error){workFailed=true;workFailure=error;throw error;}
  finally{try{await owned.close();}catch(cleanup){if(workFailed)throw new AggregateError([workFailure,cleanup],"Original Reference fixture preparation and first close failed");throw cleanup;}}
  return path;
}
export async function referenceFilteredReadFixture(path: string) {
  let setup: Promise<unknown> | undefined, lease: LinuxWriterLease | undefined, native: DatabaseSync | undefined, core: SqliteCapability | undefined;
  let server: Server | undefined, reservation: Server | undefined, reservationClose: Promise<void> | undefined;
  let reader: ReturnType<typeof createLocalReferenceReadV28Candidate> | undefined;
  let sqlTrace: ReturnType<typeof observeOriginalReferenceNativeSql> | undefined;
  let manager: ReturnType<typeof createLocalRootManagementV28Candidate> | undefined;
  let rawCloseAttempted = false, rawCloseFailed = false, rawCloseFailure: unknown;
  let nativeAttempted = false, nativeConstructionFailed = false, nativeConstructionFailure: unknown, sealed = false;
  const pending = new Set<Promise<Response>>(), children = new Set<() => Promise<void>>();
  // Registered before listen/acquire/native/core/auth/owner construction. The
  // outer original() also retains the entire setup, case and later inspections.
  const close = retain(async () => {
    if (setup) { try { await setup; } catch { /* Original setup outcome retained. */ } }
    sealed = true;
    if (reservationClose) await reservationClose;
    else if (reservation?.listening) {
      reservationClose = new Promise<void>((resolve, reject) => reservation!.close(error => error ? reject(error) : resolve())); await reservationClose;
    }
    for (const childOwner of children) await childOwner(); // Same parent FIRST ACK.
    if (server) await stopNodeHttpServerAndDrain(server);
    await Promise.allSettled([...pending]);
    if (lease) await lease.stopAdmissionAndDrain();
    if (nativeAttempted && !native) {
      if (nativeConstructionFailed) throw nativeConstructionFailure;
      throw new Error("Original Reference native constructor custody is unproven");
    }
    reader?.discard(); manager?.discard();
    if (core) core.close();
    else if (native) {
      if (!rawCloseAttempted) { rawCloseAttempted = true; try { native.close(); } catch (error) { rawCloseFailed = true; rawCloseFailure = error; } }
      if (rawCloseFailed) throw rawCloseFailure;
    }
    if (native?.isOpen) throw new Error("Original Reference native close is unproven");
    if (lease) await lease.release();
  });
  const operation = (async () => {
    reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const address = reservation.address(); if (!address || typeof address === "string") throw new Error("Actual numeric listener required");
    const port = address.port, origin = `http://127.0.0.1:${port}`;
    reservationClose = new Promise<void>((resolve, reject) => reservation!.close(error => error ? reject(error) : resolve())); await reservationClose;
    lease = await acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid: rootOwnerUid });
    nativeAttempted = true;
    try { native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { nativeConstructionFailed = true; nativeConstructionFailure = error; throw error; }
    core = createSqliteCapability(native); lease.bind(core, native);
    const nativeDatabase = native, database = core, writerLease = lease;
    timing("fixture:installation-admission:start");
    const admission = admitInstallationRecoverySource(nativeDatabase, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
    timing("fixture:installation-admission:end");
    const transport = createLoopbackLocalAuthTransport({ publicOrigin: origin });
    timing("fixture:installed-identity:start");
    const identity = await writerLease.withWriter(() => createInstalledLocalIdentity({ database, nativeDatabase, admission, hasher: createPasswordHasher(), policy }));
    timing("fixture:installed-identity:end");
    const authentication = createLocalAuthentication({ identity, transport, now: Date.now });
    timing("fixture:root-owner:start");
    manager = createLocalRootManagementV28Candidate({ database, nativeDatabase, admission, writerLease, authentication });
    timing("fixture:root-owner:end");
    reader = createLocalReferenceReadV28Candidate({ database, nativeDatabase, admission, writerLease, authentication });
    const readOwner = reader; let capturedRead: { request: Request; token: ReferenceReadV28Request } | undefined, bodyReads = 0;
    const rootManager = manager, app = new Hono<LocalAuthEnvironment>();
    let afterCapture: (() => Promise<void>) | undefined, afterResult: ((value: unknown) => Promise<void>) | undefined;
    app.onError((error, c) => {
      const status = error instanceof HTTPException ? error.status : error instanceof LocalRequestSubjectError ? error.code === "authentication_required" ? 401 : 503
        : 503;
      return c.json({ error: error instanceof HTTPException ? error.message : "Reference permission unavailable" }, status);
    });
    app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
    app.route("/api/auth", authentication.routes);
    const handle = async (request: Request) => {
      sqlTrace?.phase(0);
      const json = request.json;
      Object.defineProperty(request, "json", { configurable: true, value: function(this: Request, ...args: []) {
        if (this === request) bodyReads++;
        return Reflect.apply(json, this, args) as ReturnType<Request["json"]>;
      } }); // Same original parser/this/args/Promise; no extra body read.
      sqlTrace?.phase(1);
      const token = await readOwner.capture(request); capturedRead = { request, token };
      sqlTrace?.phase(2);
      if (afterCapture) await afterCapture();
      sqlTrace?.phase(3);
      const value = await readOwner.perform(request, token);
      sqlTrace?.phase(4);
      if (afterResult) await afterResult(value);
      const response = Response.json(value); sqlTrace?.phase(5); return response;
    };
    for (const operation of ["resolve", "children", "search"] as const)
      app.post(`/api/references/${operation}`, c => handle(c.req.raw));
    const sharing = async (request: Request, scope: RootManagementScope) => {
      const token = await rootManager.capture(request, scope);
      return Response.json(await rootManager.change(request, token, await request.json() as RootManagementChange));
    };
    // Genuine existing root managers, only to share actual source roots.
    for (const kind of ["sample", "template"] as const)
      app.put(`/api/collaboration/resources/${kind}/:id/grants/:member`, c => sharing(c.req.raw, {
        root: { kind, id: c.req.param("id") }, operation: "grant", memberId: c.req.param("member") }));
    app.all("*", c => c.json({ error: "All other owners unavailable in this qualification fixture" }, 503));
    server = createNodeHttpServer(request => {
      const owned = writerLease.withWriter(() => Promise.resolve(app.fetch(request, {}))); pending.add(owned);
      return owned.finally(() => { pending.delete(owned); });
    }, { publicOrigin: origin, requestAdmission(request, incoming, actual) { transport.admit(request, incoming, actual); } });
    server.listen(port, "127.0.0.1"); await once(server, "listening");
    timing("fixture:listener-ready");
    const observedResponses = new WeakSet<Response>();
    function retainResponse(response: Response): void {
      if (observedResponses.has(response)) return;
      observedResponses.add(response);
      const consumptions = new Set<Promise<unknown>>();
      let cleanup: Promise<void> | undefined;
      const responseClose = () => cleanup ??= (async () => {
        for (const original of consumptions) await original;
        if (!consumptions.size) {
          if (response.body?.locked) {
            const error = new Error("Original Reference client response body ownership is uncertain");
            Object.defineProperty(error, "owner", { value: Object.freeze({ response, consumptions }) });
            throw error;
          }
          if (response.body) await response.body.cancel();
        }
        children.delete(responseClose);
      })();
      children.add(responseClose);
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
    const originalFetch = (url: string, input: RequestInit): Promise<Response> => {
      if (sealed) throw new Error("Original Reference client request admission is closed");
      let original: Promise<Response> | undefined, observation: Promise<void> | undefined, cleanup: Promise<void> | undefined;
      const requestClose = () => cleanup ??= (async () => {
        if (!original) throw new Error("Original Reference client fetch ownership is unavailable");
        const delivered = await original;
        if (observation) await observation; else retainResponse(delivered);
        children.delete(requestClose);
      })();
      children.add(requestClose);
      try { original = fetch(url, input); }
      catch (error) { original = Promise.reject(error); }
      observation = original.then(retainResponse);
      observation.then(() => undefined, () => undefined);
      return original;
    };
    let requestSequence = 0;
    return { path, origin, native: nativeDatabase, database, lease: writerLease, authentication, admission, close,
      reader: readOwner, capturedRead: () => capturedRead, bodyReads: () => bodyReads,
      beginNativeSqlTrace() {
        sqlTrace ??= observeOriginalReferenceNativeSql(nativeDatabase);
        return sqlTrace.stop;
      },
      afterCapture(callback?: () => Promise<void>) { afterCapture = callback; }, afterResult(callback?: (value: unknown) => Promise<void>) { afterResult = callback; },
      async settled() { await Promise.allSettled([...pending]); },
      async request(route: string, method = "GET", body?: unknown, session?: ReferenceSession, headers: Record<string, string> = {}, signal?: AbortSignal) {
        const sequence = ++requestSequence; timing(`client:${sequence}:fetch:start`);
        const response = await originalFetch(origin + route, { method, headers: { ...(session ? { cookie: session.cookie } : {}),
          ...(method === "GET" ? {} : { origin, "content-type": "application/json", ...(session ? { "x-sfw-csrf": session.csrf } : {}) }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(5000) });
        timing(`client:${sequence}:headers:end`);
        const text = await response.text();
        timing(`client:${sequence}:body:end`);
        return { status: response.status, headers: response.headers, text, value: text ? JSON.parse(text) as Record<string, unknown> : null };
      },
      async login(username: string): Promise<ReferenceSession> {
        timing("client:login:start");
        const response = await originalFetch(origin + "/api/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(5000) });
        const value = await response.json() as Record<string, unknown>; expect(response.status).toBe(200);
        timing("client:login:body:end");
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
          import {DatabaseSync} from 'node:sqlite'; let db,workFailed=false,workFailure;
          try { db=new DatabaseSync(process.argv[1],{allowExtension:false,enableForeignKeyConstraints:true});db.exec('PRAGMA busy_timeout=20');
            const r=db.prepare(process.argv[2]).run(...JSON.parse(process.argv[3]));process.stdout.write(String(r.changes)); }
          catch(error){if(error?.errcode===5)process.stdout.write('busy');else{workFailed=true;workFailure=error;throw error;}}
          finally{if(db)try{db.close();}catch(cleanup){if(workFailed)throw new AggregateError([workFailure,cleanup],'Original secondary work and first close failed');throw cleanup;}}
        `, path, sql, JSON.stringify(bindings)], { encoding: "utf8", timeout: 3000 });
        acknowledge(); return String(result.stdout);
      },
      holdExpires(principal: string) {
        let process: ChildProcess | undefined, started: Promise<void> | undefined, ended: Promise<void> | undefined, closing: Promise<void> | undefined;
        const childOwner = () => closing ?? (closing = (async () => {
          if (started) { try { await started; } catch { /* Original launch failure remains retained. */ } }
          if (ended) await ended;
        })()); children.add(childOwner); // Registered BEFORE spawn, holds the actual child.
        started = (async () => {
          process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", `
            import {DatabaseSync} from 'node:sqlite';let db,workFailed=false,workFailure;
            try { db=new DatabaseSync(process.argv[1],{allowExtension:false,enableForeignKeyConstraints:true});db.exec('PRAGMA busy_timeout=1000;BEGIN IMMEDIATE');
              if(db.prepare('UPDATE local_sessions SET absolute_expires_at=? WHERE principal_id=?').run(Date.now()+150,process.argv[2]).changes!==1)throw new Error('Exact current session missing');
              process.stdout.write('held\\n');await new Promise(resolve=>setTimeout(resolve,400));db.exec('COMMIT'); }
            catch(error){workFailed=true;workFailure=error;throw error;}
            finally{if(db)try{db.close();}catch(cleanup){if(workFailed)throw new AggregateError([workFailure,cleanup],'Original expiry work and first close failed');throw cleanup;}}
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
  catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Original Reference setup and close remain unproven"); } throw error; }
}
export type ReferenceFixture = Awaited<ReturnType<typeof referenceFilteredReadFixture>>;

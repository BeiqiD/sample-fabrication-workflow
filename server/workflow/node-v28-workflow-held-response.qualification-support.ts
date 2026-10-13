import { afterEach, expect } from "vitest";
import { readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { launchWorkflowCli, closeWorkflowCli, type WorkflowCliOwner, type ClosedWorkflowCli } from "./node-v28-workflow-cli.qualification-support.ts";

// Qualification-only preloader. Every selected native read really runs. The
// wrapper withholds only its positively settled ACK, never its bytes/result.
// Main/auth/core/provider factories and all production clocks are unchanged.
const PRELOAD = String.raw`
import { constants, lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const configPath = process.env.CURRENT_V28_WORKFLOW_HELD_READ_CONFIG;
if (!configPath || resolve(configPath) !== configPath || realpathSync(configPath) !== configPath) throw new Error('Actual held-read configuration is unavailable');
const uid = BigInt(process.geteuid());
function privateFile(path) { const stat=lstatSync(path,{bigint:true}); if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid||stat.nlink!==1n||(stat.mode&0o7777n)!==0o600n) throw new Error('Private qualification file is unavailable'); }
privateFile(configPath); const config=JSON.parse(readFileSync(configPath,'utf8'));
const root=config.root, stat=lstatSync(root,{bigint:true});
if(config.schema!=='actual-workflow-held-provider-read/1'||resolve(root)!==root||realpathSync(root)!==root||!stat.isDirectory()||stat.uid!==uid||(stat.mode&0o7777n)!==0o700n) throw new Error('Actual held-read root is unavailable');
const marker=name=>join(root,name+'.json');
function record(name,value){
  const path=marker(name),pending=path+'.pending';
  try{lstatSync(path);throw new Error('Original qualification marker already exists');}catch(error){if(!error||error.code!=='ENOENT')throw error;}
  writeFileSync(pending,JSON.stringify({...value,pid:process.pid,observedAt:Date.now()})+'\n',{flag:'wx',mode:0o600});renameSync(pending,path);
}
const originalOpen=fsPromises.open;
const probe=await originalOpen(config.probePath,constants.O_RDONLY|constants.O_NOFOLLOW);
const prototype=Object.getPrototypeOf(probe), originalRead=prototype.read;
await probe.close(); if(typeof originalRead!=='function') throw new Error('Actual FileHandle read is unavailable');
let selected=0,held=false,released=false,selectedHandle;
fsPromises.open=function(...args){
  const original=originalOpen.apply(this,args);
  void original.then(handle=>{
    let arm;try{privateFile(config.armPath);arm=JSON.parse(readFileSync(config.armPath,'utf8'));}catch(error){if(error&&error.code==='ENOENT')return;throw error;}
    if(args[0]!==arm.dataPath||selectedHandle)return;
    // Install before the production owner's first close-method capture. Both
    // open and close return their exact original promises/objects/results.
    selectedHandle=handle;const originalClose=handle.close,fd=handle.fd,path=arm.dataPath;let providerCloseCalls=0;
    if(typeof originalClose!=='function')throw new Error('Actual provider close is unavailable');
    handle.close=function(...closeArgs){
      providerCloseCalls++;const ordinal=providerCloseCalls, closeOriginal=originalClose.apply(this,closeArgs);
      void Promise.resolve(closeOriginal).then(()=>{
        record(ordinal===1?'provider-closed':'provider-close-repeat-'+ordinal,{dataPath:path,fd,originalProviderCloseAcknowledged:true,providerCloseCalls:ordinal});
      },()=>{record('provider-close-failed',{dataPath:path,fd,originalProviderCloseAcknowledged:false});});
      return closeOriginal;
    };
  },()=>{});
  return original;
};
syncBuiltinESMExports();
prototype.read=function(...args){
  let arm;try{privateFile(config.armPath);arm=JSON.parse(readFileSync(config.armPath,'utf8'));}catch(error){if(error&&error.code==='ENOENT')return originalRead.apply(this,args);throw error;}
  const fd=this.fd;let path;try{path=readlinkSync('/proc/self/fd/'+fd);}catch{return originalRead.apply(this,args);}
  if(released||path!==arm.dataPath||args[3]!==null)return originalRead.apply(this,args);
  privateFile(path); if(realpathSync(path)!==path||!Number.isSafeInteger(arm.holdRead)||arm.holdRead<1)throw new Error('Actual held-read arm is unavailable');
  if(this!==selectedHandle)throw new Error('Original selected provider handle is unavailable');
  selected++; const ordinal=selected, original=originalRead.apply(this,args);
  if(held||ordinal!==arm.holdRead)return original;
  held=true;return Promise.resolve(original).then(async result=>{
    record('reached',{dataPath:path,fd,ordinal,bytesRead:result.bytesRead,originalReadSettled:true});
    while(true){try{privateFile(config.releasePath);const release=JSON.parse(readFileSync(config.releasePath,'utf8'));if(release.schema!=='release-actual-provider-read/1')throw new Error('Actual release is unavailable');break;}catch(error){if(!error||error.code!=='ENOENT')throw error;}await delay(10);}
    released=true; prototype.read=originalRead;fsPromises.open=originalOpen;syncBuiltinESMExports();
    record('released',{dataPath:path,fd,ordinal,bytesRead:result.bytesRead,originalResultReturnedUnchanged:true,readRestored:true,openRestored:true});
    return result;
  });
};
const originalServerClose=Server.prototype.close;
Server.prototype.close=function(...args){
  const address=this.address();const result=originalServerClose.apply(this,args);
  if(address&&typeof address!=='string'&&address.port===new URL(config.origin).port*1){
    record('stopped',{actualServerCloseInvoked:true,listeningAfter:this.listening,address});Server.prototype.close=originalServerClose;
  }
  return result;
};
const originalNativeClose=DatabaseSync.prototype.close;
DatabaseSync.prototype.close=function(...args){
  const result=originalNativeClose.apply(this,args);
  record('native-closed',{actualNativeCloseAcknowledged:true,isOpenAfter:this.isOpen});DatabaseSync.prototype.close=originalNativeClose;
  return result;
};
record('preload-ready',{actualReadPrototype:true,originalProbeCloseAcknowledged:true,noClockOverride:true});
`;

interface HoldOwner {
  readonly root: string; readonly armPath: string; readonly releasePath: string;
  workflow?: WorkflowCliOwner; arm?: Promise<void>; release?: Promise<void>; finish?: Promise<ClosedWorkflowCli>;
  startupObservation?: Promise<void>;
  failed: boolean; failure?: unknown;
}
export interface HeldReadProof {
  readonly pid: number; readonly observedAt: number; readonly dataPath: string; readonly fd: number;
  readonly ordinal: number; readonly bytesRead: number; readonly originalReadSettled: true;
}
export interface HeldWorkflowCli {
  readonly workflow: WorkflowCliOwner;
  arm(dataPath: string, holdRead: number): Promise<void>;
  reached(): Promise<HeldReadProof>;
  stopAndObserve(): Promise<Readonly<Record<string, unknown>>>;
  release(): Promise<Readonly<Record<string, unknown>>>;
  hasNativeClosed(): Promise<boolean>;
  finish(): Promise<ClosedWorkflowCli>;
  nativeCloseProof(): Promise<Readonly<Record<string, unknown>>>;
  providerCloseProof(): Promise<Readonly<Record<string, unknown>>>;
}
const owners = new Set<HoldOwner>();
function ensure(value: unknown): asserts value { if (!value) throw new Error("Actual held Workflow CLI ownership is unavailable"); }
function object(value: unknown): Record<string, unknown> { ensure(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function remember(owner: HoldOwner, error: unknown): void { if (!owner.failed) { owner.failed = true; owner.failure = error; } }
async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
}
async function publishControl(path: string, value: unknown): Promise<void> {
  ensure(!await exists(path));
  const pending = path + ".pending"; await writeFile(pending, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(pending, path);
}
async function marker(owner: HoldOwner, name: string, maximumMs = 10_000): Promise<Readonly<Record<string, unknown>>> {
  const path = join(owner.root, name + ".json"), deadline = performance.now() + maximumMs;
  for (;;) {
    if (await exists(path)) {
      const value = object(JSON.parse(await readFile(path, "utf8")));
      ensure(value.pid === owner.workflow?.child?.pid && typeof value.observedAt === "number"); return value;
    }
    ensure(!owner.workflow?.ended && performance.now() < deadline); await delay(10);
  }
}
afterEach(() => {
  if (owners.size) throw new AggregateError([...owners].map(owner => owner.failed ? owner.failure : owner.finish
    ?? owner.workflow?.originalClose ?? new Error("Original held CLI construction is unproven")), "Original held Workflow CLI owners remain retained");
});

/** Reuses the original privately retained CLI/process/client helper. The
 * Node preloader is test-owned and selected only for this synchronous spawn;
 * no runtime/profile/config/authority API is widened or substituted. */
export async function launchHeldWorkflowCli(options: {
  distribution: string; configurationPath: string; rootUid: number; root: string; origin: string;
}): Promise<HeldWorkflowCli> {
  const { distribution, configurationPath, rootUid, root, origin } = options;
  ensure(isAbsolute(root) && resolve(root) === root && await realpath(root) === root);
  const owner: HoldOwner = { root, armPath: join(root, "held-read-arm.json"), releasePath: join(root, "held-read-release.json"), failed: false };
  owners.add(owner);
  try {
    const script = join(root, "held-read-preload.mjs"), probe = join(root, "held-read-probe"), config = join(root, "held-read-config.json");
    await writeFile(probe, "original Native probe only\n", { flag: "wx", mode: 0o600 });
    await writeFile(script, PRELOAD, { flag: "wx", mode: 0o600 });
    await writeFile(config, JSON.stringify({ schema: "actual-workflow-held-provider-read/1", root, origin, probePath: probe,
      armPath: owner.armPath, releasePath: owner.releasePath }), { flag: "wx", mode: 0o600 });
    const previousOptions = process.env.NODE_OPTIONS, previousConfig = process.env.CURRENT_V28_WORKFLOW_HELD_READ_CONFIG;
    try {
      process.env.NODE_OPTIONS = (previousOptions ? previousOptions + " " : "") + "--import=" + pathToFileURL(script).href;
      process.env.CURRENT_V28_WORKFLOW_HELD_READ_CONFIG = config;
      owner.workflow = launchWorkflowCli(distribution, configurationPath, rootUid);
    } finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
      if (previousConfig === undefined) delete process.env.CURRENT_V28_WORKFLOW_HELD_READ_CONFIG; else process.env.CURRENT_V28_WORKFLOW_HELD_READ_CONFIG = previousConfig;
    }
    const workflow = owner.workflow; ensure(workflow); await workflow.ready;
    expect(await marker(owner, "preload-ready")).toMatchObject({ actualReadPrototype: true, originalProbeCloseAcknowledged: true, noClockOverride: true });
    function arm(dataPath: string, holdRead: number): Promise<void> {
      if (owner.arm) return owner.arm;
      ensure(isAbsolute(dataPath) && resolve(dataPath) === dataPath && Number.isSafeInteger(holdRead) && holdRead > 0);
      owner.arm = publishControl(owner.armPath, { dataPath, holdRead });
      void owner.arm.catch(error => remember(owner, error)); return owner.arm;
    }
    function releaseFile(): Promise<void> {
      owner.release ??= publishControl(owner.releasePath, { schema: "release-actual-provider-read/1" });
      void owner.release.catch(error => remember(owner, error)); return owner.release;
    }
    async function release(): Promise<Readonly<Record<string, unknown>>> {
      await releaseFile(); return marker(owner, "released");
    }
    function finish(): Promise<ClosedWorkflowCli> {
      if (owner.finish) return owner.finish;
      owner.finish = Promise.resolve().then(async () => {
        // Cleanup can start before the selected read was reached. Release the
        // test-owned gate once without inventing a provider ACK in that case.
        await releaseFile();
        if (!workflow.ended && !workflow.stopSent) {
          ensure(workflow.child && workflow.child.kill("SIGTERM")); workflow.stopSent = true;
        }
        ensure(workflow.originalClose);
        // Original close must settle before the unchanged helper is asked to
        // sweep clients. It then observes the already-sent real SIGTERM once.
        await workflow.originalClose;
        const closed = await closeWorkflowCli(workflow);
        expect(closed.code).toBe(0); expect(closed.signal).toBeNull(); expect(closed.stderr).toBe("");
        if (owner.failed) throw owner.failure;
        owners.delete(owner); return closed;
      }).catch(error => { remember(owner, error); throw error; });
      void owner.finish.catch(() => undefined); return owner.finish;
    }
    return Object.freeze({ workflow, arm,
      async reached() {
        const value = await marker(owner, "reached", 150_000);
        ensure(typeof value.dataPath === "string" && typeof value.fd === "number" && typeof value.ordinal === "number"
          && typeof value.bytesRead === "number" && value.originalReadSettled === true); return value as unknown as HeldReadProof;
      },
      async stopAndObserve() {
        ensure(!workflow.ended && !workflow.stopSent && workflow.child);
        ensure(workflow.child.kill("SIGTERM")); workflow.stopSent = true;
        const stopped = await marker(owner, "stopped"); expect(stopped).toMatchObject({ actualServerCloseInvoked: true, listeningAfter: false }); return stopped;
      }, release,
      hasNativeClosed: () => exists(join(root, "native-closed.json")), finish,
      nativeCloseProof: () => marker(owner, "native-closed"),
      async providerCloseProof() {
        const proof = await marker(owner, "provider-closed");
        ensure(!(await readdir(root)).some(name => name === "provider-close-failed.json" || name.startsWith("provider-close-repeat-")));
        return proof;
      },
    });
  } catch (error) {
    remember(owner, error);
    // Startup rejection previously discarded the already closed original
    // child's fixed diagnostics. Preserve them privately before propagating
    // the same failure; this observation neither cleans up nor admits work.
    owner.startupObservation ??= Promise.resolve().then(async () => {
      const workflow = owner.workflow;
      if (workflow?.ended && workflow.originalClose) {
        const closed = await workflow.originalClose;
        await publishControl(join(root, "held-read-startup-original-child.json"), {
          schema: "actual-held-workflow-startup-original-child/1", originalChildCloseAcknowledged: true,
          pid: workflow.child?.pid ?? null, stopSent: workflow.stopSent,
          code: closed.code, signal: closed.signal, stdout: closed.stdout, stderr: closed.stderr,
          applicationCloseAcknowledged: false, qualificationPassed: false,
        });
      } else {
        await publishControl(join(root, "held-read-startup-original-child.json"), {
          schema: "actual-held-workflow-startup-original-child/1", originalChildCloseAcknowledged: false,
          pid: workflow?.child?.pid ?? null, stopSent: workflow?.stopSent ?? false,
          applicationCloseAcknowledged: false, qualificationPassed: false,
        });
      }
    });
    void owner.startupObservation.catch(() => undefined);
    try { await owner.startupObservation; }
    catch (observation) { throw new AggregateError([error, observation], "Original held Workflow startup and private child observation failed"); }
    throw error;
  }
}

/** Read-only selection of an actual immutable private archive, never a seeded
 * object or provider-result substitute. Caller supplies its real accepted job. */
export async function actualRecoveryArchiveData(artifactRoot: string, jobId: string, expected: { byteSize: number; sha256: string }): Promise<string> {
  const matches: string[] = [];
  for (const directory of await readdir(join(artifactRoot, "objects"))) {
    if (!/^[a-f0-9]{64}$/.test(directory)) continue;
    const path = join(artifactRoot, "objects", directory), metadata = object(JSON.parse(await readFile(join(path, "metadata.json"), "utf8")));
    if (metadata.format === "local-byte-object-v1" && typeof metadata.key === "string" && metadata.key.startsWith("fp5-system/" + jobId + "/")) {
      expect(metadata.byteSize).toBe(expected.byteSize); expect(metadata.sha256).toBe(expected.sha256);
      matches.push(join(path, "data"));
    }
  }
  ensure(matches.length === 1); ensure(await realpath(matches[0]!) === matches[0]); return matches[0]!;
}

/** A new independent real socket after listener-stop. Connection refusal is
 * an expected negative result; only its original ClientRequest close event
 * releases this probe. It cannot enter an old delivered body's context. */
export function rejectedWorkflowHttpAfterStop(origin: string, session: { cookie: string; csrf: string }): Promise<Readonly<Record<string, unknown>>> {
  const parsed = new URL(origin); ensure(parsed.protocol === "http:" && parsed.origin === origin && ["127.0.0.1", "[::1]"].includes(parsed.hostname));
  const requestId = randomUUID(), bytes = Buffer.from(JSON.stringify({ requestId, byteSize: 1, sha256: "0".repeat(64) }));
  return new Promise((done, fail) => {
    let status: number | undefined, ended = false, failed = false, failure: unknown, code: unknown;
    const original = httpRequest(origin + "/api/system-recovery/uploads", { method: "POST", agent: false,
      signal: AbortSignal.timeout(5000), headers: { cookie: session.cookie, origin, "x-sfw-csrf": session.csrf,
        "content-type": "application/json", "content-length": String(bytes.byteLength), connection: "close" } }, response => {
      status = response.statusCode; response.resume(); response.once("end", () => { ended = true; });
      response.once("error", error => { failed = true; failure = error; });
    });
    original.once("error", error => { code = (error as NodeJS.ErrnoException).code; if (!["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(String(code))) { failed = true; failure = error; } });
    original.once("close", () => {
      if (failed) { fail(failure); return; }
      if (!(status === 503 && ended || status === undefined && ["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(String(code)))) {
        fail(new Error("New Workflow HTTP admission was accepted or its original close is unproven")); return;
      }
      done(Object.freeze({ requestId, newIndependentSocket: true, status: status ?? null, errorCode: code ?? null, originalRequestCloseAcknowledged: true, accepted: false }));
    });
    original.end(bytes);
  });
}

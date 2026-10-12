import { createNodeDevelopmentPrototype } from "../node-application";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInstalledLocalIdentity, type IdentityPolicy } from "../auth/identity";
import { createPasswordHasher } from "../auth/passwords";
import { stopNodeHttpServerAndDrain } from "../http";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate";
import { admitInstallationRecoverySource, installReviewedSqliteCatalog } from "../migrations";
import { createSqliteCapability, type SqliteCapability } from "../sqlite";
import { acquireLinuxWriterLease, type LinuxWriterLease } from "../operations/writer-lease";
import { executeV28OrdinaryAccountOperatorCandidate } from "../operations/ordinary-account-v28-candidate";
import { executeCollaborationV28OperatorCandidate } from "../operations/collaboration-v28-operator-candidate";

import { createGroupV28ApplicationCandidate, type GroupV28ApplicationCandidate } from "./group-v28-application-candidate";
import { executeDomainRootV28OperatorCandidate } from "../operations/collaboration-domain-roots-v28-candidate";

const PASSWORD = "Synthetic current V28 composed permission qualification secret";
const POLICY: IdentityPolicy = { absoluteLifetimeMs: 120_000, idleLifetimeMs: 30_000,
  loginWindowMs: 1000, loginAttempts: 5, throttleBuckets: 100 };
const ORIGINAL_RESERVE = 512n * 1024n * 1024n;
let parent: string, rootOwnerUid: number;
interface ClientOwner {
  originalFetch: Promise<Response>; response?: Response; consumption?: Promise<unknown>;
  cancellation?: Promise<void>; firstCleanup?: Promise<void>;
}
interface CaseOwner { original?: Promise<void>; failed: boolean; failure?: unknown }
const cases = new Set<CaseOwner>();
type OriginalOwnedApplication = Pick<GroupV28ApplicationCandidate,"server"|"close">;
interface Owner {
  lease?: LinuxWriterLease; native?: DatabaseSync; core?: SqliteCapability; nativeConstructionStarted?: true;
  clients: Set<ClientOwner>;
  applicationAttempted?: true; originalApplication?: Promise<OriginalOwnedApplication>; application?: OriginalOwnedApplication;
  server?: Server; probe?: Server; probeClose?: Promise<void>; close?: Promise<void>;
  failure?: unknown; quarantined: boolean;
}
const owners = new Set<Owner>();
function guard() {
  for (const path of [parent, tmpdir()]) {
    const space = statfsSync(path, { bigint: true });
    if (space.bavail * space.bsize < ORIGINAL_RESERVE) throw new Error("Original dual 512 MiB fixture reserve is unavailable");
  }
}
beforeAll(() => {
  const directory = process.env.CURRENT_V28_SAMPLE_NONEMPTY_FIXTURE_PARENT;
  const pin = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID;
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory
    || !pin || !/^(?:0|[1-9][0-9]*)$/.test(pin) || !Number.isSafeInteger(Number(pin))
    || Number(pin) > 0xffff_ffff) throw new Error("Configure explicit current V28 composer qualification inputs");
  parent = directory; rootOwnerUid = Number(pin); guard();
});
afterEach(() => {
  // An uncertain original cleanup is retained for the controller. Never retry it
  // in a hook or infer a successful ACK from a closed-looking native object.
  if (owners.size || cases.size) throw new AggregateError([
    ...[...owners].map(owner => owner.failure), ...[...cases].map(owner => owner.failed ? owner.failure : owner.original),
  ], "Original current V28 case or fixture ownership remains unproven");
  guard();
});
function retainedCase(work: () => Promise<void>): Promise<void> {
  // Reserve the full original case before its first filesystem/fixture await.
  // Late setup and the gaps between stopped operations remain visible after a
  // test timeout. A failed case retains its exact original result and cause.
  const owner: CaseOwner = { failed: false }; cases.add(owner);
  const original = owner.original = Promise.resolve().then(work);
  original.then(() => cases.delete(owner), error => { owner.failed = true; owner.failure = error; });
  return original;
}
async function fetchClient(owner: Owner, url: string, options: RequestInit): Promise<{ client: ClientOwner; response: Response }> {
  let originalFetch: Promise<Response>;
  try { originalFetch = fetch(url, options); } catch (error) { originalFetch = Promise.reject(error); }
  const client: ClientOwner = { originalFetch }; owner.clients.add(client);
  originalFetch.then(response => { client.response = response; }, () => undefined);
  const response = await originalFetch; return { client, response };
}
function consumeClient(client: ClientOwner, method: "json" | "text" | "arrayBuffer"): Promise<unknown> {
  if (client.consumption) throw new Error("The original client body was already selected");
  if (!client.response) throw new Error("The original client response was not delivered");
  let original: Promise<unknown>;
  try { original = client.response[method](); } catch (error) { original = Promise.reject(error); }
  client.consumption = original; void original.catch(() => undefined); return original;
}
function closeClient(owner: Owner, client: ClientOwner): Promise<void> {
  if (client.firstCleanup) return client.firstCleanup;
  client.firstCleanup = (async () => {
    const response = await client.originalFetch;
    if (client.consumption) await client.consumption;
    else if (response.body) {
      // Only the original delivered and unconsumed body is cancelled. A body
      // consumed to EOF may remain locked: its recorded original consumption
      // ACK, never a bodyUsed/locked flag, selects the safe cleanup branch.
      try { client.cancellation = response.body.cancel(); }
      catch (error) { client.cancellation = Promise.reject(error); }
      await client.cancellation;
    }
    owner.clients.delete(client);
  })();
  void client.firstCleanup.catch(() => undefined); return client.firstCleanup;
}
function closeProbe(owner: Owner): Promise<void> {
  if (owner.probeClose) return owner.probeClose;
  const probe = owner.probe;
  if (!probe) return Promise.resolve();
  owner.probeClose = new Promise<void>((resolveClose, reject) => {
    try { probe.close(error => error ? reject(error) : resolveClose()); } catch (error) { reject(error); }
  });
  return owner.probeClose;
}
function closeOwner(owner: Owner): Promise<void> {
  if (owner.close) return owner.close;
  owner.close = (async () => {
    try {
      // Settle/cancel each original delivered client body before listener
      // drain; unread backpressure cannot strand a pump during native close.
      const clients = await Promise.allSettled([...owner.clients].map(client => closeClient(owner, client)));
      const failures = clients.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (failures.length) throw new AggregateError(failures, "Original client response/body cleanup failed");
      if (owner.probe) await closeProbe(owner);
      if (owner.application) {
        const originalClose = owner.application.close();
        expect(owner.application.close()).toBe(originalClose);
        await originalClose;
        if (owner.native?.isOpen) throw new Error("Original composed application native close is unproven");
        owners.delete(owner); return;
      }
      if (owner.applicationAttempted) {
        // The original factory owns its first cleanup even when it rejects.
        // Await its original result, then retain the uncertain parent; never
        // issue a second raw core/native close or physical release.
        if (owner.originalApplication) await owner.originalApplication;
        throw new Error("Original application construction/cleanup has no acknowledged owner");
      }
      if (owner.server) await stopNodeHttpServerAndDrain(owner.server);
      if (owner.lease) await owner.lease.stopAdmissionAndDrain();
      if (owner.nativeConstructionStarted && !owner.native) throw new Error("Original native constructor has no returned owner/close ACK");
      if (owner.core) owner.core.close(); else if (owner.native?.isOpen) owner.native.close();
      if (owner.native?.isOpen) throw new Error("Actual current V28 native close is unproven");
      if (owner.lease) await owner.lease.release();
      owners.delete(owner);
    } catch (error) { owner.failure = error; owner.quarantined = true; throw error; }
  })();
  // Observe the original rejection without converting it or starting a retry.
  void owner.close.catch(() => undefined); return owner.close;
}
async function owned<T>(path: string, work: (owner: Owner, lease: LinuxWriterLease,
  native: DatabaseSync, core: SqliteCapability) => Promise<T>): Promise<T> {
  const owner: Owner = { quarantined: false, clients: new Set() }; owners.add(owner);
  let failed = false, originalFailure: unknown, result!: T;
  try {
    owner.lease = await acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid: rootOwnerUid });
    owner.nativeConstructionStarted = true;
    owner.native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
    owner.core = createSqliteCapability(owner.native); owner.lease.bind(owner.core, owner.native);
    result = await work(owner, owner.lease, owner.native, owner.core);
  } catch (error) { failed = true; originalFailure = error; }
  try { await closeOwner(owner); }
  catch (error) {
    const retained = failed ? new AggregateError([originalFailure, error], "Original current V28 work and cleanup both failed") : error;
    owner.failure = retained; throw retained;
  }
  if (failed) throw originalFailure;
  return result;
}
async function privateOrigin(owner: Owner): Promise<string> {
  // The production HTTP boundary captures its origin at construction. Obtain a
  // real numeric port and await the probe's one original close ACK before use.
  const probe = owner.probe = createServer();
  await new Promise<void>((resolveListen, reject) => {
    probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { probe.off("error", reject); resolveListen(); });
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Actual numeric fixture listener is unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  await closeProbe(owner); return origin;
}

type Session = Readonly<{ cookie: string; csrf: string }>;
async function composed(owner: Owner, lease: LinuxWriterLease, native: DatabaseSync, core: SqliteCapability) {
  const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
  const origin = await privateOrigin(owner);
  owner.applicationAttempted = true;
  const original = owner.originalApplication = Promise.resolve().then(() => createGroupV28ApplicationCandidate({
    database: core, nativeDatabase: native, writerLease: lease, admission,
    hasher: createPasswordHasher(), identityPolicy: POLICY, publicOrigin: origin, sampleMetadataReads: true,
    httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 },
  }));
  const application = owner.application = await original;
  const server = application.server;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject); server.listen(Number(new URL(origin).port), "127.0.0.1", () => {
      server.off("error", reject); resolveListen();
    });
  });
  async function request(path: string, method = "GET", input?: unknown, session?: Session, extra: Record<string, string> = {}) {
    const delivery = await fetchClient(owner, `${origin}${path}`, { method,
      headers: { ...(session ? { cookie: session.cookie } : {}), ...(method === "GET" ? {} : { origin, "content-type": "application/json",
        ...(session ? { "x-sfw-csrf": session.csrf } : {}) }), ...extra },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000), redirect: "manual" });
    const text = await consumeClient(delivery.client, "text") as string;
    const value: unknown = text ? JSON.parse(text) : null;
    return { status: delivery.response.status, headers: delivery.response.headers, text, value };
  }
  async function login(username: string): Promise<Session> {
    const result = await request("/api/auth/login", "POST", { username, password: PASSWORD });
    expect(result.status).toBe(200);
    const cookie = result.headers.get("set-cookie")?.split(";", 1)[0], csrf = object(result.value).csrf;
    if (!cookie?.startsWith("sfw_dev_session=") || typeof csrf !== "string") throw new Error("Original genuine client session was not delivered");
    return Object.freeze({ cookie, csrf });
  }
  return { application, request, login };
}async function composedV26(owner: Owner, lease: LinuxWriterLease, native: DatabaseSync, core: SqliteCapability, clientDirectory: string) {
  const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
  const origin = await privateOrigin(owner);
  owner.applicationAttempted = true;
  const original = owner.originalApplication = Promise.resolve().then(() => createNodeDevelopmentPrototype({
    database: core, nativeDatabase: native, writerLease: lease, admission,
    hasher: createPasswordHasher(), identityPolicy: POLICY, publicOrigin: origin, now: Date.now, clientDirectory,
    httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 },
  }));
  const application = owner.application = await original;
  const server = application.server;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject); server.listen(Number(new URL(origin).port), "127.0.0.1", () => {
      server.off("error", reject); resolveListen();
    });
  });
  async function request(path: string, method = "GET", input?: unknown, session?: Session, extra: Record<string, string> = {}) {
    const delivery = await fetchClient(owner, `${origin}${path}`, { method,
      headers: { ...(session ? { cookie: session.cookie } : {}), ...(method === "GET" ? {} : { origin, "content-type": "application/json",
        ...(session ? { "x-sfw-csrf": session.csrf } : {}) }), ...extra },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000), redirect: "manual" });
    const text = await consumeClient(delivery.client, "text") as string;
    const value: unknown = text ? JSON.parse(text) : null;
    return { status: delivery.response.status, headers: delivery.response.headers, text, value };
  }
  async function login(username: string): Promise<Session> {
    const result = await request("/api/auth/login", "POST", { username, password: PASSWORD });
    expect(result.status).toBe(200);
    const cookie = result.headers.get("set-cookie")?.split(";", 1)[0], csrf = object(result.value).csrf;
    if (!cookie?.startsWith("sfw_dev_session=") || typeof csrf !== "string") throw new Error("Original genuine client session was not delivered");
    return Object.freeze({ cookie, csrf });
  }
  return { application, request, login };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Actual JSON object required");
  return value as Record<string, unknown>;
}

// ONE new current permission phase. No historical Group eight, domain six or
// Local evidence is retagged. All creation/enrollment/grants use real current
// stopped operators or genuine authenticated HTTP, never SQL seeds or mocks.
describe("current nonempty Sample Run/Step and legacy common Comment projections",()=>{
  it("retains lawful V26 HTTP Template creation across stopped upgrade and enforces current independent Template and every shared text root before twelve projection bodies",()=>retainedCase(async()=>{
    guard();const directory=await mkdtemp(join(parent,".current-v28-sample-nonempty-"));await chmod(directory,0o700);
    console.info("Retained nonempty Sample projection fixture:",directory);
    const path=join(directory,"application.sqlite");await writeFile(path,"",{flag:"wx",mode:0o600});
    await writeFile(`${path}.writer-lock`,"",{flag:"wx",mode:0o600});
    const base={databasePath:path,filesystemRootOwnerUid:rootOwnerUid};
    await owned(path,async(_owner,lease,native,core)=>lease.withWriter(async()=>{
      installReviewedSqliteCatalog(native,V26_NODE_INSTALLATION_CATALOG);
      const identity=await createInstalledLocalIdentity({database:core,nativeDatabase:native,
        admission:admitInstallationRecoverySource(native,V26_NODE_INSTALLATION_CATALOG),hasher:createPasswordHasher(),policy:POLICY});
      await identity.offline(lease).bootstrap({username:"operator",password:PASSWORD,now:Date.now()});
    }));
    let templateId:string|undefined,familyId:string|undefined;
    await owned(path,async(owner,lease,native,core)=>{
      const f=await composedV26(owner,lease,native,core,directory),operator=await f.login("operator");
      const created=await f.request("/api/metrology-templates","POST",{name:"Lawful baseline instrument",toolName:"Retained instrument",
        parametersText:"Original captured parameters",commentsText:"Original captured method"},operator);
      expect(created.status).toBe(201);const id=object(created.value).id;if(typeof id!=="string") throw new Error("Actual HTTP-created Template id required");
      const row=native.prepare("SELECT recipe_family_id FROM template_versions WHERE id=? AND template_kind='metrology'").get(id);
      if(typeof row?.recipe_family_id!=="string") throw new Error("Actual complete original Template family required");
      templateId=id;familyId=row.recipe_family_id;
      expect(native.prepare("SELECT COUNT(*) n FROM template_steps WHERE template_version_id=?").get(id)?.n).toBe(1);
    });
    if(!templateId || !familyId) throw new Error("Original V26 work and firstclose must settle before upgrade");
    const selectedTemplate=templateId,selectedFamily=familyId;
    await executeCollaborationV28OperatorCandidate({...base,kind:"upgrade-metadata"});
    const alice=await executeV28OrdinaryAccountOperatorCandidate({...base,kind:"provision-account",username:"alice"},PASSWORD);
    const bob=await executeV28OrdinaryAccountOperatorCandidate({...base,kind:"provision-account",username:"bob"},PASSWORD);
    const am=await executeCollaborationV28OperatorCandidate({...base,kind:"enroll-local-member",principalId:alice.principalId,
      displayName:"Nonempty Alice",workspaceRole:"membershipAdministrator",canCreateSamples:true,expectedControlRevision:1});
    const bm=await executeCollaborationV28OperatorCandidate({...base,kind:"enroll-local-member",principalId:bob.principalId,
      displayName:"Nonempty Bob",workspaceRole:"member",canCreateSamples:false,expectedControlRevision:1});
    if(!am.memberId || !bm.memberId) throw new Error("Actual explicit current member mappings required");
    await executeDomainRootV28OperatorCandidate({...base,kind:"allocate-existing-root",principalId:alice.principalId,expectedMemberRevision:1,
      expectedControlRevision:1,rootKind:"template",rootId:selectedFamily,visibility:"restricted"});
    await executeCollaborationV28OperatorCandidate({...base,kind:"set-enforcement",enforcement:"enabled",expectedControlRevision:1});
    await owned(path,async(owner,lease,native,core)=>{
      const f=await composed(owner,lease,native,core),a=await f.login("alice"),b=await f.login("bob");
      const madeA=await f.request("/api/samples","POST",{code:"NONEMPTY-A",title:"Readable nonempty Sample",location:"Visible run cabinet"},a);
      const madeB=await f.request("/api/samples","POST",{code:"NONEMPTY-B",title:"Private second target",location:"Private run cabinet"},a);
      expect(madeA.status).toBe(201);expect(madeB.status).toBe(201);const sampleA=object(madeA.value).id,sampleB=object(madeB.value).id;
      if(typeof sampleA!=="string" || typeof sampleB!=="string") throw new Error("Actual current Sample pair required");
      const runA=await f.request(`/api/samples/${sampleA}/metrology-runs`,"POST",{templateVersionId:selectedTemplate},a);
      const runB=await f.request(`/api/samples/${sampleB}/metrology-runs`,"POST",{templateVersionId:selectedTemplate},a);
      expect(runA.status).toBe(201);expect(runB.status).toBe(201);const runIdA=object(runA.value).id,runIdB=object(runB.value).id;
      if(typeof runIdA!=="string" || typeof runIdB!=="string") throw new Error("Actual original accepted Run pair required");
      const target=(sampleId:string,runId:string)=>{
        const step=native.prepare("SELECT id,updated_at FROM run_steps WHERE run_id=? AND deleted_at IS NULL ORDER BY position").get(runId);
        if(typeof step?.id!=="string" || typeof step.updated_at!=="string") throw new Error("Actual current Step/CAS tuple required");
        return {sampleId,runId,stepId:step.id,expectedUpdatedAt:step.updated_at};
      };
      expect((await f.request("/api/run-step-comments","POST",{scope:"individual",body:"Visible independent text",targets:[target(sampleA,runIdA)]},a)).status).toBe(201);
      const common=await f.request("/api/run-step-comments","POST",{scope:"common",body:"Shared private target text",
        targets:[target(sampleA,runIdA),target(sampleB,runIdB)]},a);expect(common.status).toBe(201);
      const group=object(common.value).operationGroupId;if(typeof group!=="string") throw new Error("Original accepted legacy group required");
      expect(native.prepare("SELECT COUNT(*) n FROM run_step_comments WHERE operation_group_id=? AND submission_id IS NULL").get(group)?.n).toBe(2);
      const occurrence=native.prepare("SELECT c.id FROM run_step_comments c JOIN run_steps step ON step.id=c.run_step_id JOIN runs owner ON owner.id=step.run_id WHERE c.operation_group_id=? AND owner.sample_id=?").get(group,sampleA);
      if(typeof occurrence?.id!=="string") throw new Error("Actual original shared occurrence required");
      const commonPath=`/api/run-step-comments/${occurrence.id}`;
      const deleted=await f.request(commonPath,"DELETE",undefined,a);expect(deleted.status).toBe(200);
      expect(native.prepare("SELECT COUNT(*) n FROM events WHERE kind='step' AND json_extract(metadata_json,'$.operationGroupId')=? AND json_extract(metadata_json,'$.action')='step_comment_deleted' AND json_extract(metadata_json,'$.scope') IS NULL").get(group)?.n).toBe(2);
      const grantA=`/api/collaboration/resources/sample/${sampleA}/grants/${bm.memberId}`;
      const grantB=`/api/collaboration/resources/sample/${sampleB}/grants/${bm.memberId}`;
      expect((await f.request(grantA,"PUT",{operation:"grant",expectedResourceRevision:1,expectedGrantRevision:null,capability:"read",enabled:true},a)).status).toBe(200);
      const privateRead=await f.request(`/api/samples/${sampleA}`,"GET",undefined,b);expect(privateRead.status).toBe(200);
      expect(privateRead.value).toMatchObject({runs:[{id:runIdA,runKind:"metrology",templateName:"Lawful baseline instrument",
        steps:[{comments:[{body:"Visible independent text",scope:"individual"}]}]}]});
      expect(privateRead.text).not.toContain("Shared private target text");expect(privateRead.text).not.toContain("Private second target");
      expect(privateRead.text).not.toContain("Deleted common step comment");
      const restored=await f.request(`${commonPath}/restore`,"POST",undefined,a);expect(restored.status).toBe(200);
      expect(native.prepare("SELECT COUNT(*) n FROM events WHERE kind='step' AND json_extract(metadata_json,'$.operationGroupId')=? AND json_extract(metadata_json,'$.action')='step_comment_restored' AND json_extract(metadata_json,'$.scope') IS NULL").get(group)?.n).toBe(2);
      const restoredPrivate=await f.request(`/api/samples/${sampleA}`,"GET",undefined,b);expect(restoredPrivate.status).toBe(200);
      expect(restoredPrivate.text).not.toContain("Shared private target text");expect(restoredPrivate.text).not.toContain("Restored common step comment");
      expect((await f.request(`/api/templates/${selectedTemplate}`,"GET",undefined,b)).status).toBe(403);
      expect((await f.request(`/api/collaboration/resources/template/${selectedFamily}/grants/${bm.memberId}`,"PUT",
        {operation:"grant",expectedResourceRevision:1,expectedGrantRevision:null,capability:"read",enabled:true},a)).status).toBe(200);
      expect((await f.request(`/api/templates/${selectedTemplate}`,"GET",undefined,b)).status).toBe(200);
      // A Template grant still does not supply the second actual shared root.
      expect((await f.request(`/api/samples/${sampleA}`,"GET",undefined,b)).text).not.toContain("Shared private target text");
      expect((await f.request(grantB,"PUT",{operation:"grant",expectedResourceRevision:1,expectedGrantRevision:null,capability:"read",enabled:true},a)).status).toBe(200);
      const visible=await f.request(`/api/samples/${sampleA}`,"GET",undefined,b);expect(visible.status).toBe(200);
      expect(visible.text).toContain("Shared private target text");expect(visible.text).toContain("Deleted common step comment");expect(visible.text).toContain("Restored common step comment");expect(visible.value).toMatchObject({runs:[{steps:[{comments:expect.arrayContaining([expect.objectContaining({body:"Visible independent text",scope:"individual"}),expect.objectContaining({body:"Shared private target text",scope:"common"})])}]}]});
      expect((await f.request(grantB,"PUT",{operation:"grant",expectedResourceRevision:2,expectedGrantRevision:1,capability:"read",enabled:false},a)).status).toBe(200);
      const revoked=await f.request(`/api/samples/${sampleA}`,"GET",undefined,b);expect(revoked.status).toBe(200);
      expect(revoked.text).not.toContain("Shared private target text");expect(revoked.text).toContain("Visible independent text");
      expect(revoked.text).not.toContain("Deleted common step comment");expect(revoked.text).not.toContain("Restored common step comment");
      expect((await f.request(`/api/samples/${sampleB}`,"GET",undefined,b)).status).toBe(403);
      if (!("capabilities" in f.application)) throw new Error("Original V28 application capability descriptor is required");
      expect(f.application.capabilities.unavailable).toContain("sample-processing-media-and-file-descriptors");
      expect(native.prepare("SELECT COUNT(*) n FROM local_admin_grants WHERE principal_id IN(?,?)").get(alice.principalId,bob.principalId)?.n).toBe(0);
      expect(native.prepare("SELECT COUNT(*) n FROM comment_submissions").get()?.n).toBe(0); // Explicitly legacy, never canonical coverage.
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });expect(owners.size).toBe(0);guard();
  }),20_000);
});

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createInstalledLocalIdentity, type IdentityPolicy } from "../auth/identity";
import { createPasswordHasher } from "../auth/passwords";
import { createLocalAuthentication } from "../auth/local-auth-http";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport";
import { createLocalRequestSubjectIssuer, LocalRequestSubjectError, type LocalRequestSubject } from "../auth/local-request-subject";
import { createNodeHttpServer, stopNodeHttpServerAndDrain } from "../http";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate";
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog } from "../migrations";
import { createSqliteCapability, type SqliteCapability } from "../sqlite";
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "./writer-lease";
import { executeV28OrdinaryAccountOperatorCandidate } from "./ordinary-account-v28-candidate";
import { executeCollaborationV28OperatorCandidate } from "./collaboration-v28-operator-candidate";

const PASSWORD = "Synthetic current V28 identity qualification secret";
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
interface Owner {
  lease?: LinuxWriterLease; native?: DatabaseSync; core?: SqliteCapability; nativeConstructionStarted?: true;
  clients: Set<ClientOwner>;
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
  const directory = process.env.CURRENT_V28_IDENTITY_FIXTURE_PARENT;
  const pin = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID;
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory
    || !pin || !/^(?:0|[1-9][0-9]*)$/.test(pin) || !Number.isSafeInteger(Number(pin))
    || Number(pin) > 0xffff_ffff) throw new Error("Configure explicit current V28 identity qualification inputs");
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
      if (owner.server) await stopNodeHttpServerAndDrain(owner.server);
      if (owner.probe) await closeProbe(owner);
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
function counts(native: DatabaseSync) {
  return {
    accounts: native.prepare("SELECT COUNT(*) n FROM local_accounts").get()?.n,
    administrators: native.prepare("SELECT COUNT(*) n FROM local_admin_grants").get()?.n,
    sessions: native.prepare("SELECT COUNT(*) n FROM local_sessions").get()?.n,
    members: native.prepare("SELECT COUNT(*) n FROM collaboration_members").get()?.n,
    identities: native.prepare("SELECT COUNT(*) n FROM collaboration_identities").get()?.n,
    resources: native.prepare("SELECT COUNT(*) n FROM collaboration_resources").get()?.n,
    grants: native.prepare("SELECT COUNT(*) n FROM collaboration_grants").get()?.n,
  };
}

// One composable CURRENT phase. It is a new test, not a retag of the historical
// issuer six, Group eight, or Local cumulative evidence. No production routes or
// defaults are changed and no fixture is removed/reseeded after a failure.
describe("current V28 installed identity and separate stopped authority", () => {
  it("preserves V26 refusal, upgrades explicitly, provisions without grants, and binds actual HTTP facts to the current account", () => retainedCase(async () => {
    guard();
    const directory = await mkdtemp(join(parent, ".current-v28-identity-")); await chmod(directory, 0o700);
    console.info("Retained current V28 identity fixture:", directory);
    const path = join(directory, "application.sqlite");
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    await writeFile(`${path}.writer-lock`, "", { flag: "wx", mode: 0o600 });
    const base = { databasePath: path, filesystemRootOwnerUid: rootOwnerUid };
    const first = await owned(path, async (_owner, lease, native, core) => lease.withWriter(async () => {
      const installed = installReviewedSqliteCatalog(native, V26_NODE_INSTALLATION_CATALOG);
      expect(installed.checkpointId).toBe("portable-runtime/v26");
      const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
      const actual = createPasswordHasher(); let hashes = 0;
      const hasher = Object.freeze({ limits: actual.limits, verify: actual.verify,
        hash(password: string) { hashes++; return actual.hash(password); } });
      const identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission, hasher, policy: POLICY });
      const admin = await identity.offline(lease).bootstrap({ username: "operator", password: PASSWORD, now: Date.now() });
      const before = hashes;
      await expect(identity.offline(lease).provisionAccount({ username: "ordinary", password: PASSWORD, now: Date.now() }))
        .rejects.toMatchObject({ code: "account_unavailable" });
      expect(hashes).toBe(before); // Refuses the old checkpoint before KDF or writes.
      expect(native.prepare("SELECT COUNT(*) n FROM local_accounts").get()?.n).toBe(1);
      expect(native.prepare("SELECT COUNT(*) n FROM local_admin_grants").get()?.n).toBe(1);
      expect(native.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='collaboration_control'").get()?.n).toBe(0);
      return { installationId: installed.installationId, administratorId: admin.id };
    }));
    // All database/physical owners above have their original close ACK before an
    // explicit stopped operator can acquire the same real OS writer lock.
    const upgraded = await executeCollaborationV28OperatorCandidate({ ...base, kind: "upgrade-metadata" });
    expect(upgraded.installationId).toBe(first.installationId);
    await owned(path, async (_owner, lease, native) => lease.withWriter(async () => {
      const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
      expect(assertInstallationAdmission(native, admission).installationId).toBe(first.installationId);
      expect(native.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get())
        .toEqual({ schema_version: 2, enforcement: "disabled", revision: 1 });
      expect(counts(native)).toEqual({ accounts: 1, administrators: 1, sessions: 0, members: 0, identities: 0, resources: 0, grants: 0 });
    }));
    const ordinary = await executeV28OrdinaryAccountOperatorCandidate({ ...base, kind: "provision-account", username: "ordinary" }, PASSWORD);
    expect(ordinary.systemAdministrator).toBe(false); expect(ordinary.principalId).not.toBe(first.administratorId);
    await expect(executeCollaborationV28OperatorCandidate({ ...base, kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 }))
      .rejects.toThrow("unavailable");
    const enrolled = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: ordinary.principalId,
      displayName: "Synthetic ordinary member", workspaceRole: "member", canCreateSamples: false, expectedControlRevision: 1 });
    expect(enrolled.principalId).toBe(ordinary.principalId);
    await expect(executeCollaborationV28OperatorCandidate({ ...base, kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 }))
      .rejects.toThrow("unavailable"); // Ordinary membership is not membership administration.
    await owned(path, async (owner, lease, native, core) => {
      const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
      const identity = await lease.withWriter(() => createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission,
        hasher: createPasswordHasher(), policy: POLICY }));
      expect(counts(native)).toEqual({ accounts: 2, administrators: 1, sessions: 0, members: 1, identities: 1, resources: 0, grants: 0 });
      expect(native.prepare("SELECT enforcement,revision FROM collaboration_control WHERE singleton=1").get())
        .toEqual({ enforcement: "disabled", revision: 1 });
      expect(native.prepare("SELECT workspace_role,can_create_samples,can_create_projects,can_create_templates FROM collaboration_members WHERE member_id=?").get(enrolled.memberId!))
        .toEqual({ workspace_role: "member", can_create_samples: 0, can_create_projects: 0, can_create_templates: 0 });
      const origin = await privateOrigin(owner), transport = createLoopbackLocalAuthTransport({ publicOrigin: origin });
      const authentication = createLocalAuthentication({ identity, transport, now: () => Date.now() });
      const issuer = await lease.withWriter(() => createLocalRequestSubjectIssuer({ database: core, nativeDatabase: native, admission,
        writerLease: lease, authentication }));
      let captured: { request: Request; token: LocalRequestSubject } | undefined;
      const app = new Hono(); app.route("/api/local-auth", authentication.routes);
      app.onError(error => Response.json({ error: "Current request identity unavailable" }, { status: error instanceof HTTPException ? error.status
        : error instanceof LocalRequestSubjectError && error.code === "authentication_required" ? 401 : 503 }));
      app.get("/current-subject", async c => {
        const request = c.req.raw, token = await issuer.issue(request); captured = { request, token };
        return c.json({ facts: issuer.read(request, token) });
      });
      const server = owner.server = createNodeHttpServer(request => lease.withWriter(() => app.fetch(request)), {
        publicOrigin: origin, requestAdmission: (request, incoming, listener) => transport.admit(request, incoming, listener), timeoutMs: 5000,
      });
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject); server.listen(Number(new URL(origin).port), "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
      });
      const loginDelivery = await fetchClient(owner, `${origin}/api/local-auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ username: "ordinary", password: PASSWORD }), signal: AbortSignal.timeout(5000), redirect: "manual" });
      const login = loginDelivery.response; expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0]; expect(cookie).toMatch(/^sfw_dev_session=/);
      const loginBody = await consumeClient(loginDelivery.client, "json") as { principal: { id: string; capabilities: { systemAdministrator: boolean } } };
      expect(loginBody.principal.id).toBe(ordinary.principalId); expect(loginBody.principal.capabilities.systemAdministrator).toBe(false);
      const factsDelivery = await fetchClient(owner, `${origin}/current-subject`, { headers: { cookie: cookie! }, signal: AbortSignal.timeout(5000), redirect: "manual" });
      const response = factsDelivery.response; expect(response.status).toBe(200);
      const text = await consumeClient(factsDelivery.client, "text") as string;
      const facts = { provider: "local", issuer: `node-installation:${first.installationId}`, subject: ordinary.principalId };
      expect(JSON.parse(text)).toEqual({ facts }); expect(text).not.toContain(cookie!.slice("sfw_dev_session=".length));
      if (!captured) throw new Error("Original actual HTTP request subject was not retained");
      const issued = captured;
      await lease.withWriter(async () => {
        assertLinuxWriterLeaseBinding(lease, core, native);
        const clonedRequest: unknown = issued.request.clone();
        if (!(clonedRequest instanceof Request)) throw new Error("Original actual Request clone required");
        expect(() => issuer.read(clonedRequest, issued.token)).toThrow(LocalRequestSubjectError);
        expect(() => issuer.read(issued.request, { ...issued.token } as LocalRequestSubject)).toThrow(LocalRequestSubjectError);
        expect(issuer.read(issued.request, issued.token)).toEqual(facts);
        await identity.offline(lease).disableAccount(ordinary.principalId, Date.now());
        expect(() => issuer.read(issued.request, issued.token)).toThrow(LocalRequestSubjectError);
      });
      const deniedDelivery = await fetchClient(owner, `${origin}/current-subject`, { headers: { cookie: cookie! }, signal: AbortSignal.timeout(5000), redirect: "manual" });
      expect(deniedDelivery.response.status).toBe(401); await consumeClient(deniedDelivery.client, "arrayBuffer");
      expect(native.prepare("SELECT COUNT(*) n FROM local_admin_grants WHERE principal_id=?").get(ordinary.principalId)?.n).toBe(0);
      expect(native.prepare("SELECT COUNT(*) n FROM collaboration_grants").get()?.n).toBe(0);
      expect(native.prepare("SELECT enforcement FROM collaboration_control WHERE singleton=1").get()?.enforcement).toBe("disabled");
    });
  }), 20_000);
});

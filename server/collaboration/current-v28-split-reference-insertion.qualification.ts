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
import { PROJECT_CREATION_SUBJECT_HEADER } from "../../shared/project-creation-subject";

const PASSWORD = "Synthetic current V28 split and reference qualification secret";
const POLICY: IdentityPolicy = { absoluteLifetimeMs: 120_000, idleLifetimeMs: 30_000,
  loginWindowMs: 1000, loginAttempts: 5, throttleBuckets: 100 };
const ORIGINAL_RESERVE = 512n * 1024n * 1024n;
let parent: string, rootOwnerUid: number;
interface PreparedFixture {
  path: string;
  base: { databasePath: string; filesystemRootOwnerUid: number };
}
let preparedFixture: PreparedFixture | undefined;
interface ClientOwner {
  originalFetch: Promise<Response>; response?: Response; consumption?: Promise<unknown>;
  cancellation?: Promise<void>; firstCleanup?: Promise<void>;
}
interface CaseOwner { original?: Promise<void>; failed: boolean; failure?: unknown }
const cases = new Set<CaseOwner>();
interface Owner {
  lease?: LinuxWriterLease; native?: DatabaseSync; core?: SqliteCapability; nativeConstructionStarted?: true;
  clients: Set<ClientOwner>;
  applicationAttempted?: true; originalApplication?: Promise<GroupV28ApplicationCandidate>; application?: GroupV28ApplicationCandidate;
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
beforeAll(() => retainedCase(async () => {
  const directory = process.env.CURRENT_V28_SPLIT_REFERENCE_FIXTURE_PARENT;
  const pin = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID;
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory
    || !pin || !/^(?:0|[1-9][0-9]*)$/.test(pin) || !Number.isSafeInteger(Number(pin))
    || Number(pin) > 0xffff_ffff) throw new Error("Configure explicit current V28 composer qualification inputs");
  parent = directory; rootOwnerUid = Number(pin); guard();
  {
    guard(); const directory = await mkdtemp(join(parent, ".current-v28-split-reference-")); await chmod(directory, 0o700);
    console.info("Retained current split/Reference fixture:", directory);
    const path = join(directory, "application.sqlite");
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    await writeFile(`${path}.writer-lock`, "", { flag: "wx", mode: 0o600 });
    const base = { databasePath: path, filesystemRootOwnerUid: rootOwnerUid };
    await owned(path, async (_owner, lease, native, core) => lease.withWriter(async () => {
      installReviewedSqliteCatalog(native, V26_NODE_INSTALLATION_CATALOG);
      const identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native,
        admission: admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG), hasher: createPasswordHasher(), policy: POLICY });
      await identity.offline(lease).bootstrap({ username: "operator", password: PASSWORD, now: Date.now() });
    }));
    await executeCollaborationV28OperatorCandidate({ ...base, kind: "upgrade-metadata" });
    preparedFixture = { path, base };
  }
}));
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
    hasher: createPasswordHasher(), identityPolicy: POLICY, publicOrigin: origin,
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
function sampleState(native: DatabaseSync, id: string) {
  const value = native.prepare("SELECT status,location,pinned,updated_at FROM samples WHERE id=? AND deleted_at IS NULL").get(id);
  if (!value || typeof value.updated_at !== "string" || typeof value.status !== "string") throw new Error("Actual live Sample state required");
  return { status: value.status, location: typeof value.location === "string" ? value.location : "", pinned: value.pinned === 1,
    expectedUpdatedAt: value.updated_at };
}


// ONE subsequent current phase for two new operation families. Its original
// work is held before filesystem setup and every delivered response is consumed
// through the recorded original body promise before app/native/physical close.
describe("current media-free Sample split and independent Reference insertion", () => {
  it("couples genuine child managers atomically and requires Project edit plus every source root independently before insertion and replay", () => retainedCase(async () => {
    if (!preparedFixture) throw new Error("Original fresh split/Reference setup has no acknowledged fixture");
    const { path, base } = preparedFixture;
    const alice = await executeV28OrdinaryAccountOperatorCandidate({ ...base, kind: "provision-account", username: "alice" }, PASSWORD);
    const bob = await executeV28OrdinaryAccountOperatorCandidate({ ...base, kind: "provision-account", username: "bob" }, PASSWORD);
    const am = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: alice.principalId,
      displayName: "Split Alice", workspaceRole: "membershipAdministrator", canCreateSamples: true, expectedControlRevision: 1 });
    const bm = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: bob.principalId,
      displayName: "Split Bob", workspaceRole: "member", canCreateSamples: false, expectedControlRevision: 1 });
    if (!am.memberId || !bm.memberId) throw new Error("Original named current members required");
    const bobMemberId = bm.memberId;
    await executeDomainRootV28OperatorCandidate({ ...base, kind: "set-creation-flags", principalId: alice.principalId,
      expectedMemberRevision: 1, expectedControlRevision: 1, canCreateSamples: true, canCreateProjects: true, canCreateTemplates: false });
    await executeCollaborationV28OperatorCandidate({ ...base, kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 });
    await owned(path, async (owner, lease, native, core) => {
      const f = await composed(owner, lease, native, core), a = await f.login("alice"), b = await f.login("bob");
      expect(f.application.routes).toEqual(expect.arrayContaining([
        { method: "POST", path: "/api/samples/:sampleId/split" }, { method: "POST", path: "/api/projects/:projectId/items/reference" },
      ]));
      expect(f.application.capabilities.unavailable).not.toContain("sample-split");
      expect(f.application.capabilities.unavailable).toContain("file-bytes-and-file-grants");
      const creation = await f.request("/api/samples", "POST", { code: "SPLIT-PARENT", title: "Original parent", location: "Source box" }, a);
      expect(creation.status).toBe(201); const sampleId = object(creation.value).id;
      if (typeof sampleId !== "string") throw new Error("Original parent identity required");
      const grantPath = `/api/collaboration/resources/sample/${sampleId}/grants/${bm.memberId}`;
      expect((await f.request(grantPath, "PUT", { operation: "grant", expectedResourceRevision: 1, expectedGrantRevision: null,
        capability: "edit", enabled: true }, a)).status).toBe(200);
      const splitInput = { expectedUpdatedAt: sampleState(native, sampleId).expectedUpdatedAt, parentStatusAfter: "consumed",
        pieces: [{ code: "SPLIT-CHILD", title: "Private actual child", location: "Child box", status: "active" }] };
      expect((await f.request(`/api/samples/${sampleId}/split`, "POST", splitInput, b)).status).toBe(403);
      expect(native.prepare("SELECT COUNT(*) n FROM samples WHERE parent_id=?").get(sampleId)?.n).toBe(0);
      const split = await f.request(`/api/samples/${sampleId}/split`, "POST", splitInput, a);
      expect(split.status).toBe(201); const children = object(split.value).children;
      if (!Array.isArray(children) || children.length !== 1) throw new Error("Original accepted child vector required");
      const childId = object(children[0]).id; if (typeof childId !== "string") throw new Error("Original child id required");
      expect(native.prepare("SELECT status FROM samples WHERE id=?").get(sampleId)?.status).toBe("consumed");
      expect(native.prepare("SELECT parent_id,created_by,title FROM samples WHERE id=?").get(childId))
        .toEqual({ parent_id: sampleId, created_by: `local-account:${alice.principalId}`, title: "Private actual child" });
      expect(native.prepare("SELECT visibility,revision FROM collaboration_resources WHERE root_kind='sample' AND root_id=?").get(childId))
        .toEqual({ visibility: "restricted", revision: 1 });
      expect(native.prepare("SELECT member_id,capability,enabled FROM collaboration_grants WHERE root_kind='sample' AND root_id=?").all(childId))
        .toEqual([{ member_id: am.memberId, capability: "manage", enabled: 1 }]);
      expect((await f.request(`/api/samples/${sampleId}/split`, "POST", splitInput, a)).status).toBe(409);
      expect(native.prepare("SELECT COUNT(*) n FROM samples WHERE parent_id=?").get(sampleId)?.n).toBe(1);
      const listing = await f.request("/api/projects", "GET", undefined, a), witness = listing.headers.get(PROJECT_CREATION_SUBJECT_HEADER);
      if (!witness) throw new Error("Original current creation subject required");
      const projectId = "split-reference-destination";
      expect((await f.request("/api/projects", "POST", { id: projectId, title: "Independent destination", operationId: "new-ref-project" }, a,
        { [PROJECT_CREATION_SUBJECT_HEADER]: witness })).status).toBe(201);
      const insertion = { itemId: "actual-reference-item", placementId: "actual-reference-placement", target: { type: "sample", id: childId },
        expectedProjectRevision: 1, operationId: "actual-reference-insert", geometry: { x: 0, y: 0, width: 320, height: 180, zIndex: 1 } };
      const insertionPath = `/api/projects/${projectId}/items/reference`;
      expect((await f.request(insertionPath, "POST", insertion, b)).status).toBe(403); // No destination edit.
      expect((await f.request(`/api/collaboration/resources/project/${projectId}/grants/${bm.memberId}`, "PUT",
        { operation: "grant", expectedResourceRevision: 1, expectedGrantRevision: null, capability: "edit", enabled: true }, a)).status).toBe(200);
      const forbidden = await f.request(insertionPath, "POST", insertion, b);
      expect(forbidden.status).toBe(403); expect(forbidden.text).not.toContain("Private actual child"); // Edit never grants source read.
      expect(native.prepare("SELECT revision FROM projects WHERE id=?").get(projectId)?.revision).toBe(1);
      expect(native.prepare("SELECT COUNT(*) n FROM project_items WHERE project_id=?").get(projectId)?.n).toBe(0);
      const inserted = await f.request(insertionPath, "POST", insertion, a); expect(inserted.status).toBe(201);
      expect(inserted.value).toMatchObject({ replayed: false, item: { id: insertion.itemId, itemType: "reference", projectContentId: null }, content: null, attachment: null });
      expect((await f.request(insertionPath, "POST", insertion, a)).status).toBe(200);
      expect(native.prepare("SELECT COUNT(*) n FROM project_items WHERE project_id=?").get(projectId)?.n).toBe(1);
      expect((await f.request(`/api/collaboration/resources/sample/${childId}/visibility`, "PUT",
        { operation: "visibility", expectedResourceRevision: 1, visibility: "workspace" }, a)).status).toBe(200);
      const bobInsertion = { ...insertion, itemId: "bob-reference-item", placementId: "bob-reference-placement",
        operationId: "bob-independent-insert", expectedProjectRevision: 2 };
      expect((await f.request(insertionPath, "POST", bobInsertion, b)).status).toBe(201);
      expect(native.prepare("SELECT COUNT(*) n FROM project_items WHERE project_id=?").get(projectId)?.n).toBe(2);
      expect((await f.request(`/api/collaboration/resources/sample/${childId}/visibility`, "PUT",
        { operation: "visibility", expectedResourceRevision: 2, visibility: "restricted" }, a)).status).toBe(200);
      expect((await f.request(insertionPath, "POST", bobInsertion, b)).status).toBe(403); // Replay needs current source rights.
      const filtered = await f.request(`/api/projects/${projectId}`, "GET", undefined, b);
      expect(filtered.status).toBe(200); expect(filtered.text).not.toContain("Private actual child");
      expect(native.prepare("SELECT COUNT(*) n FROM local_admin_grants WHERE principal_id IN(?,?)").get(alice.principalId, bob.principalId)?.n).toBe(0);
      expect(native.prepare("SELECT can_create_samples FROM collaboration_members WHERE member_id=?").get(bobMemberId)?.can_create_samples).toBe(0);
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
    expect(owners.size).toBe(0); guard();
  }), 20_000);
});

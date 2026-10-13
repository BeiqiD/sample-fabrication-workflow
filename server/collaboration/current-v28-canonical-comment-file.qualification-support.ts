import { createNodeDevelopmentPrototype } from "../node-application";
import { afterEach, beforeAll, expect } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog } from "../migrations";
import { createSqliteCapability, type SqliteCapability } from "../sqlite";
import { acquireLinuxWriterLease, type LinuxWriterLease } from "../operations/writer-lease";
import { executeV28OrdinaryAccountOperatorCandidate } from "../operations/ordinary-account-v28-candidate";
import { executeCollaborationV28OperatorCandidate } from "../operations/collaboration-v28-operator-candidate";

import { createGroupV28ApplicationCandidate, type GroupV28ApplicationCandidate } from "./group-v28-application-candidate";
import { executeDomainRootV28OperatorCandidate } from "../operations/collaboration-domain-roots-v28-candidate";
import { canonicalLocalVolumeNamespace } from "../../shared/contracts/local-volume-profile";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import { loadNodeRuntimeConfiguration, type NodeConfiguredLocalVolumeDescriptor } from "../node-runtime-config";
import { createLocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";
import { createLocalVolumeProfileLifecycle } from "../storage/local-volume-profile-lifecycle";
import { createOfflineLocalFileInitialization } from "../storage/local-file-initialization";

export const CANONICAL_FILE_PASSWORD = "Synthetic current V28 canonical File fixture secret";
const PASSWORD = CANONICAL_FILE_PASSWORD;
export const CANONICAL_FILE_IDENTITY_POLICY: IdentityPolicy = { absoluteLifetimeMs: 120_000, idleLifetimeMs: 30_000,
  loginWindowMs: 1000, loginAttempts: 5, throttleBuckets: 100 };
const ORIGINAL_RESERVE = 512n * 1024n * 1024n;
const POLICY = CANONICAL_FILE_IDENTITY_POLICY;
let parent: string, rootOwnerUid: number;
export interface CanonicalFileClientOwner {
  originalFetch: Promise<Response>; response?: Response; consumption?: Promise<unknown>;
  cancellation?: Promise<void>; firstCleanup?: Promise<void>;
}
interface CaseOwner { original?: Promise<void>; failed: boolean; failure?: unknown }
const cases = new Set<CaseOwner>();
type OriginalOwnedApplication = Pick<GroupV28ApplicationCandidate,"server"|"close">;
export interface CanonicalFileFixtureOwner {
  originalAcquire?: Promise<LinuxWriterLease>; lease?: LinuxWriterLease; native?: DatabaseSync; core?: SqliteCapability; nativeConstructionStarted?: true;
  clients: Set<CanonicalFileClientOwner>;
  applicationAttempted?: true; originalApplication?: Promise<OriginalOwnedApplication>; application?: OriginalOwnedApplication;
  server?: Server; probe?: Server; probeClose?: Promise<void>; close?: Promise<void>;
  openingAttempted?: true; opening?: ReturnType<typeof createLocalVolumeProfileOpening>; openingClose?: Promise<void>;
  failure?: unknown; quarantined: boolean;
}
const owners = new Set<CanonicalFileFixtureOwner>();
export function guardCanonicalFileReserve() {
  for (const path of [parent, tmpdir()]) {
    const space = statfsSync(path, { bigint: true });
    if (space.bavail * space.bsize < ORIGINAL_RESERVE) throw new Error("Original dual 512 MiB fixture reserve is unavailable");
  }
}
beforeAll(() => {
  const directory = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT;
  const pin = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID;
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory
    || !pin || !/^(?:0|[1-9][0-9]*)$/.test(pin) || !Number.isSafeInteger(Number(pin))
    || Number(pin) > 0xffff_ffff) throw new Error("Configure explicit current V28 canonical File qualification inputs");
  parent = directory; rootOwnerUid = Number(pin); guardCanonicalFileReserve();
});
afterEach(() => {
  // An uncertain original cleanup is retained for the controller. Never retry it
  // in a hook or infer a successful ACK from a closed-looking native object.
  if (owners.size || cases.size) throw new AggregateError([
    ...[...owners].map(owner => owner.failure), ...[...cases].map(owner => owner.failed ? owner.failure : owner.original),
  ], "Original current V28 case or fixture ownership remains unproven");
  guardCanonicalFileReserve();
});
export function retainedCanonicalFileCase(work: () => Promise<void>): Promise<void> {
  // Reserve the full original case before its first filesystem/fixture await.
  // Late setup and the gaps between stopped operations remain visible after a
  // test timeout. A failed case retains its exact original result and cause.
  const owner: CaseOwner = { failed: false }; cases.add(owner);
  const original = owner.original = Promise.resolve().then(work);
  original.then(() => cases.delete(owner), error => { owner.failed = true; owner.failure = error; });
  return original;
}
export async function fetchCanonicalFileClient(owner: CanonicalFileFixtureOwner, url: string, options: RequestInit): Promise<{ client: CanonicalFileClientOwner; response: Response }> {
  let originalFetch: Promise<Response>;
  try { originalFetch = fetch(url, options); } catch (error) { originalFetch = Promise.reject(error); }
  const client: CanonicalFileClientOwner = { originalFetch }; owner.clients.add(client);
  originalFetch.then(response => { client.response = response; }, () => undefined);
  const response = await originalFetch; return { client, response };
}
export function consumeCanonicalFileClient(client: CanonicalFileClientOwner, method: "json" | "text" | "arrayBuffer"): Promise<unknown> {
  if (client.consumption) throw new Error("The original client body was already selected");
  if (!client.response) throw new Error("The original client response was not delivered");
  let original: Promise<unknown>;
  try { original = client.response[method](); } catch (error) { original = Promise.reject(error); }
  client.consumption = original; void original.catch(() => undefined); return original;
}
function closeClient(owner: CanonicalFileFixtureOwner, client: CanonicalFileClientOwner): Promise<void> {
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
function closeProbe(owner: CanonicalFileFixtureOwner): Promise<void> {
  if (owner.probeClose) return owner.probeClose;
  const probe = owner.probe;
  if (!probe) return Promise.resolve();
  owner.probeClose = new Promise<void>((resolveClose, reject) => {
    try { probe.close(error => error ? reject(error) : resolveClose()); } catch (error) { reject(error); }
  });
  return owner.probeClose;
}
function closeOwner(owner: CanonicalFileFixtureOwner): Promise<void> {
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
      if (owner.originalAcquire) owner.lease = await owner.originalAcquire;
      // A returned trusted physical opening owns provider/FD/setup promises. Its
      // original cached first close must ACK before the native/lease parent.
      if (owner.openingAttempted && !owner.opening) throw new Error("Original physical opening constructor has no returned owner/first ACK");
      if (owner.opening) await closeCanonicalFileOpening(owner);
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
export async function withCanonicalFileDatabase<T>(path: string, work: (owner: CanonicalFileFixtureOwner, lease: LinuxWriterLease,
  native: DatabaseSync, core: SqliteCapability) => Promise<T>): Promise<T> {
  const owner: CanonicalFileFixtureOwner = { quarantined: false, clients: new Set() }; owners.add(owner);
  let failed = false, originalFailure: unknown, result!: T;
  try {
    owner.originalAcquire = acquireLinuxWriterLease({ databasePath: path, filesystemRootOwnerUid: rootOwnerUid });
    void owner.originalAcquire.catch(() => undefined);
    owner.lease = await owner.originalAcquire;
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
export async function canonicalFilePrivateOrigin(owner: CanonicalFileFixtureOwner): Promise<string> {
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

function closeCanonicalFileOpening(owner: CanonicalFileFixtureOwner): Promise<void> {
  if (owner.openingClose) return owner.openingClose;
  if (!owner.opening) return Promise.reject(new Error("Original physical opening owner is unavailable"));
  owner.openingClose = Promise.resolve().then(() => owner.opening!.close());
  void owner.openingClose.catch(() => undefined); return owner.openingClose;
}
export type CanonicalFileSession = Readonly<{ cookie: string; csrf: string }>;
export function canonicalFileObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Actual JSON object required");
  return value as Record<string, unknown>;
}
export async function listenCanonicalFileApplication(owner: CanonicalFileFixtureOwner, origin: string) {
  const server = owner.application!.server;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject); server.listen(Number(new URL(origin).port), "127.0.0.1", () => {
      server.off("error", reject); resolveListen();
    });
  });
}
export function canonicalFileClient(owner: CanonicalFileFixtureOwner, origin: string) {
  async function request(path: string, method = "GET", input?: unknown, session?: CanonicalFileSession, extra: Record<string, string> = {}) {
    const delivery = await fetchCanonicalFileClient(owner, `${origin}${path}`, { method,
      headers: { ...(session ? { cookie: session.cookie } : {}), ...(method === "GET" ? {} : { origin, "content-type": "application/json",
        ...(session ? { "x-sfw-csrf": session.csrf } : {}) }), ...extra },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000), redirect: "manual" });
    const text = await consumeCanonicalFileClient(delivery.client, "text") as string;
    const value: unknown = text ? JSON.parse(text) : null;
    return { status: delivery.response.status, headers: delivery.response.headers, text, value };
  }
  async function raw(path: string, method: "GET" | "POST" | "PUT", session: CanonicalFileSession, body?: Uint8Array<ArrayBuffer>, extra: Record<string, string> = {}) {
    return fetchCanonicalFileClient(owner, `${origin}${path}`, { method,
      headers: { cookie: session.cookie, ...(method === "GET" ? {} : { origin, "x-sfw-csrf": session.csrf }), ...extra },
      ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(5000), redirect: "manual" });
  }
  async function login(username: string): Promise<CanonicalFileSession> {
    const result = await request("/api/auth/login", "POST", { username, password: PASSWORD });
    expect(result.status).toBe(200);
    const cookie = result.headers.get("set-cookie")?.split(";", 1)[0], csrf = canonicalFileObject(result.value).csrf;
    if (!cookie?.startsWith("sfw_dev_session=") || typeof csrf !== "string") throw new Error("Original genuine client session was not delivered");
    return Object.freeze({ cookie, csrf });
  }
  return Object.freeze({ origin, request, raw, login });
}
async function composeCanonicalFileV26(owner: CanonicalFileFixtureOwner, lease: LinuxWriterLease, native: DatabaseSync, core: SqliteCapability, clientDirectory: string) {
  const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
  const origin = await canonicalFilePrivateOrigin(owner);
  owner.applicationAttempted = true;
  const original = owner.originalApplication = Promise.resolve().then(() => createNodeDevelopmentPrototype({
    database: core, nativeDatabase: native, writerLease: lease, admission,
    hasher: createPasswordHasher(), identityPolicy: POLICY, publicOrigin: origin, now: Date.now, clientDirectory,
    httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 },
  }));
  owner.application = await original;
  await listenCanonicalFileApplication(owner, origin);
  return canonicalFileClient(owner, origin);
}
export interface CanonicalCommentFileBaseline {
  readonly root: string; readonly dataDirectory: string; readonly path: string; readonly clientDirectory: string;
  readonly rootOwnerUid: number; readonly installationId: string; readonly operatorActor: string;
  readonly descriptors: readonly Readonly<NodeConfiguredLocalVolumeDescriptor>[];
  readonly internalProfileId: string; readonly originalsProfileId: string;
  readonly templateId: string; readonly familyId: string;
  readonly targets: readonly Readonly<{ sampleId: string; runId: string; stepId: string }>[];
  readonly alice: Readonly<{ principalId: string; memberId: string }>;
  readonly bob: Readonly<{ principalId: string; memberId: string }>;
}
/** Genuine original V26 HTTP domain creation, independently authenticated typed
 * Local profile setup/initialization, original first-close ACK, then explicit
 * stopped V28 account/member/root/control operations. No domain/policy SQL seed,
 * recovered File authority, fabricated V26 receipt or administrator Group grant. */
export async function prepareCanonicalCommentFileBaseline(): Promise<CanonicalCommentFileBaseline> {
  if (cases.size !== 1) throw new Error("Retain the one full original case before baseline filesystem setup");
  guardCanonicalFileReserve();
  const root = await mkdtemp(join(parent, ".current-v28-canonical-file-")); await chmod(root, 0o700);
  console.info("Retained genuine canonical File baseline:", root);
  const dataDirectory = join(root, "data"), clientDirectory = join(root, "client");
  await mkdir(dataDirectory, { mode: 0o700 }); await mkdir(clientDirectory, { mode: 0o700 });
  await writeFile(join(clientDirectory, "index.html"), "<!doctype html><title>API fixture</title>", { flag: "wx", mode: 0o600 });
  const path = join(dataDirectory, "application.sqlite"); await writeFile(path, "", { flag: "wx", mode: 0o600 });
  await writeFile(`${path}.writer-lock`, "", { flag: "wx", mode: 0o600 });
  const base = { databasePath: path, filesystemRootOwnerUid: rootOwnerUid };
  let operatorActor: string | undefined, installationId: string | undefined;
  await withCanonicalFileDatabase(path, async (_owner, lease, native, core) => lease.withWriter(async () => {
    installReviewedSqliteCatalog(native, V26_NODE_INSTALLATION_CATALOG);
    const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
    installationId = assertInstallationAdmission(native, admission).installationId;
    const identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission,
      hasher: createPasswordHasher(), policy: POLICY });
    operatorActor = (await identity.offline(lease).bootstrap({ username: "operator", password: PASSWORD, now: Date.now() })).actor;
  }));
  if (!operatorActor || !installationId) throw new Error("Actual installed operator and original first-close ACK are required");
  const capturedActor = operatorActor, capturedInstallation = installationId;
  let templateId: string | undefined, familyId: string | undefined;
  const targets: Readonly<{ sampleId: string; runId: string; stepId: string }>[] = [];
  await withCanonicalFileDatabase(path, async (owner, lease, native, core) => {
    const f = await composeCanonicalFileV26(owner, lease, native, core, clientDirectory), operator = await f.login("operator");
    const created = await f.request("/api/metrology-templates", "POST", { name: "Lawful canonical baseline instrument", toolName: "Retained instrument",
      parametersText: "Original captured parameters", commentsText: "Original captured method" }, operator);
    expect(created.status).toBe(201); const selectedTemplate = canonicalFileObject(created.value).id;
    if (typeof selectedTemplate !== "string") throw new Error("Actual HTTP-created Template id is required");
    const family = native.prepare("SELECT recipe_family_id FROM template_versions WHERE id=? AND template_kind='metrology'").get(selectedTemplate);
    if (typeof family?.recipe_family_id !== "string") throw new Error("Actual original Template family is required");
    templateId = selectedTemplate; familyId = family.recipe_family_id;
    for (const slot of ["A", "B"]) {
      const made = await f.request("/api/samples", "POST", { code: `CANONICAL-${slot}`, title: `Canonical Sample ${slot}` }, operator);
      expect(made.status).toBe(201); const sampleId = canonicalFileObject(made.value).id;
      if (typeof sampleId !== "string") throw new Error("Actual HTTP-created Sample id is required");
      const madeRun = await f.request(`/api/samples/${sampleId}/metrology-runs`, "POST", { templateVersionId: selectedTemplate }, operator);
      expect(madeRun.status).toBe(201); const runId = canonicalFileObject(madeRun.value).id;
      if (typeof runId !== "string") throw new Error("Actual HTTP-created Run id is required");
      const step = native.prepare("SELECT id FROM run_steps WHERE run_id=? AND deleted_at IS NULL ORDER BY position").get(runId);
      if (typeof step?.id !== "string") throw new Error("Actual HTTP-created Step id is required");
      targets.push(Object.freeze({ sampleId, runId, stepId: step.id }));
    }
    expect(native.prepare("SELECT count(*) n FROM comment_submissions").get()?.n).toBe(0);
  });
  if (!templateId || !familyId || targets.length !== 2) throw new Error("The full lawful HTTP baseline and original close must settle");
  const selectedTemplate = templateId, selectedFamily = familyId;
  const volumes = [0, 1].map(() => {
    const namespace = Object.freeze({ kind: "local-volume" as const, volumeId: randomUUID(), rootId: randomUUID(), namespaceRevision: 1 as const });
    return Object.freeze({ namespace, profileId: `storage-profile:local:${createHash("sha256").update(canonicalLocalVolumeNamespace(namespace)).digest("hex")}`,
      id: randomUUID(), rootBindingId: randomUUID() });
  });
  const descriptors: Readonly<NodeConfiguredLocalVolumeDescriptor>[] = [];
  for (const volume of volumes) {
    const bytesRoot = join(root, volume.id); await mkdir(bytesRoot, { mode: 0o700 });
    for (const child of ["objects", "staging"]) await mkdir(join(bytesRoot, child), { mode: 0o700 });
    await writeFile(join(bytesRoot, "namespace.json"), JSON.stringify({ format: "local-byte-namespace-v1", namespace: {
      volumeId: volume.namespace.volumeId, rootId: volume.namespace.rootId, profileId: volume.profileId, namespaceRevision: 1,
    } }), { flag: "wx", mode: 0o600 });
    descriptors.push(Object.freeze({ id: volume.id, root: bytesRoot, rootBindingId: volume.rootBindingId, namespace: volume.namespace }));
  }
  await withCanonicalFileDatabase(path, async (owner, lease, native, core) => {
    const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
    const identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission,
      hasher: createPasswordHasher(), policy: POLICY });
    const session = await lease.withWriter(() => identity.login({ username: "operator", password: PASSWORD,
      sourceKey: "genuine-current-canonical-local-file-initialization", now: Date.now() }));
    owner.openingAttempted = true;
    const opening = owner.opening = createLocalVolumeProfileOpening({ database: core, nativeDatabase: native, admission,
      writerLease: lease, descriptors, filesystemRootOwnerUid: rootOwnerUid, async authorizeAdministrator(actor) {
        const actual = await identity.authenticate(session.token, Date.now());
        return actual?.actor === actor && actual.capabilities.systemAdministrator;
      } });
    const lifecycle = createLocalVolumeProfileLifecycle(opening);
    for (const volume of volumes) {
      await opening.register({ operationId: randomUUID(), volumeDescriptorId: volume.id }, capturedActor);
      await lifecycle.probeAndBind({ operationId: randomUUID(), checkId: randomUUID(), volumeDescriptorId: volume.id,
        access: "read_write", expectedBindingRevision: null }, capturedActor);
      await lifecycle.activate({ operationId: randomUUID(), volumeDescriptorId: volume.id, expectedBindingRevision: 1 }, capturedActor);
    }
    const epoch = configurationSqlInteger(native.prepare("SELECT epoch FROM file_shadow_control WHERE singleton=1").get()!.epoch, "Actual fresh local File epoch");
    await createOfflineLocalFileInitialization(opening).initialize({ requestId: randomUUID(), expectedEpoch: epoch,
      internalProfileId: volumes[0]!.profileId, originalsProfileId: volumes[1]!.profileId }, capturedActor);
    expect(native.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").get()?.mode).toBe("active");
    expect(native.prepare("SELECT count(*) n FROM files").get()?.n).toBe(0);
    await closeCanonicalFileOpening(owner);
  });
  // Every ordinary operator below acquires its own original stopped writer.
  // The trusted V26 opening/native/lease has already returned its first ACK.
  await executeCollaborationV28OperatorCandidate({ ...base, kind: "upgrade-metadata" });
  const alice = await executeV28OrdinaryAccountOperatorCandidate({ ...base, kind: "provision-account", username: "alice" }, PASSWORD);
  const bob = await executeV28OrdinaryAccountOperatorCandidate({ ...base, kind: "provision-account", username: "bob" }, PASSWORD);
  const am = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: alice.principalId,
    displayName: "Canonical Alice", workspaceRole: "membershipAdministrator", canCreateSamples: false, expectedControlRevision: 1 });
  const bm = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: bob.principalId,
    displayName: "Canonical Bob", workspaceRole: "member", canCreateSamples: false, expectedControlRevision: 1 });
  if (!am.memberId || !bm.memberId) throw new Error("Actual explicitly mapped ordinary members are required");
  const aliceMemberId = am.memberId, bobMemberId = bm.memberId;
  for (const target of targets) {
    const allocated = await executeDomainRootV28OperatorCandidate({ ...base, kind: "allocate-existing-root", rootKind: "sample",
      rootId: target.sampleId, visibility: "restricted", principalId: alice.principalId,
      expectedMemberRevision: 1, expectedControlRevision: 1 });
    expect(allocated.root).toEqual({ kind: "sample", id: target.sampleId, resourceRevision: 1, grantRevision: 1 });
  }
  await executeCollaborationV28OperatorCandidate({ ...base, kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 });
  return Object.freeze({ root, dataDirectory, path, clientDirectory, rootOwnerUid, installationId: capturedInstallation,
    operatorActor: capturedActor, descriptors: Object.freeze(descriptors), internalProfileId: volumes[0]!.profileId,
    originalsProfileId: volumes[1]!.profileId, templateId: selectedTemplate, familyId: selectedFamily, targets: Object.freeze(targets),
    alice: Object.freeze({ principalId: alice.principalId, memberId: aliceMemberId }),
    bob: Object.freeze({ principalId: bob.principalId, memberId: bobMemberId }) });
}
export async function composeCanonicalCommentFileV28(owner: CanonicalFileFixtureOwner, lease: LinuxWriterLease,
  native: DatabaseSync, core: SqliteCapability, baseline: CanonicalCommentFileBaseline,
  features:Readonly<{canonicalSampleAttachments?:true}>={}) {
  const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
  const installation = assertInstallationAdmission(native, admission);
  expect(installation.installationId).toBe(baseline.installationId);
  const origin = await canonicalFilePrivateOrigin(owner), configurationPath = join(baseline.root, `runtime-${randomUUID()}.json`);
  await writeFile(configurationPath, JSON.stringify({ format: "node-loopback-development-v1", dataDirectory: baseline.dataDirectory,
    expectedInstallationId: baseline.installationId, publicOrigin: origin, clientDirectory: baseline.clientDirectory,
    localVolumes: baseline.descriptors, enableLocalFile: true, enableLocalJobs: false }), { flag: "wx", mode: 0o600 });
  const configuration = loadNodeRuntimeConfiguration(configurationPath, { filesystemRootOwnerUid: baseline.rootOwnerUid });
  owner.applicationAttempted = true;
  const original = owner.originalApplication = Promise.resolve().then(() => createGroupV28ApplicationCandidate({
    database: core, nativeDatabase: native, writerLease: lease, admission, hasher: createPasswordHasher(), identityPolicy: POLICY,
    publicOrigin: origin, sampleMetadataReads: true, canonicalCommentConfiguration: configuration,
    ...(features.canonicalSampleAttachments===true?{canonicalSampleAttachments:true as const}:{}),
    httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 },
  }));
  const application = owner.application = await original;
  await listenCanonicalFileApplication(owner, origin);
  return Object.freeze({ application, configuration, ...canonicalFileClient(owner, origin) });
}
export function currentCanonicalFileTarget(native: DatabaseSync, target: Readonly<{ sampleId: string; runId: string; stepId: string }>) {
  const row = native.prepare("SELECT updated_at FROM run_steps WHERE id=? AND run_id=? AND deleted_at IS NULL").get(target.stepId, target.runId);
  if (typeof row?.updated_at !== "string") throw new Error("Actual original current Step CAS is required");
  return Object.freeze({ ...target, expectedUpdatedAt: row.updated_at });
}
export function assertCanonicalFileOwnersReleased(): void {
  expect(owners.size).toBe(0); guardCanonicalFileReserve();
}

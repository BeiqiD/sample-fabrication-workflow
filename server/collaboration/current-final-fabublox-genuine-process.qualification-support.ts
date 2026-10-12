import { expect } from "vitest";
import JSZip from "jszip";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createInstalledLocalIdentity } from "../auth/identity";
import { createPasswordHasher } from "../auth/passwords";
import { createLocalAuthentication } from "../auth/local-auth-http";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate";
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog } from "../migrations";
import { executeCollaborationV28OperatorCandidate } from "../operations/collaboration-v28-operator-candidate";
import { executeDomainRootV28OperatorCandidate } from "../operations/collaboration-domain-roots-v28-candidate";
import { executeV28OrdinaryAccountOperatorCandidate } from "../operations/ordinary-account-v28-candidate";
import type { LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability } from "../sqlite";
import { createLocalVolumeProfileOpening, createLocalVolumeProfileOpeningV28, captureLocalVolumeProfileAuthority,
  createLocalVolumeFileAuthorityDatabase, prepareLocalVolumeProfileAuthorityFence } from "../storage/local-volume-profile-opening";
import { createLocalVolumeProfileLifecycle } from "../storage/local-volume-profile-lifecycle";
import { createOfflineLocalFileInitialization } from "../storage/local-file-initialization";
import { canonicalLocalVolumeNamespace } from "../../shared/contracts/local-volume-profile";
import { stableJson } from "../../shared/content-addressing";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import { loadNodeRuntimeConfiguration, type NodeConfiguredLocalVolumeDescriptor } from "../node-runtime-config";
import { createGroupV28ApplicationCandidate } from "./group-v28-application-candidate";
import { CANONICAL_FILE_PASSWORD, CANONICAL_FILE_IDENTITY_POLICY, canonicalFileObject,
  canonicalFilePrivateOrigin, fetchCanonicalFileClient, consumeCanonicalFileClient,
  guardCanonicalFileReserve, withCanonicalFileDatabase, type CanonicalFileFixtureOwner,
  type CanonicalFileSession } from "./current-v28-canonical-comment-file.qualification-support";

export interface GenuineFabubloxBaseline {
  readonly root: string; readonly dataDirectory: string; readonly clientDirectory: string; readonly path: string;
  readonly rootOwnerUid: number; readonly installationId: string; readonly operatorActor: string;
  readonly principalId: string; readonly memberId: string; readonly bobMemberId: string;
  readonly descriptors: readonly Readonly<NodeConfiguredLocalVolumeDescriptor>[];
  readonly internalProfileId: string; readonly originalsProfileId: string;
}
const password = CANONICAL_FILE_PASSWORD, policy = CANONICAL_FILE_IDENTITY_POLICY;
function genuineInputs() {
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT, pin = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID;
  if (!parent || !isAbsolute(parent) || resolve(parent) !== parent || !pin || !/^(?:0|[1-9][0-9]*)$/.test(pin)
    || !Number.isSafeInteger(Number(pin)) || Number(pin) > 0xffff_ffff) throw new Error("Original admitted private fixture inputs required");
  guardCanonicalFileReserve(); return Object.freeze({ parent, rootOwnerUid: Number(pin) });
}

/** Setup has its own retained beforeAll. No V26 Sample/Template/Run baseline is
 * reused: all business rows below are created only by the later real V28 HTTP.
 * Reviewed installation is fixture bootstrap only, never domain SQL seeding. */
export async function prepareGenuineFabubloxBaseline(): Promise<GenuineFabubloxBaseline> {
  const { parent, rootOwnerUid } = genuineInputs();
  const root = await mkdtemp(join(parent, ".current-final-fabublox-process-")); await chmod(root, 0o700);
  console.info("Retained genuine final Fabu Process fixture:", root);
  const dataDirectory = join(root, "data"), clientDirectory = join(root, "client");
  await mkdir(dataDirectory, { mode: 0o700 }); await mkdir(clientDirectory, { mode: 0o700 });
  await writeFile(join(clientDirectory, "index.html"), "<!doctype html><title>Genuine API fixture</title>", { flag: "wx", mode: 0o600 });
  const path = join(dataDirectory, "application.sqlite"); await writeFile(path, "", { flag: "wx", mode: 0o600 });
  await writeFile(`${path}.writer-lock`, "", { flag: "wx", mode: 0o600 });
  let principalId: string | undefined, operatorActor: string | undefined, installationId: string | undefined;
  await withCanonicalFileDatabase(path, async (_owner, lease, native, core) => lease.withWriter(async () => {
    installReviewedSqliteCatalog(native, V26_NODE_INSTALLATION_CATALOG);
    const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
    installationId = assertInstallationAdmission(native, admission).installationId;
    const identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission,
      hasher: createPasswordHasher(), policy });
    const principal = await identity.offline(lease).bootstrap({ username: "operator", password, now: Date.now() });
    principalId = principal.id; operatorActor = principal.actor;
  }));
  if (!principalId || !operatorActor || !installationId) throw new Error("Actual bootstrap and all original first-close ACKs required");
  const capturedPrincipal = principalId, capturedActor = operatorActor, capturedInstallation = installationId;
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
      hasher: createPasswordHasher(), policy });
    const session = await lease.withWriter(() => identity.login({ username: "operator", password,
      sourceKey: "genuine-final-fabublox-original-profile-bootstrap", now: Date.now() }));
    owner.openingAttempted = true;
    const opening = owner.opening = createLocalVolumeProfileOpening({ database: core, nativeDatabase: native, admission,
      writerLease: lease, descriptors, filesystemRootOwnerUid: rootOwnerUid, async authorizeAdministrator(actor) {
        const actual = await identity.authenticate(session.token, Date.now());
        return actual?.actor === actor && actual.capabilities.systemAdministrator;
      } });
    const lifecycle = createLocalVolumeProfileLifecycle(opening);
    for (const volume of volumes) {
      const registration = await opening.register({ operationId: randomUUID(), volumeDescriptorId: volume.id }, capturedActor);
      expect(registration).toBeTruthy();
      const bound = await lifecycle.probeAndBind({ operationId: randomUUID(), checkId: randomUUID(), volumeDescriptorId: volume.id,
        access: "read_write", expectedBindingRevision: null }, capturedActor);
      expect(bound.storageProfileId).toBe(volume.profileId);
      const activated = await lifecycle.activate({ operationId: randomUUID(), volumeDescriptorId: volume.id,
        expectedBindingRevision: bound.bindingRevision }, capturedActor);
      expect(activated.bindingRevision).toBe(bound.bindingRevision);
    }
    // Original initializer requires its real fresh epoch; this is a setup
    // argument, never positive Sample/Run/grant/lock SQL proof.
    const epoch = configurationSqlInteger(native.prepare("SELECT epoch FROM file_shadow_control WHERE singleton=1").get()!.epoch, "Actual fresh fixture File epoch");
    await createOfflineLocalFileInitialization(opening).initialize({ requestId: randomUUID(), expectedEpoch: epoch,
      internalProfileId: volumes[0]!.profileId, originalsProfileId: volumes[1]!.profileId }, capturedActor);
    const first = owner.openingClose = opening.close(); expect(opening.close()).toBe(first); await first;
  });
  const base = { databasePath: path, filesystemRootOwnerUid: rootOwnerUid };
  await executeCollaborationV28OperatorCandidate({ ...base, kind: "upgrade-metadata" });
  const bob = await executeV28OrdinaryAccountOperatorCandidate({ ...base, kind: "provision-account", username: "bob" }, password);
  const member = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: capturedPrincipal,
    displayName: "Genuine Process operator member", workspaceRole: "membershipAdministrator", canCreateSamples: true, expectedControlRevision: 1 });
  const bobMember = await executeCollaborationV28OperatorCandidate({ ...base, kind: "enroll-local-member", principalId: bob.principalId,
    displayName: "Genuine Process no-grant member", workspaceRole: "member", canCreateSamples: false, expectedControlRevision: 1 });
  if (!member.memberId || !bobMember.memberId) throw new Error("Actual distinct mapped members required");
  await executeDomainRootV28OperatorCandidate({ ...base, kind: "set-creation-flags", principalId: capturedPrincipal,
    expectedMemberRevision: 1, expectedControlRevision: 1, canCreateSamples: true, canCreateProjects: false, canCreateTemplates: true });
  await executeCollaborationV28OperatorCandidate({ ...base, kind: "set-enforcement", enforcement: "enabled", expectedControlRevision: 1 });
  return Object.freeze({ root, dataDirectory, clientDirectory, path, rootOwnerUid, installationId: capturedInstallation,
    operatorActor: capturedActor, principalId: capturedPrincipal, memberId: member.memberId, bobMemberId: bobMember.memberId,
    descriptors: Object.freeze(descriptors), internalProfileId: volumes[0]!.profileId, originalsProfileId: volumes[1]!.profileId });
}

export async function composeGenuineFabubloxHost(owner: CanonicalFileFixtureOwner, lease: LinuxWriterLease,
  native: DatabaseSync, core: SqliteCapability, baseline: GenuineFabubloxBaseline) {
  const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
  expect(assertInstallationAdmission(native, admission).installationId).toBe(baseline.installationId);
  const origin = await canonicalFilePrivateOrigin(owner), configurationPath = join(baseline.root, `runtime-${randomUUID()}.json`);
  await writeFile(configurationPath, JSON.stringify({ format: "node-loopback-development-v1", dataDirectory: baseline.dataDirectory,
    expectedInstallationId: baseline.installationId, publicOrigin: origin, clientDirectory: baseline.clientDirectory,
    localVolumes: baseline.descriptors, enableLocalFile: true, enableLocalJobs: false }), { flag: "wx", mode: 0o600 });
  const configuration = loadNodeRuntimeConfiguration(configurationPath, { filesystemRootOwnerUid: baseline.rootOwnerUid });
  owner.applicationAttempted = true;
  owner.originalApplication = Promise.resolve().then(() => createGroupV28ApplicationCandidate({ database: core, nativeDatabase: native,
    writerLease: lease, admission, hasher: createPasswordHasher(), identityPolicy: policy, publicOrigin: origin,
    fabubloxConfiguration: configuration, httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 } }));
  const application = owner.application = await owner.originalApplication;
  await new Promise<void>((yes, no) => {
    application.server.once("error", no); application.server.listen(Number(new URL(origin).port), "127.0.0.1", () => {
      application.server.off("error", no); yes();
    });
  });
  async function request(path: string, method = "GET", value?: unknown, session?: CanonicalFileSession) {
    const original = await fetchCanonicalFileClient(owner, `${origin}${path}`, { method, headers: {
      ...(session ? { cookie: session.cookie } : {}), ...(method === "GET" ? {} : { origin, "content-type": "application/json",
        ...(session ? { "x-sfw-csrf": session.csrf } : {}) }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(5000), redirect: "manual" });
    const text = await consumeCanonicalFileClient(original.client, "text") as string;
    return { status: original.response.status, headers: original.response.headers, value: text ? JSON.parse(text) as unknown : null };
  }
  async function login(username: "operator" | "bob"): Promise<CanonicalFileSession> {
    const answer = await request("/api/auth/login", "POST", { username, password }); expect(answer.status).toBe(200);
    const cookie = answer.headers.get("set-cookie")?.split(";", 1)[0], csrf = canonicalFileObject(answer.value).csrf;
    if (!cookie?.startsWith("sfw_dev_session=") || typeof csrf !== "string") throw new Error("Actual delivered HTTP session required");
    return Object.freeze({ cookie, csrf });
  }
  function importRequest(fixture: GenuineWorkbook, requestId: string, session: CanonicalFileSession, manifest = fixture.manifest) {
    return fetchCanonicalFileClient(owner, `${origin}/api/imports/fabublox`, { method: "POST", headers: {
      cookie: session.cookie, origin, "x-sfw-csrf": session.csrf, "X-Import-Request-Id": requestId }, body: workbookForm(fixture, manifest),
      signal: AbortSignal.timeout(5000), redirect: "manual" });
  }
  return Object.freeze({ application, origin, request, login, importRequest });
}

export interface GenuineWorkbook { readonly workbook: File; readonly manifest: Record<string, unknown>; readonly workbookSha256: string; readonly manifestSha256: string }
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export async function genuineWorkbook(): Promise<GenuineWorkbook> {
  const title = `Genuine Process ${randomUUID().slice(0, 8)}`, filename = `genuine-process-${randomUUID()}.xlsx`;
  const rows = [["Step #", "Step Name", "Tool Name", "Parameters", "Comments", "Layer Stacks"],
    ["0", "Substrate Stack", "Fixture holder", "Silicon / oxide", "Initial substrate", ""],
    ["1", "Inspection", "Fixture microscope", "10x", "Lawful single-step process", ""]];
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(title)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((cell, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${xml(cell)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`);
  const bytes = Uint8Array.from(await zip.generateAsync({ type: "uint8array" }));
  const workbook = new File([bytes.buffer], filename, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const workbookSha256 = createHash("sha256").update(bytes).digest("hex");
  const rawCells = (row: string[]) => Object.fromEntries(rows[0]!.slice(0, 5).map((key, i) => [key, row[i]!]));
  const manifest = { schemaVersion: 2, title, recipeFamilyId: null,
    source: { fileName: filename, fileSha256: workbookSha256, sheetName: title }, detected: { headerRow: 1, layerStackColumn: 5 }, sections: [],
    initialSubstrateStep: { localId: "step-1", sourceRow: 2, position: 0, stepNumber: "0", sectionName: null, name: rows[1]![1],
      toolName: rows[1]![2], parametersText: rows[1]![3], commentsText: rows[1]![4], imageIds: [], rawCells: rawCells(rows[1]!) },
    steps: [{ localId: "step-2", sourceRow: 3, position: 0, stepNumber: "1", sectionName: null, name: rows[2]![1],
      toolName: rows[2]![2], parametersText: rows[2]![3], commentsText: rows[2]![4], imageIds: [], rawCells: rawCells(rows[2]!) }],
    images: [], initialStateImageIds: [], unassignedImageIds: [], warnings: [{ code: "initial_substrate_missing_diagram",
      message: "Step 0: Substrate Stack was detected, but no diagram was found on its row.", sourceRow: 2 }] };
  // The original server stores stableJson(manifest), not the raw multipart
  // JSON text. Expected backend bytes follow that unchanged canonicalizer.
  return Object.freeze({ workbook, manifest, workbookSha256, manifestSha256: createHash("sha256").update(stableJson(manifest)).digest("hex") });
}
export function workbookForm(fixture: GenuineWorkbook, manifest: Record<string, unknown> = fixture.manifest): FormData {
  const form = new FormData(); form.append("workbook", fixture.workbook);
  form.append("manifest", new File([JSON.stringify(manifest)], "manifest.json", { type: "application/json" })); return form;
}

/** Trusted private fixture byte inspection proves actual backend bytes only.
 * It is not an HTTP File grant, raw SQL positive authority or provider seed. */
export async function originalObjectInventory(baseline: GenuineFabubloxBaseline, index: 0 | 1) {
  const root = join(baseline.descriptors[index]!.root, "objects"), entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function visit(path: string, prefix: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = join(path, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(next, relative);
      else if (entry.isFile()) { const bytes = await readFile(next); entries.push({ path: relative, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }); }
      else throw new Error("Original fixture object ancestry changed");
    }
  }
  await visit(root, ""); return entries;
}

export async function retireGenuineProfile(baseline: GenuineFabubloxBaseline, index: 0 | 1) {
  await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
    const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
    const identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission, hasher: createPasswordHasher(), policy });
    const session = await lease.withWriter(() => identity.login({ username: "operator", password,
      sourceKey: `genuine-final-fabublox-retire-${index}`, now: Date.now() }));
    const origin = await canonicalFilePrivateOrigin(owner);
    const transport = createLoopbackLocalAuthTransport({ publicOrigin: origin });
    const authentication = createLocalAuthentication({ identity, transport, now: Date.now });
    owner.openingAttempted = true;
    const opening = owner.opening = createLocalVolumeProfileOpeningV28({ database: core, nativeDatabase: native, admission,
      writerLease: lease, authentication, descriptors: baseline.descriptors, filesystemRootOwnerUid: baseline.rootOwnerUid,
      async authorizeAdministrator(actor) {
        const actual = await identity.authenticate(session.token, Date.now());
        return actual?.actor === actor && actual.capabilities.systemAdministrator;
      } });
    const profileId = index === 0 ? baseline.internalProfileId : baseline.originalsProfileId;
    const captured = captureLocalVolumeProfileAuthority(opening, { profileId, configurationRevision: 1 }, "read");
    const view = createLocalVolumeFileAuthorityDatabase(opening, [captured]);
    const originalNativeFence = view.nativeStatement(prepareLocalVolumeProfileAuthorityFence(captured, view));
    const installation = assertInstallationAdmission(native, admission);
    // This narrow Native fixture admits only its actual installed owner. It is
    // not a Request/family/File-body success grant or Process positive proof.
    const originalAdmission = createSqliteBatchAdmission(core, [{ statement: core.prepare(`SELECT 1 admitted
      FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?`)
      .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt),
      rejection: new Error("Original genuine Native fixture installation changed") }]);
    const receipt = await createLocalVolumeProfileLifecycle(opening).retire({ operationId: randomUUID(),
      volumeDescriptorId: baseline.descriptors[index]!.id, expectedBindingRevision: 1 }, baseline.operatorActor);
    expect(receipt.storageProfileId).toBe(profileId);
    // The genuine profile statement was issued before the actual audited
    // retirement. It must raise INSIDE this original admitted BEGIN, before
    // the ordinary suffix can ACK. A zero-row ordinary SELECT would pass and
    // make this assertion fail, detecting the former AF1 class of regression.
    await expect(lease.withWriter(() => runSqliteAdmittedBatch(core,
      [originalNativeFence, core.prepare("SELECT 'original suffix must not acknowledge' value")], originalAdmission))).rejects.toThrow();
    expect(native.isOpen).toBe(true);
    const first = owner.openingClose = opening.close(); expect(opening.close()).toBe(first); await first;
  });
}

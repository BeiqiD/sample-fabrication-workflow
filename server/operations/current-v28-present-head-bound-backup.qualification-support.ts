import { expect } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { createNodeDevelopmentPrototype } from "../node-application.ts";
import { createInstalledLocalIdentity } from "../auth/identity.ts";
import { createPasswordHasher } from "../auth/passwords.ts";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26.ts";
import { admitInstallationRecoverySource, assertInstallationAdmission, installReviewedSqliteCatalog } from "../migrations.ts";
import { createLocalVolumeProfileOpening } from "../storage/local-volume-profile-opening.ts";
import { createLocalVolumeProfileLifecycle } from "../storage/local-volume-profile-lifecycle.ts";
import { createOfflineLocalFileInitialization } from "../storage/local-file-initialization.ts";
import { canonicalLocalVolumeNamespace } from "../../shared/contracts/local-volume-profile.ts";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql.ts";
import type { NodeConfiguredLocalVolumeDescriptor } from "../node-runtime-config.ts";
import type { GenuineLocalFileV26Baseline } from "../collaboration/current-final-fabublox-genuine-process.qualification-support.ts";
import { CANONICAL_FILE_PASSWORD, CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased,
  canonicalFileObject, canonicalFileClient, canonicalFilePrivateOrigin, listenCanonicalFileApplication,
  guardCanonicalFileReserve, withCanonicalFileDatabase } from "../collaboration/current-v28-canonical-comment-file.qualification-support.ts";

export interface PresentHeadPublicV26Baseline extends GenuineLocalFileV26Baseline {
  readonly target: Readonly<{ sampleId: string; runId: string; stepId: string; templateId: string }>;
}
const password = CANONICAL_FILE_PASSWORD, policy = CANONICAL_FILE_IDENTITY_POLICY;
function originalInputs() {
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT, pin = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID;
  if (!parent || !isAbsolute(parent) || resolve(parent) !== parent || !pin || !/^(?:0|[1-9][0-9]*)$/.test(pin)
    || !Number.isSafeInteger(Number(pin)) || Number(pin) > 0xffff_ffff) throw new Error("Original admitted private fixture inputs required");
  guardCanonicalFileReserve(); return Object.freeze({ parent, rootOwnerUid: Number(pin) });
}

/** Finite fresh reviewed/bootstrap setup, genuine public legacy metadata, and
 * original typed LOCAL profile initialization in the truthful phase order.
 * Every database/application/opening uses the existing retained original owner;
 * no File/shadow/business/session/grant/control row is seeded as proof. */
export async function preparePresentHeadPublicV26Baseline(): Promise<PresentHeadPublicV26Baseline> {
  const { parent, rootOwnerUid } = originalInputs();
  const root = await mkdtemp(join(parent, ".current-present-head-public-source-")); await chmod(root, 0o700);
  console.info("Retained genuine public Run Step source fixture:", root);
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
  // Metadata creation belongs to the original legacy-mode public surface.
  // It must ACK and the whole original application must close before LOCAL
  // initialization activates File and the later original File route is used.
  const target = await withCanonicalFileDatabase(path, async (owner, lease, native, core) => {
    expect(native.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").get()?.mode).toBe("legacy");
    const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
    const origin = await canonicalFilePrivateOrigin(owner);
    owner.applicationAttempted = true;
    owner.originalApplication = Promise.resolve().then(() => createNodeDevelopmentPrototype({
      database: core, nativeDatabase: native, writerLease: lease, admission, hasher: createPasswordHasher(),
      identityPolicy: policy, publicOrigin: origin, now: Date.now, clientDirectory,
      httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 },
    }));
    owner.application = await owner.originalApplication;
    await listenCanonicalFileApplication(owner, origin);
    const client = canonicalFileClient(owner, origin), session = await client.login("operator");
    const template = await client.request("/api/metrology-templates", "POST", { name: "Genuine present-head instrument",
      toolName: "Original retained instrument", parametersText: "Public original parameters", commentsText: "Public original method" }, session);
    expect(template.status).toBe(201); const templateId = canonicalFileObject(template.value).id;
    if (typeof templateId !== "string") throw new Error("Original public Template id required");
    const sample = await client.request("/api/samples", "POST", { code: "PRESENT-HEAD-SOURCE", title: "Genuine Run Step source" }, session);
    expect(sample.status).toBe(201); const sampleId = canonicalFileObject(sample.value).id;
    if (typeof sampleId !== "string") throw new Error("Original public Sample id required");
    const run = await client.request(`/api/samples/${sampleId}/metrology-runs`, "POST", { templateVersionId: templateId }, session);
    expect(run.status).toBe(201); const runId = canonicalFileObject(run.value).id;
    if (typeof runId !== "string") throw new Error("Original public Run id required");
    const step = native.prepare("SELECT id FROM run_steps WHERE run_id=? AND deleted_at IS NULL ORDER BY position").get(runId);
    if (typeof step?.id !== "string") throw new Error("Original public-created Step id required");
    expect(native.prepare("SELECT count(*) n FROM assets").get()?.n).toBe(0);
    expect(native.prepare("SELECT count(*) n FROM files").get()?.n).toBe(0);
    expect(native.prepare("SELECT count(*) n FROM file_shadow_heads WHERE present=1").get()?.n).toBe(0);
    return Object.freeze({ sampleId, runId, stepId: step.id, templateId });
  });
  assertCanonicalFileOwnersReleased();
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
  return Object.freeze({ root, dataDirectory, clientDirectory, path, rootOwnerUid, installationId: capturedInstallation,
    operatorActor: capturedActor, principalId: capturedPrincipal, descriptors: Object.freeze(descriptors),
    internalProfileId: volumes[0]!.profileId, originalsProfileId: volumes[1]!.profileId, target });
}


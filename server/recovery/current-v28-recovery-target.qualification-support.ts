import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import { loadNodeRuntimeConfiguration, type NodeConfiguredRecoveryTarget } from "../node-runtime-config.ts";
import { createPasswordHasher } from "../auth/passwords.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource } from "../migrations.ts";
import { CANONICAL_FILE_IDENTITY_POLICY, canonicalFileClient, canonicalFilePrivateOrigin,
  listenCanonicalFileApplication, withCanonicalFileDatabase } from "../collaboration/current-v28-canonical-comment-file.qualification-support.ts";
import { createNodeSystemRecoveryV28Application, type NodeSystemRecoveryV28Application } from "./node-system-recovery-v28-application.ts";
import type { CurrentV28OnlineRecoverySource } from "./current-v28-online-recovery.qualification-support.ts";
import { launchCurrentRecoveryCli, closeCurrentRecoveryCli, type CurrentRecoveryCliOwner } from "./current-v28-recovery-cli.qualification-support.ts";

/** Provision only private operator-owned filesystem configuration. No source
 * account, grant, fence, executor, job, binding or ledger row is seeded here. */
export async function prepareCurrentRecoveryTarget(source: CurrentV28OnlineRecoverySource) {
  const descriptor: Readonly<NodeConfiguredRecoveryTarget> = Object.freeze({ parent: join(source.baseline.root, "fresh-inert-recovery-targets"),
    rootBindingId: randomUUID(), targetId: randomUUID() });
  await mkdir(descriptor.parent, { mode: 0o700 });
  await writeFile(join(descriptor.parent, "namespace.json"), stableJson({ format: "node-v28-recovery-target-parent/1",
    sourceInstallationId: source.baseline.installationId, rootBindingId: descriptor.rootBindingId }), { flag: "wx", mode: 0o600 });
  const destination = join(descriptor.parent, descriptor.targetId);
  async function configuration(origin: string): Promise<string> {
    const originalPath = await source.writeRecoveryConfiguration(origin);
    const original: unknown = JSON.parse(await readFile(originalPath, "utf8"));
    if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error("Original source configuration required");
    const path = join(source.baseline.root, `online-recovery-target-runtime-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify({ ...original, recoveryTarget: descriptor }), { flag: "wx", mode: 0o600 }); return path;
  }
  async function withCli<T>(distribution: string, origin: string, work: (owner: CurrentRecoveryCliOwner) => Promise<T>): Promise<T> {
    const path = await configuration(origin), owner = launchCurrentRecoveryCli(distribution, path, source.baseline.rootOwnerUid);
    let failed = false, failure: unknown, result!: T;
    try { await owner.ready; result = await work(owner); } catch (error) { failed = true; failure = error; }
    try { await closeCurrentRecoveryCli(owner); } catch (cleanup) {
      throw failed ? new AggregateError([failure, cleanup], "Original target CLI and first close failed") : cleanup;
    }
    if (failed) throw failure; return result;
  }
  async function withDispatcher<T>(work: (app: NodeSystemRecoveryV28Application,
    client: ReturnType<typeof canonicalFileClient>, native: import("node:sqlite").DatabaseSync) => Promise<T>): Promise<T> {
    return withCanonicalFileDatabase(source.baseline.path, async (owner, lease, native, core) => {
      const origin = await canonicalFilePrivateOrigin(owner), path = await configuration(origin);
      const token = loadNodeRuntimeConfiguration(path, { filesystemRootOwnerUid: source.baseline.rootOwnerUid, runtimeProfile: "v28-recovery" });
      owner.applicationAttempted = true;
      const original = Promise.resolve().then(() => createNodeSystemRecoveryV28Application({ configuration: token, database: core,
        nativeDatabase: native, writerLease: lease, admission: admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE),
        hasher: createPasswordHasher(), identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, publicOrigin: origin }));
      owner.originalApplication = original; const app = await original; owner.application = app;
      await listenCanonicalFileApplication(owner, origin);
      return work(app, canonicalFileClient(owner, origin), native);
    });
  }
  return Object.freeze({ descriptor, destination, configuration, withCli, withDispatcher });
}

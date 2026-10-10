import { primaryD1 } from "../d1-primary";
import { managedStorage } from "../managed-storage";
import type { Env } from "../types";
import type { ByteReader } from "./byte-reader";
import type { ByteWriter } from "./byte-writer";
import type { ByteDeleter } from "./byte-deleter";
import { assertManagedBootstrapProfile } from "./managed-bootstrap-profile";
import { assertR2BootstrapProfile } from "./r2-bootstrap-profile";
import { resolveR2ProfileBinding, r2ProfileBindingStillCurrent, type ResolvedR2ProfileBinding } from "./r2-profile-bindings";
import { cloudflareSha256 } from "./storage-adapters/cloudflare-sha256";
import { managedByteReader } from "./storage-adapters/managed-reader";
import { managedByteWriter } from "./storage-adapters/managed-writer";
import { managedByteDeleter } from "./storage-adapters/managed-deleter";
import { r2ByteReader } from "./storage-adapters/r2-reader";
import { r2ShadowByteWriter } from "./storage-adapters/r2-shadow-writer";
import { r2ByteDeleter } from "./storage-adapters/r2-deleter";
import { nativeS3ByteReader } from "../storage/native-s3-byte-reader";
import { assertNativeS3StorageAvailable, nativeS3ByteStorage } from "../storage/native-s3-byte-storage";
import { ByteVerificationError } from "./byte-verification";
import type { S3RequestOperation } from "../storage/s3-byte-adapter";
import { d1FileJobDatabase } from "./jobs/d1-repository";
import { openStorageProfile, type FrozenStorageProfile, type StorageProfileLifecycle } from "./storage-profile-opening";
export { ShadowProfileUnavailableError } from "./storage-profile-opening";

export type FrozenShadowProfile = FrozenStorageProfile;
export type ShadowProfileLifecycle = StorageProfileLifecycle;
type BoundStorage = FrozenShadowProfile & { adapterType: "r2" | "switchdrive" | "s3"; namespaceIdentity: string };
const MANAGED_BINDINGS = ["MANAGED_STORAGE_PROVIDER", "SWITCHDRIVE_WEBDAV_URL", "SWITCHDRIVE_USERNAME",
  "SWITCHDRIVE_APP_PASSWORD", "SWITCHDRIVE_ROOT"] as const;

function abortableBody(body: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  if (!signal) return body;
  const reader = body.getReader();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const release = () => { if (!closed) { closed = true; signal.removeEventListener("abort", abort); } };
  const abort = () => {
    if (closed) return;
    release();
    controller.error(new Error("File read was interrupted"));
    void reader.cancel().catch(() => undefined).finally(() => reader.releaseLock());
  };
  return new ReadableStream<Uint8Array>({
    start(value) { controller = value; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(value) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) { release(); reader.releaseLock(); value.close(); }
        else value.enqueue(next.value);
      } catch { if (!closed) { release(); reader.releaseLock(); value.error(new Error("File read was interrupted")); } }
    },
    async cancel(reason) { if (!closed) { release(); try { await reader.cancel(reason); } finally { reader.releaseLock(); } } },
  });
}

/** Resolve only an exact, already registered physical namespace. This function
 * never creates a profile, changes its access state, chooses a role default, or
 * uses a request-supplied URL/credential. The caller still owns the database
 * lease, generation check and lifecycle fence surrounding provider I/O. */
export async function openShadowProfile(
  env: Env,
  frozen: FrozenShadowProfile,
  access: "read" | "write",
  lifecycle: ShadowProfileLifecycle = {},
): Promise<{
  storage: BoundStorage;
  reader: ByteReader;
  writer?: ByteWriter;
  deleter?: ByteDeleter;
  createHash: typeof cloudflareSha256;
}> {
  const captured = { ...env };
  return openStorageProfile<"r2" | "switchdrive" | "s3">({
    database: d1FileJobDatabase(captured.DB),
    isCurrent: () => env.DB === captured.DB,
    async openProvider(profile, providerAccess, providerLifecycle) {
      const target = { profileId: profile.profileId, configurationRevision: profile.configurationRevision };
      const row = { adapter_type: profile.adapterType, namespace_identity: profile.namespaceIdentity, state: profile.runtimeState };
      const access = providerAccess, callerFence = providerLifecycle.beforeRequest;
      let r2Binding: ResolvedR2ProfileBinding | undefined;
      const db = primaryD1(captured.DB);
      const legacyFence = async (storage: BoundStorage, operation: S3RequestOperation) => {
        if (operation.method === "DELETE") {
          const writable = await primaryD1(captured.DB).prepare(`SELECT 1 AS writable FROM storage_profiles p
            JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id
            WHERE p.id=? AND p.adapter_type=? AND p.namespace_identity=? AND p.configuration_revision=?
              AND p.configuration_source=? AND p.credential_reference IS ? AND p.state='historical'
              AND runtime.state='read_write' AND runtime.registered_at=p.created_at
              AND runtime.activated_at IS NOT NULL AND runtime.retired_at IS NULL`)
            .bind(storage.profileId, storage.adapterType, storage.namespaceIdentity, storage.configurationRevision,
              storage.adapterType === "r2" ? "bootstrap" : "environment", storage.adapterType === "r2" ? null : "environment:SWITCHDRIVE").first();
          if (!writable) return false;
        }
        if (!await callerFence(operation)) return false;
        const bound = await primaryD1(captured.DB).prepare(`SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
          WHERE p.id=? AND p.adapter_type=? AND p.namespace_identity=? AND p.configuration_revision=? AND p.state='historical'
            AND p.configuration_source=? AND p.credential_reference IS ? AND r.state IN('read_only','read_write')
            AND (?='read' OR r.state='read_write') AND r.registered_at=p.created_at AND r.retired_at IS NULL`)
          .bind(storage.profileId, storage.adapterType, storage.namespaceIdentity, storage.configurationRevision,
            storage.adapterType === "r2" ? "bootstrap" : "environment", storage.adapterType === "r2" ? null : "environment:SWITCHDRIVE", access).first();
        const sameBinding = storage.adapterType === "r2"
          ? Boolean(r2Binding && r2ProfileBindingStillCurrent(env, r2Binding))
          : MANAGED_BINDINGS.every(key => env[key] === captured[key]);
        return Boolean(bound) && sameBinding && !providerLifecycle.signal?.aborted && env.DB === captured.DB;
      };
      if (row.adapter_type === "s3") {
        const storage: BoundStorage = Object.freeze({ ...target, adapterType: "s3", namespaceIdentity: row.namespace_identity });
        const options = { signal: providerLifecycle.signal, beforeRequest: callerFence };
        if (row.state === "read_only" && access === "read") return { storage, reader: nativeS3ByteReader(env, target, options), createHash: cloudflareSha256 };
        await assertNativeS3StorageAvailable(env, target, access);
        const transport = nativeS3ByteStorage(env, target, access, options);
        return { storage, reader: transport.reader,
          ...(access === "write" ? { writer: transport.writer, deleter: transport.deleter } : {}), createHash: cloudflareSha256 };
      }
      if (row.adapter_type === "r2") {
        const profile = await assertR2BootstrapProfile(db, captured, target.profileId, target.configurationRevision);
        r2Binding = resolveR2ProfileBinding(captured, profile, { allowLegacyBootstrap: true });
        const storage: BoundStorage = Object.freeze({ ...target, adapterType: "r2", namespaceIdentity: profile.namespaceIdentity });
        const reader = r2ByteReader(r2Binding.bucket), writer = r2ShadowByteWriter(r2Binding.bucket), deleter = r2ByteDeleter(r2Binding.bucket);
        const boundWriter: ByteWriter = { accepts: writer.accepts, async write(input) {
          let permitted = false;
          try { permitted = await legacyFence(storage, Object.freeze({ method: "PUT", key: input.key })); } catch { /* sanitized below */ }
          if (!permitted) throw new ByteVerificationError("destination", "unavailable");
          return writer.write(input);
        } };
        const boundDeleter: ByteDeleter = { async delete(key) {
          try { return await legacyFence(storage, Object.freeze({ method: "DELETE", key })) ? await deleter.delete(key) : { outcome: "unavailable" }; }
          catch { return { outcome: "unavailable" }; }
        } };
        return { storage,
          reader: {
            async read(key) {
              try {
                if (!await legacyFence(storage, Object.freeze({ method: "GET", key }))) return { outcome: "unavailable" };
                const result = await reader.read(key);
                if (result.outcome !== "available") return result;
                return { ...result, body: abortableBody(result.body, providerLifecycle.signal) };
              } catch { return { outcome: "unavailable" }; }
            },
            async stat(key) { try { return await legacyFence(storage, Object.freeze({ method: "HEAD", key })) ? await reader.stat(key) : { outcome: "unavailable" }; } catch { return { outcome: "unavailable" }; } },
          },
          ...(access === "write" ? { writer: boundWriter, deleter: boundDeleter } : {}),
          createHash: cloudflareSha256 };
      }
      if (row.adapter_type === "switchdrive") {
        const profile = await assertManagedBootstrapProfile(db, captured, target.profileId, target.configurationRevision);
        const storage: BoundStorage = Object.freeze({ ...target, adapterType: "switchdrive", namespaceIdentity: profile.namespaceIdentity });
        const provider = managedStorage(captured, { signal: providerLifecycle.signal, beforeRequest: operation => legacyFence(storage, operation) });
        if (!provider || provider.provider !== "switchdrive") throw new Error();
        return { storage,
          reader: managedByteReader(provider),
          ...(access === "write" ? { writer: managedByteWriter(provider),
            deleter: managedByteDeleter(provider) } : {}),
          createHash: cloudflareSha256 };
      }
      throw new Error();
    },
  }, frozen, access, lifecycle);
}

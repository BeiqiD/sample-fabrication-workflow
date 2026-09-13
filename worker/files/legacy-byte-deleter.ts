import { managedStorage } from "../managed-storage";
import type { BlobLocator } from "../blob-lifecycle/types";
import type { Env } from "../types";
import { ByteDeletionError, type ByteDeleter } from "./byte-deleter";
import { managedByteDeleter } from "./storage-adapters/managed-deleter";
import { r2ByteDeleter } from "./storage-adapters/r2-deleter";

/** Runtime-only composition for historical locators. Provider identity is
 * checked before accessing a binding; no defaults or File profiles are inferred.
 */
export function legacyByteDeleter(
  env: Env,
  locator: Pick<BlobLocator, "storeKind" | "provider">,
): ByteDeleter {
  if (!((locator.storeKind === "r2" && locator.provider === "r2")
    || (locator.storeKind === "managed" && locator.provider === "switchdrive"))) {
    throw new ByteDeletionError("invalid_locator");
  }
  try {
    if (locator.storeKind === "r2") return r2ByteDeleter(env.ASSETS);
    const storage = managedStorage(env);
    if (storage?.provider === locator.provider) return managedByteDeleter(storage);
  } catch {
    // Configuration and provider details cannot escape into the GC ledger.
  }
  throw new ByteDeletionError("unavailable");
}

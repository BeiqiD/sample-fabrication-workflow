import { managedStorage } from "../managed-storage";
import type { BlobLocator } from "../blob-lifecycle/types";
import type { Env } from "../types";
import type { ByteReader } from "./byte-reader";
import { managedByteReader } from "./storage-adapters/managed-reader";
import { r2ByteReader } from "./storage-adapters/r2-reader";

type ReaderSelection = { outcome: "selected"; reader: ByteReader }
  | { outcome: "provider_unavailable"; message: string };

/** Runtime-only bridge for the two historical singleton locators.
 * No File/Profile row is synthesized or promoted. This is not a resolver for
 * arbitrary profile IDs: future profile selection must establish its namespace
 * and configuration revision before supplying an adapter's concrete instance.
 */
export function legacyByteReader(
  env: Env,
  locator: Pick<BlobLocator, "storeKind" | "provider">,
): ReaderSelection {
  if (locator.storeKind === "r2") {
    if (locator.provider !== "r2") {
      return { outcome: "provider_unavailable", message: "File storage locator is invalid" };
    }
    return { outcome: "selected", reader: r2ByteReader(env.ASSETS) };
  }
  if (locator.storeKind !== "managed" || locator.provider !== "switchdrive") {
    return { outcome: "provider_unavailable", message: "File storage locator is invalid" };
  }
  try {
    const storage = managedStorage(env);
    if (!storage || storage.provider !== locator.provider) {
      return { outcome: "provider_unavailable", message: "Managed storage is not configured" };
    }
    return { outcome: "selected", reader: managedByteReader(storage) };
  } catch {
    return { outcome: "provider_unavailable", message: "Managed storage is unavailable" };
  }
}

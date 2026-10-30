import type { FrozenStorageProfile, OpenedStorageProfile, StorageProfileLifecycle } from "./storage-profile-opening";

/** Internal File service seam. Trusted composers bind the existing genuine
 * CF opener or the issued Node opening capabilities; this function is not a
 * provider registration, namespace proof, or source of business authority. */
export type AuthorityProfileOpener = (profile: FrozenStorageProfile, access: "read" | "write",
  lifecycle: StorageProfileLifecycle) => Promise<OpenedStorageProfile<string>>;

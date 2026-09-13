import type { ManagedStorage } from "../../managed-storage";
import { SwitchdriveAuthenticationError } from "../../switchdrive-storage";
import type { ByteDeleter } from "../byte-deleter";

/** The current managed contract completes only on HTTP 200/204/404. Redirects,
 * asynchronous acceptance and multi-status responses are not completed deletes.
 * Future providers must qualify this semantic contract before using the adapter.
 */
export function managedByteDeleter(storage: Pick<ManagedStorage, "delete">): ByteDeleter {
  return {
    async delete(key) {
      try {
        await storage.delete(key);
        return { outcome: "acknowledged" };
      } catch (error) {
        return error instanceof SwitchdriveAuthenticationError
          ? { outcome: "denied", status: error.status }
          : { outcome: "unavailable" };
      }
    },
  };
}

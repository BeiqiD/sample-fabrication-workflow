/** Deletion transport for one already-bound storage instance and exact key.
 * The caller owns authorization and the durable deletion claim. An acknowledged
 * result means the adapter's completed-delete contract (including already absent),
 * not merely asynchronous acceptance. It does not prove that a prior uncertain
 * request has stopped, grant key reuse, or provide a provider version fence.
 * No retries, stat/read probes, fallback, SQL or retention decisions occur here.
 */
export type ByteDeleteResult =
  | { outcome: "acknowledged" }
  | { outcome: "denied"; status: 401 | 403 }
  | { outcome: "unavailable" };

export interface ByteDeleter {
  delete(key: string): Promise<ByteDeleteResult>;
}

export type ByteDeletionFailure = "invalid_locator" | "denied" | "unavailable";
const MESSAGES: Record<ByteDeletionFailure, string> = {
  invalid_locator: "File storage locator is invalid",
  denied: "File storage deletion was denied",
  unavailable: "File storage deletion is unavailable",
};

/** Safe compatibility error; never retains provider exceptions or credentials. */
export class ByteDeletionError extends Error {
  constructor(readonly reason: ByteDeletionFailure) {
    super(MESSAGES[reason]);
    this.name = "ByteDeletionError";
  }
}

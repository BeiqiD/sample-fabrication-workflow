import { afterEach } from "vitest";
import { request as httpRequest, type ClientRequest } from "node:http";
import { Buffer } from "node:buffer";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AcceptFileMigrationInput } from "../../shared/contracts/file-jobs";

interface ObservedLease {
  readonly id: string;
  readonly generation: number;
  readonly owner: string;
}
interface RawResponse {
  readonly status: number;
  readonly body: string;
}
interface ObserverOwner {
  readonly native: DatabaseSync;
  readonly originalExec: DatabaseSync["exec"];
  readonly originalPrepare: DatabaseSync["prepare"];
  readonly selectedRuns: Map<StatementSync, StatementSync["run"]>;
  readonly originalRead: ReadableStreamDefaultReader<Uint8Array>["read"];
  readonly reads: Set<Readonly<{ original: Promise<ReadableStreamReadResult<Uint8Array>>; wrapped: Promise<ReadableStreamReadResult<Uint8Array>> }>>;
  selectedReader?: ReadableStreamDefaultReader<Uint8Array>;
  originalReadSettled: boolean;
  originalReadResultReturnedUnchanged: boolean;
  gatePositiveAckCount: number;
  request?: ClientRequest;
  response?: Promise<RawResponse>;
  originalRequestClose?: Promise<void>;
  originalDrain?: Promise<unknown>;
  finish?: Promise<void>;
  lease?: ObservedLease;
  releases: number;
  releasedAt?: string;
  remainderEnded: boolean;
  observerFailure?: unknown;
  failed: boolean;
  failure?: unknown;
}
const owners = new Set<ObserverOwner>();
function ensure(value: unknown): asserts value {
  if (!value) throw new Error("Original Workflow maintenance writer observation is unavailable");
}
function remember(owner: ObserverOwner, error: unknown): void {
  if (!owner.failed) { owner.failed = true; owner.failure = error; }
}
afterEach(() => {
  if (owners.size) throw new AggregateError([...owners].map(owner => owner.failed ? owner.failure
    : owner.finish ?? owner.originalDrain ?? owner.response ?? owner.originalRequestClose),
  "Original Workflow maintenance writer observers remain retained");
});

export interface ActualWorkflowHeldMigrationBody {
  readonly originalRequest: ClientRequest;
  readonly input: Readonly<{ requestId: string; fileIds: readonly string[]; target: Readonly<AcceptFileMigrationInput["target"]> }>;
  readonly leaseId: string;
  readonly generation: number;
  readonly response: Promise<RawResponse>;
  readonly originalRequestClose: Promise<void>;
  readonly releaseObserved: Promise<void>;
  endRemainder(): void;
  releaseProof(): Readonly<{ leaseId: string; generation: number; actualReleaseCalls: number; releasedAt: string | null;
    actualOriginalReadSettled: boolean; originalReadResultReturnedUnchanged: boolean; gatePositiveAckCount: number }>;
  /** The caller supplies its one actual source-drain result (the original
   * maintenance-enter HTTP operation). An early HTTP status or observed SQL
   * release alone is never treated as original handler settlement. */
  finishAfterOriginalDrain(originalDrain: Promise<unknown>): Promise<void>;
}

/** One actual public File-migration metadata mutation, with its original JSON
 * body withheld after five bytes. Every observed Native method runs unchanged
 * on the same actual receiver, arguments and return result. The observer adds
 * read-only exact-lease queries after original COMMIT/autocommit. Its one
 * qualification-only gate delays an already positively settled original read
 * of the exact five-byte prefix until the caller ends that same request. It
 * returns that original read result unchanged. It never seeds a row, changes
 * admission, supplies a callback authority, substitutes a provider, or
 * overrides an HTTP/kernel/cadence deadline.
 *
 * The owner remains retained beyond an early transport response until the
 * caller's original source drain and exact release have positively settled.
 */
export async function holdActualWorkflowFileMigrationBody(options: {
  native: DatabaseSync; origin: string; actor: string; cookie: string; csrf: string;
  input: AcceptFileMigrationInput;
}): Promise<ActualWorkflowHeldMigrationBody> {
  const { native, origin, actor, cookie, csrf } = options;
  ensure(native.isOpen && !native.isTransaction && owners.size === 0);
  ensure(new URL(origin).origin === origin && actor.length > 0 && cookie.length > 0 && csrf.length > 0);
  const input = Object.freeze({ ...options.input, fileIds: Object.freeze([...options.input.fileIds]),
    target: Object.freeze({ ...options.input.target }) });
  ensure(input.fileIds.length === 1 && typeof input.fileIds[0] === "string" && input.fileIds[0].length > 0
    && typeof input.target.profileId === "string" && input.target.profileId.length > 0 && input.target.configurationRevision === 1);
  const body = JSON.stringify(input); ensure(body.length > 5);
  const prefix = new TextEncoder().encode(body.slice(0, 5)); ensure(prefix.byteLength === 5);
  const readPrototype = ReadableStreamDefaultReader.prototype as ReadableStreamDefaultReader<Uint8Array>;
  const owner: ObserverOwner = { native, originalExec: native.exec, originalPrepare: native.prepare,
    selectedRuns: new Map(), originalRead: readPrototype.read, reads: new Set(),
    originalReadSettled: false, originalReadResultReturnedUnchanged: false, gatePositiveAckCount: 0,
    releases: 0, remainderEnded: false, failed: false };
  const prepare = (sql: string) => Reflect.apply(owner.originalPrepare, native, [sql]) as StatementSync;
  ensure(prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n === 0);
  owners.add(owner);
  let acquired!: () => void, rejectAcquired!: (error: unknown) => void;
  let released!: () => void, rejectReleased!: (error: unknown) => void;
  const originalAcquired = new Promise<void>((resolve, reject) => { acquired = resolve; rejectAcquired = reject; });
  const releaseObserved = new Promise<void>((resolve, reject) => { released = resolve; rejectReleased = reject; });
  let releaseGate!: () => void, reachedGate!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const originalGateReached = new Promise<void>(resolve => { reachedGate = resolve; });
  void originalAcquired.catch(() => undefined); void releaseObserved.catch(() => undefined);
  function observe(): void {
    try {
      if (!owner.lease) {
        const statement = prepare("SELECT id,generation,owner FROM system_recovery_write_leases WHERE released_at IS NULL");
        statement.setReadBigInts(true); const rows = statement.all();
        if (!rows.length) return;
        ensure(rows.length === 1);
        const row = rows[0]; ensure(row && typeof row.id === "string" && row.owner === actor
          && typeof row.generation === "bigint" && row.generation >= 0n && row.generation <= BigInt(Number.MAX_SAFE_INTEGER));
        owner.lease = Object.freeze({ id: row.id, generation: Number(row.generation), owner: actor }); acquired();
      }
      const row = prepare("SELECT released_at FROM system_recovery_write_leases WHERE id=? AND generation=? AND owner=? AND kind='http'")
        .get(owner.lease.id, owner.lease.generation, actor);
      ensure(row);
      if (row.released_at !== null) {
        ensure(typeof row.released_at === "string" && owner.releases === 1);
        owner.releasedAt = row.released_at; released();
      }
    } catch (error) {
      owner.observerFailure ??= error; remember(owner, error); rejectAcquired(error); rejectReleased(error);
      // A passive observation failure cannot replace an original Native result.
    }
  }
  native.exec = function (sql: string): void {
    const result = Reflect.apply(owner.originalExec, this, [sql]);
    if (this === native && sql === "COMMIT") observe();
    return result;
  };
  native.prepare = function (sql: string): StatementSync {
    const statement = Reflect.apply(owner.originalPrepare, this, [sql]) as StatementSync;
    if (this === native && sql.startsWith("UPDATE system_recovery_write_leases SET released_at=?")) {
      const originalRun = statement.run; owner.selectedRuns.set(statement, originalRun);
      statement.run = (function (this: StatementSync, ...bindings: unknown[]): ReturnType<StatementSync["run"]> {
        const result = Reflect.apply(originalRun, this, bindings) as ReturnType<StatementSync["run"]>;
        if (this === statement && owner.lease && bindings[1] === owner.lease.id) {
          owner.releases++; if (!native.isTransaction) observe();
        }
        return result;
      }) as StatementSync["run"];
    }
    return statement;
  };
  readPrototype.read = (function (this: ReadableStreamDefaultReader<Uint8Array>, ...args: unknown[]): Promise<ReadableStreamReadResult<Uint8Array>> {
    const original = Reflect.apply(owner.originalRead, this, args) as Promise<ReadableStreamReadResult<Uint8Array>>;
    const reader = this;
    const wrapped = original.then(async result => {
      if (!owner.selectedReader && owner.lease && !owner.remainderEnded && !result.done
        && result.value instanceof Uint8Array && result.value.byteLength === prefix.byteLength
        && result.value.every((byte, index) => byte === prefix[index])) {
        // Only this actual same-Native unreleased HTTP lease can select the
        // positive read ACK. Observed permission is never exported or cached.
        try {
          const actual = prepare("SELECT id FROM system_recovery_write_leases WHERE id=? AND generation=? AND owner=? AND kind='http' AND released_at IS NULL")
            .get(owner.lease.id, owner.lease.generation, actor);
          if (actual?.id === owner.lease.id) {
            owner.selectedReader = reader; owner.originalReadSettled = true; owner.gatePositiveAckCount++;
            reachedGate(); await gate; owner.originalReadResultReturnedUnchanged = true;
          }
        } catch (error) {
          owner.observerFailure ??= error; remember(owner, error); rejectAcquired(error); rejectReleased(error);
          // Preserve even this original positive result if observation fails.
        }
      }
      return result;
    });
    const invocation = Object.freeze({ original, wrapped }); owner.reads.add(invocation);
    void wrapped.then(() => owner.reads.delete(invocation), () => owner.reads.delete(invocation));
    return wrapped;
  }) as ReadableStreamDefaultReader<Uint8Array>["read"];
  function endRemainder(): void {
    if (owner.remainderEnded) return;
    owner.remainderEnded = true; ensure(owner.request);
    try { if (!owner.request.writableEnded && !owner.request.destroyed) owner.request.end(body.slice(5)); }
    finally { releaseGate(); }
    // An already destroyed request is not a fabricated successful body ACK.
    // Original response/close/drain promises still govern every later cleanup.
  }
  try {
    owner.response = new Promise<RawResponse>((resolve, reject) => {
      owner.request = httpRequest(origin + "/api/files/migrations", { method: "POST", headers: {
        origin, cookie, "x-sfw-csrf": csrf, "content-type": "application/json",
      } }, incoming => {
        const chunks: Buffer[] = []; let total = 0;
        incoming.on("data", (chunk: Buffer) => { total += chunk.byteLength;
          if (total > 64 * 1024) { reject(new Error("Original Workflow metadata response exceeded its finite observation bound")); return; }
          chunks.push(chunk);
        });
        incoming.once("end", () => {
          if (typeof incoming.statusCode !== "number") { reject(new Error("Original Workflow metadata response status is unavailable")); return; }
          resolve(Object.freeze({ status: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        });
        incoming.once("error", reject);
        incoming.once("aborted", () => reject(new Error("Original Workflow metadata response ended before its original EOF")));
      });
      owner.request.once("error", reject);
      owner.originalRequestClose = new Promise<void>(closed => { owner.request!.once("close", closed); });
      owner.request.write(body.slice(0, 5));
    });
    void owner.response.catch(error => { remember(owner, error); rejectAcquired(error); });
    void owner.response.then(() => { if (!owner.lease) rejectAcquired(new Error("Original public Workflow mutation ended before an admitted source lease")); }, () => undefined);
    await Promise.all([originalAcquired, originalGateReached]);
    ensure(owner.request && owner.response && owner.originalRequestClose && owner.lease && !owner.observerFailure);
    const lease = owner.lease;
    return Object.freeze({ originalRequest: owner.request, input, leaseId: lease.id, generation: lease.generation,
      response: owner.response, originalRequestClose: owner.originalRequestClose, releaseObserved, endRemainder,
      releaseProof() { return Object.freeze({ leaseId: lease.id, generation: lease.generation,
        actualReleaseCalls: owner.releases, releasedAt: owner.releasedAt ?? null,
        actualOriginalReadSettled: owner.originalReadSettled,
        originalReadResultReturnedUnchanged: owner.originalReadResultReturnedUnchanged,
        gatePositiveAckCount: owner.gatePositiveAckCount }); },
      finishAfterOriginalDrain(originalDrain: Promise<unknown>): Promise<void> {
        if (owner.finish) { ensure(owner.originalDrain === originalDrain); return owner.finish; }
        ensure(originalDrain instanceof Promise); owner.originalDrain = originalDrain;
        owner.finish = Promise.resolve().then(async () => {
          endRemainder();
          const results = await Promise.allSettled([owner.response!, owner.originalRequestClose!, releaseObserved, originalDrain]);
          const failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
          if (failures.length || owner.failed) throw new AggregateError([...(owner.failed ? [owner.failure] : []), ...failures],
            "Original Workflow mutation or first source drain did not acknowledge settlement");
          while (owner.reads.size) {
            const pending = [...owner.reads];
            await Promise.allSettled(pending.flatMap(invocation => [invocation.original, invocation.wrapped]));
          }
          ensure(owner.releases === 1 && typeof owner.releasedAt === "string" && !owner.observerFailure
            && owner.originalReadSettled && owner.originalReadResultReturnedUnchanged && owner.gatePositiveAckCount === 1);
          native.exec = owner.originalExec; native.prepare = owner.originalPrepare;
          readPrototype.read = owner.originalRead;
          for (const [statement, run] of owner.selectedRuns) statement.run = run;
          owners.delete(owner);
        }).catch(error => { remember(owner, error); throw error; });
        void owner.finish.catch(() => undefined); return owner.finish;
      },
    });
  } catch (error) {
    remember(owner, error);
    // No successful original source-drain proof is available on constructor
    // failure. Release ingress best-effort and retain this exact owner; a hook
    // never resets a timed-out original or converts failure into a clean ACK.
    if (owner.request) endRemainder();
    throw error;
  }
}

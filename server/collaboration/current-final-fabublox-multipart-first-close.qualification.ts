import { afterEach, describe, expect, it } from "vitest";
import { createRetainedFabubloxMultipartBody } from "../imports/retained-fabublox-multipart-body";
import { createGroupV28RequestBodyCustody, registerGroupV28MultipartBody } from "./group-v28-request-body-custody";

type Body = ReturnType<typeof createRetainedFabubloxMultipartBody>;
type Custody = ReturnType<typeof createGroupV28RequestBodyCustody>;
interface HeldCase {
  body?: Body;
  custody?: Custody;
  releaseCancelAck?: () => void;
  originalPreparationObservation?: Promise<unknown>;
  firstBodyClose?: Promise<void>;
  firstCustodyClose?: Promise<void>;
  cleanup?: Promise<void>;
}
const owners = new Set<HeldCase>();
const cases = new Set<Promise<void>>();
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
function closeHeld(owner: HeldCase): Promise<void> {
  if (owner.cleanup) return owner.cleanup;
  // Test-source cancellation control only. It is never accepted by a product
  // owner as an authority/cleanup receipt or optional parent promise.
  owner.releaseCancelAck?.();
  owner.cleanup = Promise.resolve().then(async () => {
    const failures: unknown[] = [];
    try { await (owner.firstBodyClose ??= owner.body?.close()); } catch (error) { failures.push(error); }
    try { await (owner.firstCustodyClose ??= owner.custody?.close()); } catch (error) { failures.push(error); }
    await owner.originalPreparationObservation;
    if (failures.length) throw new AggregateError(failures, "Original neutral multipart first close remains unresolved");
    owners.delete(owner);
  });
  void owner.cleanup.catch(() => undefined);
  return owner.cleanup;
}
function retainedCase(work: (owner: HeldCase) => Promise<void>): Promise<void> {
  const owner: HeldCase = {};
  owners.add(owner);
  const original = Promise.resolve().then(() => work(owner));
  cases.add(original);
  void original.then(() => cases.delete(original), () => cases.delete(original));
  return original;
}
afterEach(async () => {
  // Release only the private underlying-stream gate before draining original
  // case/owner promises. Never retry an underlying cancellation or infer ACK.
  const cleanup = await Promise.allSettled([...owners].map(closeHeld));
  await Promise.allSettled([...cases]);
  const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Original neutral multipart custody is retained");
  if (owners.size) throw new Error("Original neutral multipart owner remains unsettled");
}, 20_000);

/** Real Request/ReadableStream body custody only. This case performs no
 * authentication, File permission, Process import, provider, Native or HTTP
 * operation and cannot qualify those separate application boundaries. */
describe("mandatory original-Request multipart first-close custody", () => {
  it("adopts only the issued facade and waits for its one original cancel ACK and preparation drain", () => retainedCase(async owner => {
    const pendingReadStarted = signal(), cancellationStarted = signal(), cancelAck = signal();
    owner.releaseCancelAck = cancelAck.resolve;
    let pulls = 0, cancellations = 0, cancellationAcknowledged = false;
    let preparationSettled = false, bodySettled = false, custodySettled = false;
    let bodySawPreparedDrain = false, custodySawPreparedAndCancelDrain = false;
    const boundedChunk = new TextEncoder().encode("--owned-first-close\r\n");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(boundedChunk);
        else pendingReadStarted.resolve(); // Actual original read now waits without EOF.
      },
      cancel() {
        cancellations++;
        cancellationStarted.resolve();
        // Native reader.cancel owns this actual returned underlying callback
        // promise. No Request/body method is overridden or caller receipt used.
        return cancelAck.promise.then(() => { cancellationAcknowledged = true; });
      },
    }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", duplex: "half", body: stream,
      headers: { "X-Import-Request-Id": "c0030000-0000-4000-8000-000000000002",
        "Content-Type": "multipart/form-data; boundary=owned-first-close" } };
    const request = new Request("http://127.0.0.1:4173/api/imports/fabublox", init);
    owner.custody = createGroupV28RequestBodyCustody(request);
    owner.body = createRetainedFabubloxMultipartBody(request);
    const body = owner.body, custody = owner.custody;
    const originalPreparation = body.prepared;
    owner.originalPreparationObservation = originalPreparation.then(
      value => { preparationSettled = true; return { status: "fulfilled" as const, value }; },
      reason => { preparationSettled = true; return { status: "rejected" as const, reason }; },
    );
    try {
      const copiedFacade = Object.freeze({ ...body });
      expect(copiedFacade).not.toBe(body);
      expect(() => registerGroupV28MultipartBody(request, copiedFacade)).toThrow("Original FabuBlox body ownership is unavailable");
      expect(() => registerGroupV28MultipartBody(request, body)).not.toThrow();
      expect(body.prepared).toBe(originalPreparation);
      await pendingReadStarted.promise;
      expect(pulls).toBe(2);
      expect(preparationSettled).toBe(false);

      // The parent initiates close. Reaching the actual native cancel callback
      // before this test calls body.close proves mandatory facade adoption.
      const firstCustodyClose = owner.firstCustodyClose = custody.close();
      expect(custody.close()).toBe(firstCustodyClose);
      const originalCustodySettlement = firstCustodyClose.then(() => {
        custodySettled = true;
        custodySawPreparedAndCancelDrain = preparationSettled && cancellationAcknowledged;
      });
      void originalCustodySettlement.catch(() => undefined);
      await cancellationStarted.promise;
      const firstBodyClose = owner.firstBodyClose = body.close();
      expect(body.close()).toBe(firstBodyClose);
      expect(custody.close()).toBe(firstCustodyClose);
      const originalBodySettlement = firstBodyClose.then(() => {
        bodySettled = true;
        bodySawPreparedDrain = preparationSettled;
      });
      void originalBodySettlement.catch(() => undefined);
      const prepared = await owner.originalPreparationObservation;
      expect(prepared).toMatchObject({ status: "rejected" });
      expect(preparationSettled).toBe(true); // Actual original pending read/preparation drained.
      expect(cancellations).toBe(1);
      expect(cancellationAcknowledged).toBe(false);
      expect(bodySettled).toBe(false);
      expect(custodySettled).toBe(false);

      cancelAck.resolve();
      await firstBodyClose;
      await firstCustodyClose;
      await Promise.all([originalBodySettlement, originalCustodySettlement]);
      expect(cancellationAcknowledged).toBe(true);
      expect(bodySawPreparedDrain).toBe(true);
      expect(custodySawPreparedAndCancelDrain).toBe(true);
      expect(body.close()).toBe(firstBodyClose);
      expect(custody.close()).toBe(firstCustodyClose);
      expect(cancellations).toBe(1);
    } finally {
      await closeHeld(owner);
    }
  }), 20_000);
});

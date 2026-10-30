import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createNodeHttpServer, NodeHttpServerDrainError, stopNodeHttpServerAndDrain,
  type FetchHandler, type NodeHttpOptions } from "./http.ts";

// Source-authored controls only until the owning runtime window. These actual
// sockets supply no installation, SQL, File provider or application grant.
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function listening(handler: FetchHandler, options: Partial<NodeHttpOptions> = {}) {
  const server = createNodeHttpServer(handler, { publicOrigin: "https://qualified.example", ...options });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert(address && typeof address !== "string");
    return { server, base: `http://127.0.0.1:${address.port}` };
  } catch (error) { await stopNodeHttpServerAndDrain(server); throw error; }
}

test("408 and socket close retain the original handler and its one delayed late-body disposer", { timeout: 5000 }, async () => {
  const handlerStarted = gate(), finishHandler = gate(), cancelStarted = gate(), finishCancel = gate();
  const order: string[] = []; let cancellations = 0, drained = false;
  const live = await listening(async () => {
    handlerStarted.release(); await finishHandler.promise; order.push("original-handler-returned");
    return new Response(new ReadableStream({ async cancel() {
      cancellations++; order.push("original-cancel-started"); cancelStarted.release();
      await finishCancel.promise; order.push("original-cancel-settled");
    } }));
  }, { timeoutMs: 40 });
  try {
    const response = fetch(live.base, { headers: { connection: "close" } });
    await handlerStarted.promise;
    const timed = await response; assert.equal(timed.status, 408); await timed.text();
    const closing = stopNodeHttpServerAndDrain(live.server);
    assert.equal(stopNodeHttpServerAndDrain(live.server), closing);
    const closed = closing.then(() => { drained = true; order.push("original-transport-drained"); });
    await delay(20); assert.equal(drained, false); assert.equal(live.server.listening, false);
    finishHandler.release(); await cancelStarted.promise;
    await delay(20); assert.equal(drained, false); assert.equal(cancellations, 1);
    finishCancel.release(); await closed;
    assert.deepEqual(order, ["original-handler-returned", "original-cancel-started",
      "original-cancel-settled", "original-transport-drained"]);
  } finally { finishHandler.release(); finishCancel.release(); await stopNodeHttpServerAndDrain(live.server); }
});

test("real response disconnect waits the first original reader cancellation rather than a second closed-stream cancel", { timeout: 5000 }, async () => {
  const cancelStarted = gate(), finishCancel = gate(); let cancellations = 0, drained = false;
  const live = await listening(() => new Response(new ReadableStream({
    start(body) { body.enqueue(new TextEncoder().encode("original body")); },
    async cancel() { cancellations++; cancelStarted.release(); await finishCancel.promise; },
  })));
  const request = httpRequest(live.base, { headers: { connection: "close" } });
  let response: IncomingMessage | undefined;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once("response", resolve); request.once("error", reject); request.end();
    });
    await once(response, "data"); const disconnected = once(response, "close"); response.destroy(); await disconnected;
    await cancelStarted.promise;
    const closing = stopNodeHttpServerAndDrain(live.server);
    const closed = closing.then(() => { drained = true; });
    await delay(20); assert.equal(drained, false); assert.equal(cancellations, 1);
    finishCancel.release(); await closed; assert.equal(cancellations, 1);
  } finally { finishCancel.release(); response?.destroy(); request.destroy(); await stopNodeHttpServerAndDrain(live.server); }
});

test("failed original response cancellation quarantines the issued HTTP owner without retries or forged drain admission", { timeout: 5000 }, async () => {
  const cancelStarted = gate(), originalFailure = new Error("Synthetic original disposer refusal"); let cancellations = 0;
  const live = await listening(() => new Response(new ReadableStream({
    start(body) { body.enqueue(new TextEncoder().encode("original body")); },
    cancel() { cancellations++; cancelStarted.release(); throw originalFailure; },
  })));
  const request = httpRequest(live.base, { headers: { connection: "close" } });
  let response: IncomingMessage | undefined, retained: NodeHttpServerDrainError | undefined;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once("response", resolve); request.once("error", reject); request.end();
    });
    await once(response, "data"); const disconnected = once(response, "close"); response.destroy(); await disconnected;
    await cancelStarted.promise;
    const closing = stopNodeHttpServerAndDrain(live.server);
    await assert.rejects(closing, error => {
      assert(error instanceof NodeHttpServerDrainError); retained = error;
      const reasons: unknown[] = [error]; const visited = new Set<unknown>();
      while (reasons.length) {
        const reason = reasons.pop(); if (visited.has(reason)) continue; visited.add(reason);
        if (reason instanceof AggregateError) reasons.push(...reason.errors);
      }
      assert(visited.has(originalFailure)); assert(error.retainedOwners.length > 0); return true;
    });
    assert.equal(stopNodeHttpServerAndDrain(live.server), closing);
    await assert.rejects(closing, error => error === retained);
    assert.equal(cancellations, 1); assert.equal(live.server.listening, false);
    await assert.rejects(stopNodeHttpServerAndDrain(createServer()), /ownership is unavailable/);
  } finally {
    response?.destroy(); request.destroy();
    try { await stopNodeHttpServerAndDrain(live.server); }
    catch (error) { assert(error instanceof NodeHttpServerDrainError); }
  }
});

test("stop admission still waits actual chunked ingress EOF and response completion for an already admitted request", { timeout: 5000 }, async () => {
  const started = gate(); let drained = false;
  const live = await listening(() => { started.release(); return new Response("original accepted body"); }, { maxBodyBytes: 20 });
  const request = httpRequest(live.base, { method: "POST", headers: { connection: "close" } });
  const answer = new Promise<{ status: number; text: string }>((resolve, reject) => {
    request.once("error", reject);
    request.once("response", response => {
      let text = ""; response.on("data", bytes => { text += bytes; });
      response.once("end", () => resolve({ status: response.statusCode!, text })); response.once("error", reject);
    });
  });
  void answer.catch(() => undefined);
  try {
    request.write("original"); await started.promise;
    const closing = stopNodeHttpServerAndDrain(live.server);
    const closed = closing.then(() => { drained = true; });
    await delay(20); assert.equal(drained, false);
    request.end("-body"); assert.deepEqual(await answer, { status: 200, text: "original accepted body" });
    await closed; assert.equal(drained, true);
  } finally { request.destroy(); await stopNodeHttpServerAndDrain(live.server); }
});

test("complete ignored Content-Length body cancels its original unread Web queue after native normal EOF before ACK and drain", { timeout: 5000 }, async context => {
  const originalToWeb = Readable.toWeb;
  let nativeBody: Readable | undefined, originalReaderCancel: ((reason?: unknown) => Promise<void>) | undefined;
  let originalCancellation: Promise<void> | undefined, cancellations = 0, originalReaderClosedSettled = false;
  let failedTeardownCancellation = false;
  const firstIncomingData = gate();
  let incoming: IncomingMessage | undefined, incomingEnded: Promise<unknown> | undefined, originalRequest: Request | undefined;
  let live: Awaited<ReturnType<typeof listening>> | undefined, request: ReturnType<typeof httpRequest> | undefined;
  // Observe the real adapter and its real default reader; return the exact
  // original objects and promises. No body is read or cancelled by the test's
  // successful path, and the production cancellation must be invoked once.
  Readable.toWeb = (...args) => {
    const stream = originalToWeb(...args), getReader = stream.getReader.bind(stream);
    nativeBody = args[0];
    Object.defineProperty(stream, "getReader", { value: () => {
      const reader = getReader(); originalReaderCancel = reader.cancel.bind(reader);
      void reader.closed.then(() => { originalReaderClosedSettled = true; }, () => { originalReaderClosedSettled = true; });
      Object.defineProperty(reader, "cancel", { value: (reason?: unknown) => {
        cancellations++; originalCancellation = originalReaderCancel!(reason); return originalCancellation;
      } });
      return reader;
    } });
    return stream;
  };
  let abortWait!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortWait = () => reject(context.signal.reason);
    context.signal.addEventListener("abort", abortWait, { once: true });
  });
  void aborted.catch(() => undefined);
  try {
    live = await listening(async fetched => {
      originalRequest = fetched;
      assert(incomingEnded); await incomingEnded; await nextTurn();
      assert(incoming); assert.equal(incoming.complete, true); assert.equal(incoming.readableEnded, true);
      assert(nativeBody); assert.equal(nativeBody.readableEnded, true); assert.equal(nativeBody.destroyed, true);
      assert.equal(nativeBody.errored, null); assert.equal(fetched.bodyUsed, false);
      assert.equal(originalReaderClosedSettled, false, "Native normal EOF has not settled the unread original Web queue");
      context.diagnostic(JSON.stringify({ kind: "normal-eof-unread-original-reader", nativeDestroyed: true,
        nativeReadableEnded: true, nativeErrored: false, fetchBodyUsed: false, originalReaderClosedPending: true }));
      return Response.json({ ok: true });
    }, { maxBodyBytes: 128, requestAdmission: (_fetched, parsed) => {
      incoming = parsed; incomingEnded = once(parsed, "end"); void incomingEnded.catch(() => undefined);
      parsed.once("data", () => firstIncomingData.release());
    } });
    const body = "{invalid JSON ignored by the original DELETE";
    request = httpRequest(`${live.base}/api/unused-template-step`, { method: "DELETE", headers: {
      connection: "close", "content-length": Buffer.byteLength(body), "content-type": "application/json",
    } });
    const answer = new Promise<{ status: number; text: string }>((resolve, reject) => {
      request!.once("error", reject);
      request!.once("response", response => {
        let text = ""; response.on("data", bytes => { text += bytes; });
        response.once("end", () => resolve({ status: response.statusCode!, text })); response.once("error", reject);
      });
    });
    void answer.catch(() => undefined);
    // Keep the exact original complete body/Content-Length, but separate its
    // native chunks at the actual first ingress data event. Request's outer
    // prefetch may take the first chunk; the second remains in the inner queue.
    request.write(body.slice(0, 14));
    await Promise.race([firstIncomingData.promise, aborted]); await nextTurn();
    request.end(body.slice(14));
    assert.deepEqual(await Promise.race([answer, aborted]), { status: 200, text: '{"ok":true}' });
    assert.equal(cancellations, 1); assert(originalCancellation); await originalCancellation;
    assert(originalRequest); assert.equal(originalRequest.bodyUsed, false);
    const closing = stopNodeHttpServerAndDrain(live.server);
    assert.equal(stopNodeHttpServerAndDrain(live.server), closing);
    await closing; assert.equal(live.server.listening, false); assert.equal(cancellations, 1);
  } finally {
    context.signal.removeEventListener("abort", abortWait);
    Readable.toWeb = originalToWeb;
    request?.destroy();
    // An unfixed normal-EOF branch never calls cancel and cannot drain its
    // unread queue even after the client disconnects. Only failed-test teardown
    // may cancel that captured exact reader once, without converting the
    // already-recorded timeout/assertion into a successful test or retrying a
    // production cancellation. Preserve/await the actual cleanup promise.
    if (!originalCancellation && nativeBody?.destroyed && nativeBody.readableEnded && !nativeBody.errored && originalReaderCancel) {
      failedTeardownCancellation = true;
      originalCancellation = originalReaderCancel(new Error("Failed EOF regression teardown"));
    }
    if (originalCancellation) await originalCancellation;
    if (live) {
      await stopNodeHttpServerAndDrain(live.server);
      process.stdout.write(JSON.stringify({ kind: "original-eof-regression-http-drain", productionCancellationCalls: cancellations,
        failedTeardownCancellation, originalHttpDrain: "settled" }) + "\n");
    }
  }
});

test("direct and late prelocked responses retain exact foreign body custody and reject drain without unlocking or cancelling it", { timeout: 5000 }, async () => {
  for (const mode of ["direct", "late"] as const) {
    const finishHandler = gate(); let cancellations = 0, foreignReadSettled = false;
    const returned = new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; } }));
    const foreignReader = returned.body!.getReader();
    const originalForeignRead = foreignReader.read();
    void originalForeignRead.then(() => { foreignReadSettled = true; }, () => { foreignReadSettled = true; });
    const live = await listening(async () => {
      if (mode === "late") await finishHandler.promise;
      return returned;
    }, { timeoutMs: 40 });
    try {
      const response = await fetch(live.base, { headers: { connection: "close" } });
      assert.equal(response.status, mode === "late" ? 408 : 500); await response.text();
      const closing = stopNodeHttpServerAndDrain(live.server); finishHandler.release();
      await assert.rejects(closing, error => {
        assert(error instanceof NodeHttpServerDrainError);
        const reasons: unknown[] = [error]; const visited = new Set<unknown>(); let exactBodyRetained = false;
        while (reasons.length) {
          const reason = reasons.pop(); if (visited.has(reason)) continue; visited.add(reason);
          if (reason instanceof AggregateError) {
            reasons.push(...reason.errors);
            const owner = Reflect.get(reason, "owner") as { response?: Response; body?: ReadableStream } | undefined;
            if (owner?.response === returned && owner.body === returned.body) exactBodyRetained = true;
          }
        }
        assert.equal(exactBodyRetained, true); return true;
      });
      assert.equal(stopNodeHttpServerAndDrain(live.server), closing);
      assert.equal(returned.body!.locked, true); assert.equal(foreignReadSettled, false);
      assert.equal(cancellations, 0); assert.equal(live.server.listening, false);
    } finally {
      finishHandler.release();
      try { await stopNodeHttpServerAndDrain(live.server); }
      catch (error) { assert(error instanceof NodeHttpServerDrainError); }
      // The unknown foreign reader remains retained by the quarantined owner.
      // It is never unlocked, retried or force-cancelled as test cleanup.
    }
  }
});

test("held keepalive ingress drains its complete response without waiting for idle expiry or client teardown", { timeout: 5000 }, async context => {
  const started = gate(); let drained = false;
  const live = await listening(async request => {
    started.release(); assert.equal(await request.text(), "original-held-body");
    return new Response("original complete response");
  });
  // Natural idle expiry exceeds this unchanged test budget. Only the original
  // transport drain may close this native keepalive connection on success.
  live.server.keepAliveTimeout = 10_000;
  const agent = new Agent({ keepAlive: true });
  const abort = () => agent.destroy(); context.signal.addEventListener("abort", abort, { once: true });
  const request = httpRequest(live.base, { method: "POST", agent });
  const answer = new Promise<{ status: number; text: string }>((resolve, reject) => {
    request.once("error", reject);
    request.once("response", response => {
      let text = ""; response.on("data", bytes => { text += bytes; });
      response.once("end", () => resolve({ status: response.statusCode!, text }));
      response.once("error", reject);
    });
  });
  void answer.catch(() => undefined);
  try {
    request.write("original-"); await started.promise;
    const closing = stopNodeHttpServerAndDrain(live.server);
    assert.equal(stopNodeHttpServerAndDrain(live.server), closing);
    void closing.then(() => { drained = true; }, () => undefined);
    await delay(20); assert.equal(drained, false);
    request.end("held-body");
    assert.deepEqual(await answer, { status: 200, text: "original complete response" });
    await closing; assert.equal(drained, true); assert.equal(live.server.listening, false);
  } finally {
    if (!request.writableEnded) request.end("held-body");
    agent.destroy(); request.destroy(); await answer.catch(() => undefined);
    await stopNodeHttpServerAndDrain(live.server); context.signal.removeEventListener("abort", abort);
  }
});

test("idle cleanup after stop preserves a held original response and every backpressured tail byte", { timeout: 5000 }, async context => {
  const finishBody = gate(), firstByte = gate(); let producedTail = false, cancellations = 0, drained = false;
  const tail = Buffer.alloc(2 * 1024 * 1024, 0x5a), prefix = Buffer.from("held-prefix:");
  const returned = new Response(new ReadableStream<Uint8Array>({
    start(body) { body.enqueue(prefix); },
    async pull(body) { await finishBody.promise; producedTail = true; body.enqueue(tail); body.close(); },
    cancel() { cancellations++; },
  }));
  const live = await listening(() => returned); live.server.keepAliveTimeout = 10_000;
  const agent = new Agent({ keepAlive: true });
  const abort = () => agent.destroy(); context.signal.addEventListener("abort", abort, { once: true });
  const request = httpRequest(live.base, { agent });
  let incoming: IncomingMessage | undefined;
  const answer = new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
    request.once("error", reject);
    request.once("response", response => {
      incoming = response; const chunks: Buffer[] = [];
      response.on("data", bytes => { chunks.push(bytes); firstByte.release(); });
      response.once("end", () => resolve({ status: response.statusCode!, bytes: Buffer.concat(chunks) }));
      response.once("error", reject);
    });
    request.end();
  });
  void answer.catch(() => undefined);
  try {
    await firstByte.promise; assert.equal(producedTail, false);
    incoming!.pause();
    const closing = stopNodeHttpServerAndDrain(live.server);
    assert.equal(stopNodeHttpServerAndDrain(live.server), closing);
    void closing.then(() => { drained = true; }, () => undefined);
    await delay(20); assert.equal(drained, false); assert.equal(cancellations, 0);
    finishBody.release(); incoming!.resume();
    const response = await answer; assert.equal(response.status, 200);
    assert.deepEqual(response.bytes, Buffer.concat([prefix, tail]));
    await closing; assert.equal(drained, true); assert.equal(returned.body!.locked, false);
    assert.equal(cancellations, 0);
  } finally {
    finishBody.release(); incoming?.resume(); agent.destroy(); request.destroy();
    await answer.catch(() => undefined); await stopNodeHttpServerAndDrain(live.server);
    context.signal.removeEventListener("abort", abort);
  }
});

test("a reported idle sweep failure retains its original rejecting drain after the complete response", { timeout: 5000 }, async context => {
  const started = gate(), finishHandler = gate(); let returned = false, reportedFailures = 0;
  const originalFailure = new Error("Synthetic post-settlement idle sweep acknowledgement loss");
  const live = await listening(async () => {
    started.release(); await finishHandler.promise; returned = true; return new Response("complete original body");
  });
  live.server.keepAliveTimeout = 10_000;
  const sweep = live.server.closeIdleConnections.bind(live.server);
  live.server.closeIdleConnections = () => {
    sweep(); // The real native sweep runs before the authored reported failure.
    if (returned) { reportedFailures++; throw originalFailure; }
  };
  const agent = new Agent({ keepAlive: true });
  const abort = () => agent.destroy(); context.signal.addEventListener("abort", abort, { once: true });
  const request = httpRequest(live.base, { agent });
  const answer = new Promise<string>((resolve, reject) => {
    request.once("error", reject);
    request.once("response", response => {
      let text = ""; response.on("data", bytes => { text += bytes; });
      response.once("end", () => resolve(text)); response.once("error", reject);
    });
    request.end();
  });
  void answer.catch(() => undefined);
  let retained: NodeHttpServerDrainError | undefined;
  try {
    await started.promise; const closing = stopNodeHttpServerAndDrain(live.server);
    void closing.catch(() => undefined); finishHandler.release();
    assert.equal(await answer, "complete original body");
    await assert.rejects(closing, error => {
      assert(error instanceof NodeHttpServerDrainError); retained = error;
      assert(error.errors.includes(originalFailure)); assert(error.retainedOwners.length > 0); return true;
    });
    assert.equal(stopNodeHttpServerAndDrain(live.server), closing);
    await assert.rejects(closing, error => error === retained); assert.equal(reportedFailures, 1);
  } finally {
    finishHandler.release(); agent.destroy(); request.destroy(); await answer.catch(() => undefined);
    live.server.closeIdleConnections = sweep;
    try { await stopNodeHttpServerAndDrain(live.server); }
    catch (error) { assert(error instanceof NodeHttpServerDrainError); }
    context.signal.removeEventListener("abort", abort);
  }
});

test("a reported initial idle failure never retries cleanup or abandons the held response", { timeout: 5000 }, async context => {
  const finishBody = gate(), firstByte = gate(), nativeClosed = gate();
  const failure = new Error("Synthetic initial idle sweep acknowledgement loss");
  let idleCalls = 0, rejected = false, nativeCloseObserved = false, nativeCloseError: Error | undefined;
  const returned = new Response(new ReadableStream<Uint8Array>({
    start(body) { body.enqueue(new TextEncoder().encode("original-held-")); },
    async pull(body) { await finishBody.promise; body.enqueue(new TextEncoder().encode("response")); body.close(); },
  }));
  const live = await listening(() => returned); live.server.keepAliveTimeout = 10_000;
  const sweep = live.server.closeIdleConnections.bind(live.server);
  const originalClose = live.server.close.bind(live.server);
  live.server.close = callback => originalClose(error => {
    nativeCloseObserved = true; nativeCloseError = error; nativeClosed.release(); callback?.(error);
  });
  live.server.closeIdleConnections = () => {
    idleCalls++; sweep();
    // The first native sweep is inside the real server.close. Report the
    // explicit initial sweep failure only after that native close has begun.
    if (idleCalls === 2) throw failure;
  };
  const agent = new Agent({ keepAlive: true });
  const abort = () => agent.destroy(); context.signal.addEventListener("abort", abort, { once: true });
  const request = httpRequest(live.base, { agent });
  const answer = new Promise<string>((resolve, reject) => {
    request.once("error", reject);
    request.once("response", response => {
      let text = ""; response.on("data", bytes => { text += bytes; firstByte.release(); });
      response.once("end", () => resolve(text)); response.once("error", reject);
    });
    request.end();
  });
  void answer.catch(() => undefined);
  let closing: Promise<void> | undefined, retained: NodeHttpServerDrainError | undefined;
  try {
    await firstByte.promise; closing = stopNodeHttpServerAndDrain(live.server);
    void closing.catch(() => { rejected = true; });
    await delay(20); assert.equal(rejected, false); assert.equal(nativeCloseObserved, false);
    assert.equal(idleCalls, 2); finishBody.release();
    assert.equal(await answer, "original-held-response");
    await assert.rejects(closing, error => {
      assert(error instanceof NodeHttpServerDrainError); retained = error;
      assert(error.errors.includes(failure)); assert(error.retainedOwners.length > 0); return true;
    });
    assert.equal(returned.body!.locked, false); assert.equal(idleCalls, 2);
    assert.equal(stopNodeHttpServerAndDrain(live.server), closing);
    await assert.rejects(closing, error => error === retained);
  } finally {
    finishBody.release(); agent.destroy(); request.destroy(); await answer.catch(() => undefined);
    live.server.closeIdleConnections = sweep;
    try { await stopNodeHttpServerAndDrain(live.server); }
    catch (error) { assert(error instanceof NodeHttpServerDrainError); }
    await nativeClosed.promise; assert.equal(nativeCloseError, undefined);
    context.diagnostic(JSON.stringify({ kind: "reported-initial-idle-failure-terminal-cleanup",
      originalHttpDrain: "rejected-retained", originalNativeListenerCallback: "acknowledged",
      clientAgentDestroyedForTerminalCleanup: true, gracefulHttpDrain: false }));
    context.signal.removeEventListener("abort", abort);
  }
});

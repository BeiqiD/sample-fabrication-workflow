import { afterEach, describe, expect, it, vi } from "vitest";
import { canCancelReceipt, createFileShadowPilotClient, FILE_SHADOW_PILOT_JOURNAL_KEY, type PilotJournal, type ShadowConsumerKey } from "./file-shadow-pilot-client";
import { sha256Hex, stableJson } from "../../shared/domain/content-addressing";

const incarnation = "11111111-1111-4111-8111-111111111111";
const newerIncarnation = "22222222-2222-4222-8222-222222222222";
const consumer: ShadowConsumerKey = { consumerKind: "project_content_attachment", consumerId: "content-a", consumerSubId: "", fileSlot: "primary" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
function rawStatus(enabled = true, runtime = incarnation) {
  return { mode: "overlap", epoch: 12, enabled: enabled ? 1 : 0, incarnation: runtime,
    current_count: 11, resolved_count: 0, unresolved_count: 0, pending_count: 11, unfinished_attempts: 0,
    enabled_by: "private-actor", updated_at: "private-time" };
}
function rawBaseline(state = "read_write", enabled = true) {
  const locator = { storeKind: "r2", provider: "r2", objectKey: "PRIVATE/object/key" };
  return { version: 1, kind: "file-shadow-baseline", bytesVerified: false, key: consumer,
    authority: { singleton: 1, revision: 1, mode: "overlap" }, epoch: 12, runtime: { enabled: enabled ? 1 : 0, incarnation, enabled_by: "PRIVATE/actor" },
    head: { consumer_kind: consumer.consumerKind, consumer_id: consumer.consumerId, consumer_sub_id: "", file_slot: "primary", generation: 2, occurrence_id: "occurrence-a", present: 1 },
    record: { key: consumer, locator, registries: [{ byte_size: 157, sha256: "a".repeat(64), private: "PRIVATE/registry" }],
      profiles: [{ id: "recorded-r2", configuration_revision: 1, adapter_type: "r2", runtime_state: state, namespace_identity: "PRIVATE/namespace" }], source: { caption: "PRIVATE/source" } },
    decision: null, purpose: "research_source", sourceLocator: locator, sourceProfile: { profileId: "recorded-r2", configurationRevision: 1 },
    status: "ready_to_verify", reasons: [], baselineSha256: "b".repeat(64), schemaSha256: "c".repeat(64) };
}
function receipt(operationId: string, status = "pending", attemptState = "unknown") {
  return { operationId, occurrenceId: "occurrence-a", status, attemptId: "attempt-a", attemptState,
    fileId: status === "resolved" ? "file-a" : null, locationId: status === "resolved" ? "location-a" : null,
    nextAction: status === "pending" ? ["unknown", "verified", "write_started"].includes(attemptState) ? "reconcile" : "inspect" : "none" };
}
const immediateLock = async <T>(action: () => Promise<T>) => action();
function setup(saved = storage()) {
  const fetchMock = vi.fn<typeof fetch>();
  const client = createFileShadowPilotClient({ storage: saved, fetch: fetchMock, withLock: immediateLock });
  return { saved, fetchMock, client };
}
async function baseline(fixture: ReturnType<typeof setup>, raw = rawBaseline()) {
  fixture.fetchMock.mockResolvedValueOnce(json(raw)); return fixture.client.getBaseline(consumer);
}
async function status(fixture: ReturnType<typeof setup>, raw = rawStatus()) {
  fixture.fetchMock.mockResolvedValueOnce(json(raw)); return fixture.client.getStatus();
}
function ticket(saved: Storage) { return JSON.parse(saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)!) as PilotJournal; }
async function withdrawn(request: PilotJournal["request"]) {
  return { operationId: request.operationId, status: "withdrawn", request, requestSha256: await sha256Hex(stableJson(request)),
    occurrenceId: null, attemptId: null, attemptState: null, fileId: null, locationId: null, nextAction: "none" };
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded File shadow pilot client", () => {
  it("uses only the exact occurrence's adjudicated profile when historical namespace evidence was missing", async () => {
    const old = rawBaseline();
    const adjudicated = { ...old, head: { ...old.head, source_sha256: "d".repeat(64) }, record: { ...old.record, profiles: [] },
      adjudication: { requestId: "33333333-3333-4333-8333-333333333333", requestSha256: "e".repeat(64),
        sourceSha256: "d".repeat(64), purpose: "research_source", sourceProfile: { profileId: "recorded-r2", configurationRevision: 1 },
        sourceProfileRuntimeState: "read_write" } };
    const fixture = setup(), proof = await baseline(fixture, adjudicated);
    expect(proof.eligible).toBe(true);
    expect(proof.sourceProfile).toEqual({ profileId: "recorded-r2", configurationRevision: 1, runtimeState: "read_write" });
    expect(JSON.stringify(proof)).not.toContain("PRIVATE/");
    expect((await baseline(setup(), { ...adjudicated, adjudication: { ...adjudicated.adjudication, sourceProfileRuntimeState: "read_only" } })).eligible).toBe(false);
    fixture.fetchMock.mockImplementationOnce(async (_path, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.destinationProfile).toEqual({ profileId: "recorded-r2", configurationRevision: 1 });
      expect(request.expectedBaselineSha256).toBe(adjudicated.baselineSha256);
      return json(receipt(request.operationId, "resolved", "published"));
    });
    expect((await fixture.client.convert(proof)).status).toBe("resolved");
    for (const overlay of [null, { ...adjudicated.adjudication, sourceSha256: "f".repeat(64) },
      { ...adjudicated.adjudication, sourceProfile: { profileId: "different-r2", configurationRevision: 1 } },
      { ...adjudicated.adjudication, purpose: "embedded_content" }]) {
      const f = setup();
      f.fetchMock.mockResolvedValueOnce(json({ ...adjudicated, adjudication: overlay }));
      await expect(f.client.getBaseline(consumer)).rejects.toThrow();
      expect(f.saved.length).toBe(0);
    }
  });

  it("projects only reviewed proof fields and treats the exact recorded profile as destination", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    expect(proof.eligible).toBe(true);
    expect(JSON.stringify(proof)).not.toContain("PRIVATE/");
    fixture.fetchMock.mockImplementationOnce(async (_path, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual(ticket(fixture.saved).request);
      expect(body.destinationProfile).toEqual({ profileId: "recorded-r2", configurationRevision: 1 });
      expect(ticket(fixture.saved).proof).toEqual({ generation: 2, occurrenceId: "occurrence-a", purpose: "research_source", expectedBytes: 157, expectedSha256: "a".repeat(64) });
      expect(JSON.stringify(ticket(fixture.saved))).not.toContain("PRIVATE/");
      return json(receipt(body.operationId, "resolved", "published"));
    });
    await fixture.client.convert(proof);
    expect(fixture.client.loadJournal()?.receipt?.status).toBe("resolved");
    const next = await baseline(fixture);
    await expect(fixture.client.convert(next)).rejects.toThrow("dismiss");
    await fixture.client.clearTerminalReceipt(ticket(fixture.saved).request.operationId);
    expect(fixture.client.loadJournal()).toBeNull();
    await expect(fixture.client.convert(next)).rejects.toThrow("Inspect");
  });

  it("blocks writes on failed durable storage without sending a conversion", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.saved.setItem = () => { throw new Error("quota"); };
    await expect(fixture.client.convert(proof)).rejects.toThrow("could not be saved");
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains exact lost-ACK identity across reload, missing receipt and paused inspection", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockRejectedValueOnce(new Error("PRIVATE/provider/location"));
    await expect(fixture.client.convert(proof)).rejects.toThrow("response was lost");
    const frozen = fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY);
    const reload = setup(fixture.saved), fresh = await baseline(reload);
    await expect(reload.client.convert(fresh)).rejects.toThrow("saved terminal receipt");
    reload.fetchMock.mockResolvedValueOnce(json({ error: "PRIVATE/provider/failure" }, 404));
    await expect(reload.client.inspectOperation(ticket(fixture.saved).request.operationId)).rejects.toThrow("No receipt is visible yet");
    expect(fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).toBe(frozen);
    await status(reload, rawStatus(false, newerIncarnation));
    const operationId = ticket(fixture.saved).request.operationId;
    reload.fetchMock.mockResolvedValueOnce(json(receipt(operationId)));
    await reload.client.inspectOperation(ticket(fixture.saved).request.operationId);
    expect(JSON.parse(String(reload.fetchMock.mock.lastCall?.[1]?.body))).toEqual({ operationId, runtimeIncarnation: incarnation });
    expect(reload.fetchMock.mock.calls.some(([path]) => String(path).endsWith("/convert"))).toBe(false);
    await expect(reload.client.clearTerminalReceipt(ticket(fixture.saved).request.operationId)).rejects.toThrow("Only a confirmed terminal");
  });

  it("uses current enabled incarnation for explicit reconcile and never repeats the conversion POST", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockImplementationOnce(async (_path, init) => json(receipt(JSON.parse(String(init?.body)).operationId)));
    await fixture.client.convert(proof);
    const current = await status(fixture, rawStatus(true, newerIncarnation)), operationId = ticket(fixture.saved).request.operationId;
    fixture.fetchMock.mockResolvedValueOnce(json(receipt(operationId, "resolved", "published")));
    await fixture.client.reconcileOperation(current, operationId);
    expect(JSON.parse(String(fixture.fetchMock.mock.lastCall?.[1]?.body))).toEqual({ operationId, runtimeIncarnation: newerIncarnation });
    expect(ticket(fixture.saved).request.runtimeIncarnation).toBe(incarnation);
    expect(fixture.fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/convert"))).toHaveLength(1);
  });

  it("permits explicit cancel only for a known pre-write attempt", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockImplementationOnce(async (_path, init) => json(receipt(JSON.parse(String(init?.body)).operationId, "pending", "staged")));
    await fixture.client.convert(proof);
    expect(canCancelReceipt(fixture.client.loadJournal()!.receipt)).toBe(true);
    const current = await status(fixture), operationId = ticket(fixture.saved).request.operationId;
    fixture.fetchMock.mockResolvedValueOnce(json(receipt(operationId, "cancelled", "cancelled")));
    await fixture.client.cancelOperation(current, operationId);
    await fixture.client.clearTerminalReceipt(ticket(fixture.saved).request.operationId);
    expect(fixture.client.loadJournal()).toBeNull();
  });

  it("blocks ambiguous, non-R2, read-only, oversized and locally altered conversion proof", async () => {
    for (const change of [
      (raw: ReturnType<typeof rawBaseline>) => { raw.status = "ambiguous"; raw.reasons = ["consumer_purpose_unresolved"] as never[]; },
      (raw: ReturnType<typeof rawBaseline>) => { raw.record.locator.provider = "switchdrive"; raw.record.locator.storeKind = "managed"; },
      (raw: ReturnType<typeof rawBaseline>) => { raw.record.profiles[0].runtime_state = "read_only"; },
      (raw: ReturnType<typeof rawBaseline>) => { raw.record.registries[0].byte_size = 100 * 1024 * 1024 + 1; },
    ]) {
      const fixture = setup(), raw = rawBaseline(); change(raw); const proof = await baseline(fixture, raw);
      expect(proof.eligible).toBe(false);
      await expect(fixture.client.convert(proof)).rejects.toThrow("not ready");
      expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    }
    const fixture = setup(), proof = await baseline(fixture);
    proof.sourceProfile!.profileId = "unreviewed-default";
    await expect(fixture.client.convert(proof)).rejects.toThrow("Inspect");
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates baseline after profile admission even when its ACK is lost", async () => {
    const fixture = setup(), proof = await baseline(fixture, rawBaseline("read_only"));
    fixture.fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(fixture.client.enableProfile(proof)).rejects.toThrow("response was lost");
    await expect(fixture.client.enableProfile(proof)).rejects.toThrow("Inspect");
    expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows pause despite corrupt/full storage and an unavailable journal lock", async () => {
    const fixture = setup();
    const client = createFileShadowPilotClient({ storage: fixture.saved, fetch: fixture.fetchMock, withLock: async () => { throw new Error("busy"); } });
    fixture.fetchMock.mockResolvedValueOnce(json(rawStatus())); const current = await client.getStatus();
    fixture.saved.setItem(FILE_SHADOW_PILOT_JOURNAL_KEY, "corrupt");
    fixture.saved.setItem = () => { throw new Error("quota"); };
    fixture.fetchMock.mockResolvedValueOnce(json(rawStatus(false)));
    await expect(client.pause(current)).resolves.toMatchObject({ enabled: false });
    expect(fixture.fetchMock.mock.lastCall?.[0]).toBe("/api/files/shadow/disable");
    expect(fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).toBe("corrupt");
  });

  it("serializes tabs with Web Locks and retains the first operation after a lost response", async () => {
    let held = false;
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) => {
      if (held) return callback(null); held = true; try { return await callback({}); } finally { held = false; }
    } } });
    const saved = storage(), fetchMock = vi.fn<typeof fetch>();
    const one = createFileShadowPilotClient({ storage: saved, fetch: fetchMock }), two = createFileShadowPilotClient({ storage: saved, fetch: fetchMock });
    fetchMock.mockResolvedValueOnce(json(rawBaseline())).mockResolvedValueOnce(json(rawBaseline()));
    const [a, b] = await Promise.all([one.getBaseline(consumer), two.getBaseline(consumer)]);
    let reject!: (reason: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
    const pending = one.convert(a); const blocked = two.convert(b);
    await expect(blocked).rejects.toThrow("Another tab");
    const first = saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY);
    reject(new Error("lost")); await expect(pending).rejects.toThrow("response was lost");
    await expect(two.convert(b)).rejects.toThrow("saved terminal receipt");
    expect(saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).toBe(first);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/convert"))).toHaveLength(1);
  });

  it("can pause with fresh status while a conversion still owns the journal lock", async () => {
    let held = false;
    const saved = storage(), fetchMock = vi.fn<typeof fetch>();
    const withLock = async <T>(action: () => Promise<T>) => {
      if (held) throw new Error("busy"); held = true;
      try { return await action(); } finally { held = false; }
    };
    const client = createFileShadowPilotClient({ storage: saved, fetch: fetchMock, withLock });
    fetchMock.mockResolvedValueOnce(json(rawBaseline())); const proof = await client.getBaseline(consumer);
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    const pending = client.convert(proof);
    expect(held).toBe(true);
    const frozen = saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY);
    fetchMock.mockResolvedValueOnce(json(rawStatus())); const current = await client.getStatus();
    fetchMock.mockResolvedValueOnce(json(rawStatus(false)));
    await expect(client.pause(current)).resolves.toMatchObject({ enabled: false });
    expect(held).toBe(true);
    expect(saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).toBe(frozen);
    resolve(json(receipt(ticket(saved).request.operationId)));
    await pending;
    expect(held).toBe(false);
  });

  it("rejects every stale displayed operation action after another tab creates a newer ticket", async () => {
    const first = setup(), firstProof = await baseline(first);
    first.fetchMock.mockImplementationOnce(async (_path, init) => json(receipt(JSON.parse(String(init?.body)).operationId, "resolved", "published")));
    await first.client.convert(firstProof);
    const oldId = ticket(first.saved).request.operationId;
    const current = await status(first);
    const second = setup(first.saved);
    await second.client.clearTerminalReceipt(oldId);
    const nextProof = await baseline(second);
    second.fetchMock.mockImplementationOnce(async (_path, init) => json(receipt(JSON.parse(String(init?.body)).operationId)));
    await second.client.convert(nextProof);
    const newerTicket = first.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY);
    const requestsBefore = first.fetchMock.mock.calls.length;
    await expect(first.client.inspectOperation(oldId)).rejects.toThrow("changed in another tab");
    await expect(first.client.reconcileOperation(current, oldId)).rejects.toThrow("changed in another tab");
    await expect(first.client.cancelOperation(current, oldId)).rejects.toThrow("changed in another tab");
    await expect(first.client.withdrawOperation(oldId)).rejects.toThrow("changed in another tab");
    await expect(first.client.clearTerminalReceipt(oldId)).rejects.toThrow("changed in another tab");
    expect(first.fetchMock).toHaveBeenCalledTimes(requestsBefore);
    expect(first.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).toBe(newerTicket);
  });

  it("fails closed without Web Locks and never reflects unknown reasons or raw errors", async () => {
    vi.stubGlobal("navigator", {});
    const fixture = setup(), client = createFileShadowPilotClient({ storage: fixture.saved, fetch: fixture.fetchMock });
    fixture.fetchMock.mockResolvedValueOnce(json(rawBaseline())); const proof = await client.getBaseline(consumer);
    await expect(client.convert(proof)).rejects.toThrow("Web Locks");
    const raw = rawBaseline(); raw.reasons = ["PRIVATE/provider/error"] as never[];
    const blocked = await baseline(fixture, raw);
    expect(blocked.reasons).toEqual(["metadata_reason_unrecognized"]);
    expect(blocked.eligible).toBe(false);
    fixture.fetchMock.mockResolvedValueOnce(json({ error: "PRIVATE/provider/error" }, 409));
    await expect(fixture.client.getStatus()).rejects.toThrow("command was not confirmed");
  });

  it("rejects oversized responses and mismatched receipt identities while keeping its ticket", async () => {
    const fixture = setup(); fixture.fetchMock.mockResolvedValueOnce(json({ value: "x".repeat(512 * 1024) }));
    await expect(fixture.client.getStatus()).rejects.toThrow("incomplete");
    const proof = await baseline(fixture);
    fixture.fetchMock.mockResolvedValueOnce(json(receipt(newerIncarnation, "resolved", "published")));
    await expect(fixture.client.convert(proof)).rejects.toThrow("incomplete");
    expect(fixture.client.loadJournal()?.receipt).toBeNull();
    expect(fixture.client.loadJournal()?.request.operationId).not.toBe(newerIncarnation);
  });

  it("closes only an explicitly withdrawn request after rejection, reload and a missing receipt", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockResolvedValueOnce(json({ error: "baseline changed" }, 409));
    await expect(fixture.client.convert(proof)).rejects.toThrow("not confirmed");
    const frozen = fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY), original = ticket(fixture.saved).request;
    const reload = setup(fixture.saved);
    reload.fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(reload.client.inspectOperation(original.operationId)).rejects.toThrow("No receipt is visible");
    await expect(reload.client.clearTerminalReceipt(original.operationId)).rejects.toThrow("Only a confirmed terminal");
    expect(fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).toBe(frozen);
    await status(reload, rawStatus(false, newerIncarnation));
    reload.fetchMock.mockImplementationOnce(async (path, init) => {
      expect(path).toBe("/api/files/shadow/withdraw");
      expect(JSON.parse(String(init?.body))).toEqual(original);
      return json(await withdrawn(original));
    });
    await expect(reload.client.withdrawOperation(original.operationId)).resolves.toMatchObject({ status: "withdrawn", occurrenceId: null });
    expect(ticket(fixture.saved).request).toEqual(original);
    const reread = setup(fixture.saved);
    expect(reread.client.loadJournal()?.receipt?.status).toBe("withdrawn");
    await reread.client.clearTerminalReceipt(original.operationId);
    expect(reread.client.loadJournal()).toBeNull();
    expect(reload.fetchMock.mock.calls.some(([path]) => /\/(convert|enable|cancel)$/.test(String(path)))).toBe(false);
  });

  it.each(["pending", "resolved"])("keeps an already accepted %s operation when withdrawal loses the claim race", async (state) => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(fixture.client.convert(proof)).rejects.toThrow("response was lost");
    const original = ticket(fixture.saved).request;
    fixture.fetchMock.mockResolvedValueOnce(json(receipt(original.operationId, state, state === "resolved" ? "published" : "unknown")));
    await expect(fixture.client.withdrawOperation(original.operationId)).resolves.toMatchObject({ status: state });
    expect(ticket(fixture.saved).request).toEqual(original);
    expect(fixture.fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/convert"))).toHaveLength(1);
    const calls = fixture.fetchMock.mock.calls.length;
    await expect(fixture.client.withdrawOperation(original.operationId)).rejects.toThrow("Inspect the saved operation");
    expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
    if (state === "pending") await expect(fixture.client.clearTerminalReceipt(original.operationId)).rejects.toThrow("Only a confirmed terminal");
  });

  it("retains a lost withdrawal response and recovers its terminal receipt through inspection", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(fixture.client.convert(proof)).rejects.toThrow("response was lost");
    const original = ticket(fixture.saved).request, frozen = fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY);
    fixture.fetchMock.mockRejectedValueOnce(new Error("withdraw committed but response lost"));
    await expect(fixture.client.withdrawOperation(original.operationId)).rejects.toThrow("response was lost");
    expect(fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).toBe(frozen);
    const reload = setup(fixture.saved);
    reload.fetchMock.mockResolvedValueOnce(json(await withdrawn(original)));
    await reload.client.inspectOperation(original.operationId);
    expect(ticket(fixture.saved).receipt?.status).toBe("withdrawn");
    reload.fetchMock.mockResolvedValueOnce(json(receipt(original.operationId)));
    await expect(reload.client.inspectOperation(original.operationId)).rejects.toThrow("terminal receipt changed");
    expect(ticket(fixture.saved).receipt?.status).toBe("withdrawn");
  });

  it.each(["digest", "request", "occurrence", "attempt", "action", "status"])("rejects malformed withdrawal %s while retaining the original unknown request", async (field) => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(fixture.client.convert(proof)).rejects.toThrow("response was lost");
    const original = ticket(fixture.saved).request, frozen = fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY);
    const result: Record<string, unknown> = await withdrawn(original);
    if (field === "digest") result.requestSha256 = "0".repeat(64);
    if (field === "request") result.request = { ...original, runtimeIncarnation: newerIncarnation };
    if (field === "occurrence") result.occurrenceId = "invented-occurrence";
    if (field === "attempt") result.attemptId = "invented-attempt";
    if (field === "action") result.nextAction = "inspect";
    if (field === "status") result.status = "not_found";
    fixture.fetchMock.mockResolvedValueOnce(json(result));
    await expect(fixture.client.withdrawOperation(original.operationId)).rejects.toThrow("incomplete");
    expect(fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).toBe(frozen);
    await expect(fixture.client.clearTerminalReceipt(original.operationId)).rejects.toThrow("Only a confirmed terminal");
  });

  it("validates the echoed request on reload and retains large bounded keys in a terminal journal", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(fixture.client.convert(proof)).rejects.toThrow("response was lost");
    const journal = ticket(fixture.saved);
    journal.request.key.consumerId = "x".repeat(63 * 1024);
    const result = await withdrawn(journal.request);
    journal.receipt = { ...result, status: "withdrawn", nextAction: "none" };
    fixture.saved.setItem(FILE_SHADOW_PILOT_JOURNAL_KEY, JSON.stringify(journal));
    expect(fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)!.length).toBeGreaterThan(80 * 1024);
    expect(fixture.client.loadJournal()?.receipt?.status).toBe("withdrawn");
    journal.receipt.requestSha256 = "0".repeat(64);
    fixture.saved.setItem(FILE_SHADOW_PILOT_JOURNAL_KEY, JSON.stringify(journal));
    await expect(fixture.client.clearTerminalReceipt(journal.request.operationId)).rejects.toThrow("incomplete");
    expect(fixture.saved.getItem(FILE_SHADOW_PILOT_JOURNAL_KEY)).not.toBeNull();
    const corrupt = JSON.parse(JSON.stringify(journal)) as PilotJournal;
    corrupt.request.key.consumerSubId = "changed";
    fixture.saved.setItem(FILE_SHADOW_PILOT_JOURNAL_KEY, JSON.stringify(corrupt));
    expect(() => fixture.client.loadJournal()).toThrow("saved operation cannot be read");
  });

  it("requires durable storage before withdrawal without preventing an independent pause", async () => {
    const fixture = setup(), proof = await baseline(fixture);
    fixture.fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(fixture.client.convert(proof)).rejects.toThrow("response was lost");
    const original = ticket(fixture.saved).request, calls = fixture.fetchMock.mock.calls.length;
    fixture.saved.setItem = () => { throw new Error("quota"); };
    await expect(fixture.client.withdrawOperation(original.operationId)).rejects.toThrow("Persistent browser storage");
    expect(fixture.fetchMock).toHaveBeenCalledTimes(calls);
    const current = await status(fixture);
    fixture.fetchMock.mockResolvedValueOnce(json(rawStatus(false)));
    await expect(fixture.client.pause(current)).resolves.toMatchObject({ enabled: false });
  });
});

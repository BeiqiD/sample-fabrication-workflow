import { describe, expect, it, vi } from "vitest";
import { shadowAdjudicationRequestSha256, shadowAdjudicationRevocationRequestSha256, type ShadowAdjudicationRequest, type ShadowAdjudicationRevocationRequest } from "../../shared/contracts/file-shadow-adjudication";
import { createFileShadowAdjudicationClient, FILE_SHADOW_ADJUDICATION_JOURNAL_KEY, adjudicationJournalIdentity, type AdjudicationReceipt } from "./file-shadow-adjudication-client";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = { consumerKind: "project_content_attachment" as const, consumerId: "历史\0reference", consumerSubId: "", fileSlot: "primary" as const };
const statements = { profileId: "r2-history", purposeStatement: "Current classification based on experiment notes.", namespaceStatement: "Deployment record binds the original locator to this profile.", evidenceReference: "Operator-supplied archive record, 2026-09-10." };
const conditions = { occurrenceId: "occurrence-1", generation: 1, sourceSha256: "a".repeat(64), sourceLocator: { storeKind: "r2" as const, provider: "r2" as const, objectKey: "original/source" }, expectedBaselineSha256: "b".repeat(64), expectedEpoch: 2, expectedIncarnation: uuid(2), supersedesId: null };
const prepare = () => ({ key, eligible: true, blockers: [], preconditions: conditions, profiles: [{ profileId: statements.profileId, configurationRevision: 1 }], activeAdjudication: null as AdjudicationReceipt | null, revocable: false, revocationBlockers: [] as string[] });
const original = (): ShadowAdjudicationRequest => ({ ...conditions, requestId: uuid(1), key, sourceProfile: { profileId: statements.profileId, configurationRevision: 1 }, purpose: "research_source", purposeStatement: statements.purposeStatement, namespaceStatement: statements.namespaceStatement, evidenceReference: statements.evidenceReference });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function accepted(request: ShadowAdjudicationRequest, status: "accepted" | "withdrawn" = "accepted"): Promise<AdjudicationReceipt> {
  return { requestId: request.requestId, status, request, requestSha256: await shadowAdjudicationRequestSha256(request), createdBy: "operator", createdAt: "2026-09-28T12:00:00.000Z", revocation: null };
}
async function revoked(receipt: AdjudicationReceipt, request: ShadowAdjudicationRevocationRequest): Promise<AdjudicationReceipt> {
  return { ...receipt, status: "revoked", revocation: { request, requestSha256: await shadowAdjudicationRevocationRequestSha256(request), createdBy: "operator", createdAt: "2026-09-28T12:05:00.000Z" } };
}
function memoryStorage() {
  const entries = new Map<string, string>();
  return { getItem: vi.fn((key: string) => entries.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }), removeItem: vi.fn((key: string) => { entries.delete(key); }), clear: () => entries.clear(), key: () => null, length: 0 } satisfies Storage;
}
function setup() {
  const storage = memoryStorage();
  let capability = true;
  let prepared = prepare();
  let handle: (path: string, value: unknown) => Promise<Response> = async (_path, value) => json(await accepted(value as ShadowAdjudicationRequest));
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url).split("/").at(-1)!;
    if (path === "capabilities") return json({ canAdjudicate: capability });
    if (path === "prepare") return json(prepared);
    return handle(path, JSON.parse(String(init?.body)));
  });
  const client = createFileShadowAdjudicationClient({ storage, fetch: fetcher, withLock: async (action) => action() });
  return { client, storage, fetcher, capability: (value: boolean) => { capability = value; }, prepared: (value: ReturnType<typeof prepare>) => { prepared = value; }, handler: (value: typeof handle) => { handle = value; } };
}
async function ready(set: ReturnType<typeof setup>) { await set.client.capabilities(); return set.client.prepare(key); }

describe("operator evidence decision client", () => {
  it("denies preparation and commands without capability and never accesses storage", async () => {
    const set = setup(); set.capability(false);
    expect(await set.client.capabilities()).toEqual({ canAdjudicate: false });
    await expect(set.client.prepare(key)).rejects.toThrow("Operator access");
    await expect(set.client.submit(prepare(), statements)).rejects.toThrow("Operator access");
    expect(() => set.client.loadJournal()).toThrow("Operator access");
    expect(set.fetcher).toHaveBeenCalledTimes(1); expect(set.storage.getItem).not.toHaveBeenCalled(); expect(set.storage.setItem).not.toHaveBeenCalled();
  });

  it("preserves the exact original request before dispatch and validates its receipt digest", async () => {
    const set = setup(), prepared = await ready(set);
    set.handler(async (path, value) => {
      expect(path).toBe("accept");
      const saved = JSON.parse(set.storage.getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY)!);
      expect(saved.request).toEqual(value); expect(saved.receipt).toBeNull(); expect(saved.request.key.consumerId).toBe(key.consumerId);
      return json(await accepted(value as ShadowAdjudicationRequest));
    });
    const result = await set.client.submit(prepared, statements);
    expect(result.status).toBe("accepted"); expect(set.client.loadJournal()?.receipt?.requestSha256).toBe(await shadowAdjudicationRequestSha256(result.request));
    expect(set.storage.getItem.mock.calls.every(([name]) => name.startsWith(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY))).toBe(true);
  });

  it("retains lost acknowledgements and absent receipts until durable withdrawal seals the original ID", async () => {
    const set = setup(), prepared = await ready(set);
    set.handler(async () => { throw new Error("Network lost"); });
    await expect(set.client.submit(prepared, statements)).rejects.toThrow("response was lost");
    const saved = set.client.loadJournal()!, identity = adjudicationJournalIdentity(saved);
    expect(saved.receipt).toBeNull();
    set.handler(async () => json({ error: "missing" }, 404));
    await expect(set.client.inspect(identity)).rejects.toThrow("No receipt is visible");
    await expect(set.client.dismiss(identity)).rejects.toThrow("cannot be dismissed");
    await expect(set.client.submit(await set.client.prepare(key), statements)).rejects.toThrow("saved evidence request");
    expect(set.client.loadJournal()?.request).toEqual(saved.request);
    set.handler(async (path, value) => { expect(path).toBe("withdraw"); expect(value).toEqual(saved.request); return json(await accepted(value as ShadowAdjudicationRequest, "withdrawn")); });
    expect((await set.client.withdraw(identity)).status).toBe("withdrawn");
    await set.client.dismiss(identity); expect(set.client.loadJournal()).toBeNull();
  });

  it("treats withdrawal of an already accepted request as an accepted decision", async () => {
    const set = setup(), prepared = await ready(set);
    set.handler(async () => { throw new Error("lost"); }); await expect(set.client.submit(prepared, statements)).rejects.toThrow();
    const identity = adjudicationJournalIdentity(set.client.loadJournal()!);
    set.handler(async (_path, value) => json(await accepted(value as ShadowAdjudicationRequest)));
    expect((await set.client.withdraw(identity)).status).toBe("accepted"); expect(set.client.loadJournal()?.receipt?.status).toBe("accepted");
  });

  it.each(["wrong-request", "wrong-digest", "extra-field", "wrong-status", "wrong-time", "wrong-revocation-digest"])("rejects %s responses while preserving the saved original", async (variant) => {
    const set = setup(), prepared = await ready(set);
    set.handler(async (_path, value) => {
      const request = value as ShadowAdjudicationRequest;
      let receipt: unknown = await accepted(request);
      if (variant === "wrong-request") receipt = await accepted({ ...request, purposeStatement: "different" });
      if (variant === "wrong-digest") receipt = { ...receipt as object, requestSha256: "0".repeat(64) };
      if (variant === "wrong-status") receipt = { ...receipt as object, status: ["accepted"] };
      if (variant === "wrong-time") receipt = { ...receipt as object, createdAt: "invalid" };
      if (variant === "extra-field") receipt = { ...receipt as object, secret: "private" };
      if (variant === "wrong-revocation-digest") receipt = { ...receipt as object, status: "revoked", revocation: { request: { requestId: uuid(8), adjudicationId: request.requestId, adjudicationRequestSha256: "0".repeat(64), reason: "correct" }, requestSha256: "0".repeat(64), createdBy: "operator", createdAt: "2026-09-28" } };
      return json(receipt);
    });
    await expect(set.client.submit(prepared, statements)).rejects.toThrow("incomplete or unsupported");
    expect(set.client.loadJournal()?.request.purposeStatement).toBe(statements.purposeStatement); expect(set.client.loadJournal()?.receipt).toBeNull();
  });

  it("fences a stale tab identity before dispatch and refuses to overwrite a journal changed during dispatch", async () => {
    const set = setup(), prepared = await ready(set);
    set.handler(async () => { throw new Error("lost"); }); await expect(set.client.submit(prepared, statements)).rejects.toThrow();
    const old = set.client.loadJournal()!, identity = adjudicationJournalIdentity(old);
    const other = { ...old, request: { ...old.request, requestId: uuid(20) } };
    set.storage.setItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY, JSON.stringify(other));
    const before = set.fetcher.mock.calls.length;
    await expect(set.client.withdraw(identity)).rejects.toThrow("another tab");
    expect(set.fetcher).toHaveBeenCalledTimes(before);
    set.handler(async (_path, value) => {
      set.storage.setItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY, JSON.stringify(old));
      return json(await accepted(value as ShadowAdjudicationRequest));
    });
    await expect(set.client.inspect(adjudicationJournalIdentity(other))).rejects.toThrow("changed or could not be preserved");
    expect(set.client.loadJournal()?.request).toEqual(old.request);
  });

  it("retains an immutable failed revocation until readback or explicit retry confirms it", async () => {
    const set = setup(), receipt = await accepted(original());
    set.prepared({ ...prepare(), eligible: false, activeAdjudication: receipt, revocable: true });
    const prepared = await ready(set);
    set.handler(async () => { throw new Error("lost"); });
    await expect(set.client.revoke(prepared, "Correct the cited historical record.")).rejects.toThrow("response was lost");
    const saved = set.client.loadRevocations()[0], identity = adjudicationJournalIdentity(saved);
    expect(set.client.loadJournal()).toBeNull();
    expect(saved.revocationRequest?.reason).toBe("Correct the cited historical record.");
    set.handler(async () => json({ error: "absent" }, 404)); await expect(set.client.inspectRevocation(identity)).rejects.toThrow("No revocation receipt is visible");
    await expect(set.client.dismissRevocation(identity)).rejects.toThrow("unconfirmed revocation");
    set.handler(async (path, value) => { expect(path).toBe("revoke"); expect(value).toEqual(saved.revocationRequest); return json(await revoked(receipt, value as ShadowAdjudicationRevocationRequest)); });
    expect((await set.client.retryRevocation(identity)).status).toBe("revoked");
    await set.client.dismissRevocation(identity); expect(set.client.loadRevocations()).toEqual([]);
  });

  it("requires fresh untouched preparation and explicit profile selection", async () => {
    const set = setup(), prepared = await ready(set);
    await expect(set.client.submit(prepared, { ...statements, profileId: "" })).rejects.toThrow("Choose one");
    prepared.preconditions!.generation += 1;
    await expect(set.client.submit(prepared, statements)).rejects.toThrow("fresh decision prerequisites");
    expect(set.client.loadJournal()).toBeNull();
  });

  it("refuses malformed or oversized saved journal before sending anything", async () => {
    const set = setup(); await ready(set);
    set.storage.setItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY, "x".repeat(512 * 1024 + 1));
    expect(() => set.client.loadJournal()).toThrow("cannot be read");
    expect(set.fetcher).toHaveBeenCalledTimes(2);
  });

  it("requires actual browser coordination when no lock implementation is provided", async () => {
    const set = setup(), client = createFileShadowAdjudicationClient({ fetch: set.fetcher, storage: set.storage });
    await client.capabilities(); const prepared = await client.prepare(key);
    vi.stubGlobal("navigator", {});
    try { await expect(client.submit(prepared, statements)).rejects.toThrow("Web Locks"); expect(set.storage.setItem).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
});

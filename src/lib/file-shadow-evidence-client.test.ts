import { describe, expect, it, vi } from "vitest";
import { createFileShadowEvidenceClient } from "./file-shadow-evidence-client";

const key = (id = "reference-a") => ({ consumerKind: "project_content_attachment", consumerId: id, consumerSubId: "", fileSlot: "primary" });
const label = { projectId: "project-a", projectTitle: "Original project", attachmentName: "historical.png" };
const row = (id = "reference-a") => ({ consumer_kind: "project_content_attachment", consumer_id: id, consumer_sub_id: "", file_slot: "primary", generation: 1, occurrence_id: `occurrence-${id}`, state: "pending", identification: label });
const review = (id = "reference-a") => ({ version: 1, kind: "file-shadow-evidence-review", readOnly: true, bytesVerified: false,
  key: key(id), head: { generation: 1, occurrenceId: `occurrence-${id}`, sourceMetadataSha256: "a".repeat(64) },
  baselineSha256: "b".repeat(64), status: "ambiguous", reasons: ["consumer_purpose_unresolved", "namespace_evidence_missing"],
  identification: label, purpose: null, expectedBytes: 871, expectedSha256: "c".repeat(64), sourceProvider: "r2", sourceProfile: null, peerReferences: [] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=UTF-8" } });

describe("read-only historical evidence client", () => {
  it("only requests bounded metadata reads with authenticated no-store, same-origin fetch", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ records: [row()], nextCursor: null })).mockResolvedValueOnce(json(review()));
    const client = createFileShadowEvidenceClient({ fetch: network });
    expect((await client.listConsumers()).records[0].identification).toEqual(label);
    expect(await client.getEvidence(key())).toEqual(review());
    expect(network.mock.calls.map(([path]) => path)).toEqual(["/api/files/shadow/consumers?limit=20", "/api/files/shadow/evidence-review"]);
    for (const [, init] of network.mock.calls) expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", redirect: "error" });
    expect(network.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ key: key() }) });
  });

  it("preserves empty, NUL and Unicode typed IDs and detaches the request before awaiting", async () => {
    const original = key("历史\0key"); original.consumerSubId = "";
    const response = review("历史\0key"); response.head.occurrenceId = "historical-occurrence";
    let resolve!: (value: Response) => void;
    const network = vi.fn<typeof fetch>(() => new Promise((accept) => { resolve = accept; }));
    const promise = createFileShadowEvidenceClient({ fetch: network }).getEvidence(original);
    original.consumerId = "changed-after-request";
    resolve(json(response));
    expect((await promise).key.consumerId).toBe("历史\0key");
    expect(JSON.parse(String(network.mock.calls[0][1]?.body)).key.consumerId).toBe("历史\0key");
  });

  it("rejects a mismatched selected key and unsupported request kinds", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(json(review("other")));
    const client = createFileShadowEvidenceClient({ fetch: network });
    await expect(client.getEvidence(key())).rejects.toThrow("incomplete or unsupported");
    await expect(client.getEvidence({ ...key(), consumerKind: "event" })).rejects.toThrow("incomplete or unsupported");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each([
    (value: Record<string, unknown>) => { value.privateObjectKey = "PRIVATE"; },
    (value: Record<string, unknown>) => { value.bytesVerified = true; },
    (value: Record<string, unknown>) => { value.readOnly = false; },
    (value: Record<string, unknown>) => { value.identification = { ...label, namespace: "PRIVATE" }; },
    (value: Record<string, unknown>) => { value.sourceProfile = { profileId: "profile", configurationRevision: 1, namespace: "PRIVATE" }; },
  ])("rejects unsafe or misleading metadata projections", async (change) => {
    const value: Record<string, unknown> = review(); change(value);
    const client = createFileShadowEvidenceClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(json(value)) });
    await expect(client.getEvidence(key())).rejects.toThrow("incomplete or unsupported");
  });

  it("keeps generic pagination keys and optional identification compatible without inferring labels", async () => {
    const oldRow: Partial<ReturnType<typeof row>> = row(); delete oldRow.identification;
    const cursor = { consumerKind: "event", consumerId: "old\0事件", consumerSubId: "", fileSlot: "thumbnail" };
    const network = vi.fn<typeof fetch>().mockResolvedValue(json({ records: [oldRow], nextCursor: null }));
    const page = await createFileShadowEvidenceClient({ fetch: network }).listConsumers(cursor);
    expect(page.records[0].identification).toBeNull();
    const url = new URL(String(network.mock.calls[0][0]), "https://app.example");
    expect(JSON.parse(url.searchParams.get("after")!)).toEqual(cursor);
  });

  it.each([
    { records: [row(), row()], nextCursor: null },
    { records: [row()], nextCursor: key() },
    { records: Array.from({ length: 21 }, (_, index) => row(String(index))), nextCursor: null },
    { records: [{ ...row(), object_key: "PRIVATE" }], nextCursor: null },
    { records: [{ ...row(), state: ["pending"] }], nextCursor: null },
    { records: [{ ...row(), identification: { ...label, projectTitle: "x".repeat(4097) } }], nextCursor: null },
  ])("rejects invalid pagination and extra list metadata", async (value) => {
    const client = createFileShadowEvidenceClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(json(value)) });
    await expect(client.listConsumers()).rejects.toThrow("incomplete or unsupported");
  });

  it("cancels an oversized streamed body even without a Content-Length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); }, cancel });
    const client = createFileShadowEvidenceClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { "content-type": "application/json" } })) });
    await expect(client.getEvidence(key())).rejects.toThrow("incomplete or unsupported");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "524289" } }),
  ])("rejects login documents, malformed encoding and excessive declared size", async (response) => {
    await expect(createFileShadowEvidenceClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response) }).getEvidence(key())).rejects.toThrow("incomplete or unsupported");
  });

  it.each([401, 403])("returns a fixed access error without exposing the server payload (%s)", async (status) => {
    const client = createFileShadowEvidenceClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(json({ error: "SECRET_ACTOR_AND_LOCATOR" }, status)) });
    await expect(client.getEvidence(key())).rejects.toThrow("Access is unavailable. Sign in again, then read the evidence.");
  });
});

import {
  checkedFileShadowEvidenceReview, checkedFileShadowIdentification, checkedFileShadowReviewKey,
  type FileShadowEvidenceReview, type FileShadowIdentification, type FileShadowReviewKey,
} from "../../shared/contracts/file-shadow-evidence-review";

export interface EvidenceConsumer {
  key: FileShadowReviewKey;
  generation: number;
  occurrenceId: string;
  state: "pending" | "resolved" | "admitted_unresolved";
  identification: FileShadowIdentification | null;
}
export interface EvidenceConsumerPage { records: EvidenceConsumer[]; nextCursor: FileShadowReviewKey | null }
const MAX_RESPONSE_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const responseMessage = "The evidence response is incomplete or unsupported. Refresh the list and read the reference again.";
export class FileShadowEvidenceError extends Error {
  constructor(message: string) { super(message); this.name = "FileShadowEvidenceError"; }
}
function fail(message = responseMessage): never { throw new FileShadowEvidenceError(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, names: readonly string[]) {
  const keys = Object.keys(value).sort(), expected = [...names].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail();
}
function text(value: unknown, max = 256, empty = false): string {
  return typeof value === "string" && (empty || value.length > 0) && encoder.encode(value).length <= max ? value : fail();
}
// Pagination includes every consumer kind. Unlike review requests, these keys
// must not narrow historical identities to Project references or UUID syntax.
function consumerKey(value: unknown): FileShadowReviewKey {
  const raw = object(value); exact(raw, ["consumerKind", "consumerId", "consumerSubId", "fileSlot"]);
  const key = { consumerKind: text(raw.consumerKind, 65536, true), consumerId: text(raw.consumerId, 65536, true),
    consumerSubId: text(raw.consumerSubId, 65536, true), fileSlot: text(raw.fileSlot, 65536, true) };
  if (encoder.encode(JSON.stringify(key)).length > 65536) fail();
  return key;
}
const keyText = (key: FileShadowReviewKey) => JSON.stringify(key);

/** This client has read capabilities only. It never opens browser storage,
 * obtains a conversion lock, or handles an operation journal. */
export function createFileShadowEvidenceClient(options: { fetch?: typeof fetch } = {}) {
  const fetcher = options.fetch ?? ((...args) => fetch(...args));
  async function read(path: string, payload?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`/api/files/shadow/${path}`, {
        cache: "no-store", credentials: "same-origin", redirect: "error",
        ...(payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
      });
    } catch { return fail("Evidence could not be read. Check your connection and retry this read."); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) fail("Access is unavailable. Sign in again, then read the evidence.");
      if (response.status === 404) fail("This reference is no longer available. Refresh the list to find current references.");
      fail("Evidence is unavailable. Refresh the list and retry the selected reference.");
    }
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) fail();
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
        await response.body.cancel(); fail();
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); fail(); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const joined = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    } catch { return fail(); }
  }
  return {
    async listConsumers(after: FileShadowReviewKey | null = null): Promise<EvidenceConsumerPage> {
      const cursor = after === null ? null : consumerKey(after);
      const raw = object(await read(`consumers?limit=20${cursor ? `&after=${encodeURIComponent(keyText(cursor))}` : ""}`));
      exact(raw, ["records", "nextCursor"]);
      if (!Array.isArray(raw.records) || raw.records.length > 20) fail();
      const records = raw.records.map((value): EvidenceConsumer => {
        const row = object(value);
        exact(row, ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "generation", "occurrence_id", "state",
          ...(Object.hasOwn(row, "identification") ? ["identification"] : [])]);
        if (!Number.isSafeInteger(row.generation) || (row.generation as number) < 1 || typeof row.state !== "string"
          || !["pending", "resolved", "admitted_unresolved"].includes(row.state)) fail();
        let identification: FileShadowIdentification | null = null;
        try { if (row.identification != null) identification = checkedFileShadowIdentification(row.identification); }
        catch { fail(); }
        return { key: consumerKey({ consumerKind: row.consumer_kind, consumerId: row.consumer_id,
          consumerSubId: row.consumer_sub_id, fileSlot: row.file_slot }), generation: row.generation as number,
          occurrenceId: text(row.occurrence_id), state: row.state as EvidenceConsumer["state"], identification };
      });
      if (new Set(records.map((record) => keyText(record.key))).size !== records.length) fail();
      const nextCursor = raw.nextCursor === null ? null : consumerKey(raw.nextCursor);
      if (nextCursor && (records.length !== 20 || keyText(records.at(-1)!.key) !== keyText(nextCursor)
        || cursor && keyText(cursor) === keyText(nextCursor))) fail();
      return { records, nextCursor };
    },
    async getEvidence(input: FileShadowReviewKey): Promise<FileShadowEvidenceReview> {
      let key: FileShadowReviewKey;
      try { key = checkedFileShadowReviewKey(input); } catch { return fail(); }
      const raw = await read("evidence-review", { key });
      try {
        const result = checkedFileShadowEvidenceReview(raw);
        if (keyText(result.key) !== keyText(key)) fail();
        return result;
      } catch { return fail(); }
    },
  };
}

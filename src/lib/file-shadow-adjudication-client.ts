import { applicationFetch } from "./authentication-client";
import {
  checkedShadowAdjudicationRequest, checkedShadowAdjudicationRevocationRequest,
  shadowAdjudicationRequestSha256, shadowAdjudicationRevocationRequestSha256,
  type ShadowAdjudicationRequest, type ShadowAdjudicationRevocationRequest,
} from "../../shared/contracts/file-shadow-adjudication";
import { checkedFileShadowReviewKey, type FileShadowReviewKey } from "../../shared/contracts/file-shadow-evidence-review";
import { stableJson } from "../../shared/domain/content-addressing";
import { createUuid } from "./uuid";

export interface AdjudicationReceipt {
  requestId: string; status: "accepted" | "revoked" | "withdrawn";
  request: ShadowAdjudicationRequest; requestSha256: string; createdBy: string; createdAt: string;
  revocation: { request: ShadowAdjudicationRevocationRequest; requestSha256: string; createdBy: string; createdAt: string } | null;
}
export interface AdjudicationPreparation {
  key: FileShadowReviewKey; eligible: boolean; blockers: string[];
  preconditions: Omit<ShadowAdjudicationRequest, "requestId" | "key" | "sourceProfile" | "purpose" | "purposeStatement" | "namespaceStatement" | "evidenceReference"> | null;
  profiles: Array<{ profileId: string; configurationRevision: 1 }>;
  activeAdjudication: AdjudicationReceipt | null; revocable: boolean; revocationBlockers: string[];
}
export interface AdjudicationStatements { profileId: string; purposeStatement: string; namespaceStatement: string; evidenceReference: string }
export interface AdjudicationJournal {
  version: 1; request: ShadowAdjudicationRequest; receipt: AdjudicationReceipt | null;
  revocationRequest: ShadowAdjudicationRevocationRequest | null;
}
export const FILE_SHADOW_ADJUDICATION_JOURNAL_KEY = "file-shadow-evidence-adjudication-v1";
export const FILE_SHADOW_REVOCATION_JOURNAL_KEY = `${FILE_SHADOW_ADJUDICATION_JOURNAL_KEY}:revocations`;
const MAX_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
export class FileShadowAdjudicationError extends Error {
  constructor(message: string) { super(message); this.name = "FileShadowAdjudicationError"; }
}
function fail(message = "The evidence decision response is incomplete or unsupported. Keep the saved request and inspect it again."): never {
  throw new FileShadowAdjudicationError(message);
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
function exact(raw: Record<string, unknown>, keys: string[]) {
  if (!same(Object.keys(raw).sort(), [...keys].sort())) fail();
}
function text(value: unknown, limit = 65536): string {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).length <= limit ? value : fail();
}
function actor(value: unknown): string {
  const result = text(value, 1024);
  if (result.length > 256 || !result.trim() || result.includes("\0")) fail();
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 128);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) fail();
  return result;
}
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : fail();
function checkedRequest(value: unknown): ShadowAdjudicationRequest {
  try { return checkedShadowAdjudicationRequest(value); } catch { return fail(); }
}
function checkedRevocation(value: unknown): ShadowAdjudicationRevocationRequest {
  try { return checkedShadowAdjudicationRevocationRequest(value); } catch { return fail(); }
}
function parseReceipt(value: unknown, expected?: ShadowAdjudicationRequest): AdjudicationReceipt {
  const raw = object(value);
  exact(raw, ["requestId", "status", "request", "requestSha256", "createdBy", "createdAt", "revocation"]);
  const request = checkedRequest(raw.request);
  if (raw.requestId !== request.requestId || expected && !same(request, expected)
    || typeof raw.status !== "string" || !["accepted", "revoked", "withdrawn"].includes(raw.status)) fail();
  let revocation: AdjudicationReceipt["revocation"] = null;
  if (raw.revocation !== null) {
    const rev = object(raw.revocation); exact(rev, ["request", "requestSha256", "createdBy", "createdAt"]);
    const revokeRequest = checkedRevocation(rev.request);
    if (revokeRequest.adjudicationId !== request.requestId || revokeRequest.adjudicationRequestSha256 !== raw.requestSha256) fail();
    revocation = { request: revokeRequest, requestSha256: sha(rev.requestSha256), createdBy: actor(rev.createdBy), createdAt: timestamp(rev.createdAt) };
  }
  if ((raw.status === "revoked") !== (revocation !== null)) fail();
  return { requestId: request.requestId, status: raw.status as AdjudicationReceipt["status"], request,
    requestSha256: sha(raw.requestSha256), createdBy: actor(raw.createdBy), createdAt: timestamp(raw.createdAt), revocation };
}
async function verifyReceipt(value: unknown, expected?: ShadowAdjudicationRequest) {
  const receipt = parseReceipt(value, expected);
  if (receipt.requestSha256 !== await shadowAdjudicationRequestSha256(receipt.request)
    || receipt.revocation && receipt.revocation.requestSha256 !== await shadowAdjudicationRevocationRequestSha256(receipt.revocation.request)) fail();
  return receipt;
}
function parseJournal(value: unknown): AdjudicationJournal {
  const raw = object(value); exact(raw, ["version", "request", "receipt", "revocationRequest"]);
  if (raw.version !== 1 || size(raw) > MAX_BYTES) fail();
  const request = checkedRequest(raw.request), receipt = raw.receipt === null ? null : parseReceipt(raw.receipt, request);
  const revocationRequest = raw.revocationRequest === null ? null : checkedRevocation(raw.revocationRequest);
  if (revocationRequest && (revocationRequest.adjudicationId !== request.requestId || !receipt || receipt.status === "withdrawn"
    || revocationRequest.adjudicationRequestSha256 !== receipt.requestSha256
    || receipt.revocation && !same(receipt.revocation.request, revocationRequest))) fail();
  return { version: 1, request, receipt, revocationRequest };
}
export function adjudicationJournalIdentity(journal: AdjudicationJournal): string {
  return JSON.stringify({ request: journal.request, revocationRequest: journal.revocationRequest });
}
export function canDismissAdjudication(journal: AdjudicationJournal): boolean {
  return journal.receipt !== null && (!journal.revocationRequest || journal.receipt.status === "revoked");
}

/** Separate operator journal. The existing conversion journal is never opened. */
export function createFileShadowAdjudicationClient(options: {
  fetch?: typeof fetch; storage?: Storage; withLock?: <T>(action: () => Promise<T>) => Promise<T>;
} = {}) {
  const fetcher = options.fetch ?? ((...args) => applicationFetch(...args));
  let authorized = false;
  let preparations = new WeakMap<AdjudicationPreparation, string>();
  const receipts = new WeakMap<AdjudicationReceipt, string>();
  function authorize() { if (!authorized) fail("Operator access is unavailable. You can continue reviewing evidence without recording a decision."); }
  const storage = () => {
    try { return options.storage ?? localStorage; } catch { return fail("Persistent browser storage is unavailable. No decision was sent."); }
  };
  function loadJournal(): AdjudicationJournal | null {
    authorize();
    try {
      const stored = storage().getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY);
      if (stored === null) return null;
      if (encoder.encode(stored).length > MAX_BYTES) fail();
      return parseJournal(JSON.parse(stored));
    } catch { return fail("The saved evidence request cannot be read. Keep browser storage intact and resolve it before recording another decision."); }
  }
  function loadRevocations(): AdjudicationJournal[] {
    authorize();
    try {
      const stored = storage().getItem(FILE_SHADOW_REVOCATION_JOURNAL_KEY);
      if (stored === null) return [];
      if (encoder.encode(stored).length > MAX_BYTES) fail();
      const raw = object(JSON.parse(stored)); exact(raw, ["version", "requests"]);
      if (raw.version !== 1 || !Array.isArray(raw.requests) || raw.requests.length > 32) fail();
      const requests = raw.requests.map(parseJournal);
      if (requests.some((entry) => !entry.revocationRequest) || new Set(requests.map((entry) => entry.request.requestId)).size !== requests.length) fail();
      return requests;
    } catch { return fail("Saved revocations cannot be read. Keep browser storage intact and restore access before recording more decisions."); }
  }
  function persistRevocations(next: AdjudicationJournal[], previous: AdjudicationJournal[]) {
    try {
      if (!same(loadRevocations(), previous) || next.length > 32) fail();
      const value = JSON.stringify({ version: 1, requests: next.map(parseJournal) });
      if (encoder.encode(value).length > MAX_BYTES) fail();
      storage().setItem(FILE_SHADOW_REVOCATION_JOURNAL_KEY, value);
      if (storage().getItem(FILE_SHADOW_REVOCATION_JOURNAL_KEY) !== value) fail();
    } catch { fail("Saved revocations changed or could not be preserved. Reload their state before continuing."); }
  }
  function expectedRevocation(identity: string) {
    const entries = loadRevocations(), journal = entries.find((entry) => adjudicationJournalIdentity(entry) === identity);
    if (!journal) fail("The saved revocation changed in another tab. Reload and review it before continuing.");
    return { entries, journal };
  }
  function persist(journal: AdjudicationJournal, previous: AdjudicationJournal | null) {
    try {
      if (!same(loadJournal(), previous)) fail();
      const value = JSON.stringify(parseJournal(journal));
      storage().setItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY, value);
      if (storage().getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY) !== value) fail();
    } catch { fail("The saved evidence request changed or could not be preserved. Reload its saved state before continuing."); }
  }
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    authorize();
    if (options.withLock) return options.withLock(action);
    if (typeof navigator === "undefined" || !navigator.locks) return fail("This browser cannot safely coordinate evidence decisions. Use a browser with Web Locks support.");
    return navigator.locks.request(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY, { mode: "exclusive", ifAvailable: true }, (lock) => {
      if (!lock) return fail("Another tab is handling an evidence request. Reload its saved state after it finishes.");
      return action();
    });
  }
  async function request(path: string, payload?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`/api/files/shadow/evidence/${path}`, { cache: "no-store", credentials: "same-origin", redirect: "error",
        ...(payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }) });
    } catch { return fail("The response was lost. Keep the saved request and inspect its receipt before continuing."); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) { authorized = false; return fail("Operator access is unavailable. Keep any saved request until access is restored."); }
      if (response.status === 404 && path === "revocation/request") return fail("No revocation receipt is visible yet. Keep this exact request and inspect or retry it; unrelated decisions can continue.");
      if (response.status === 404 && path === "request") return fail("No receipt is visible yet. Keep this request; inspect again or explicitly withdraw it before dismissing it.");
      return fail("The evidence action was not confirmed. Keep any saved request and inspect its receipt; reread the reference before a new decision.");
    }
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) fail();
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) { await response.body.cancel(); fail(); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength; if (length > MAX_BYTES) { await reader.cancel(); fail(); } chunks.push(chunk.value); }
      } finally { reader.releaseLock(); }
      const joined = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    } catch { return fail(); }
  }
  function expectedJournal(identity: string) {
    const journal = loadJournal();
    if (!journal || adjudicationJournalIdentity(journal) !== identity) fail("The saved request changed in another tab. Reload and review it before continuing.");
    return journal;
  }
  function checkedPreparation(value: AdjudicationPreparation) {
    if (preparations.get(value) !== JSON.stringify(value)) fail("Read fresh decision prerequisites for this attachment before continuing.");
  }
  async function storeResult(value: unknown, journal: AdjudicationJournal, revocations?: AdjudicationJournal[]) {
    const receipt = await verifyReceipt(value, journal.request);
    if (journal.receipt && (receipt.createdBy !== journal.receipt.createdBy || receipt.createdAt !== journal.receipt.createdAt
      || receipt.requestSha256 !== journal.receipt.requestSha256)) fail();
    if (journal.receipt && (journal.receipt.status !== "accepted" && !same(receipt, journal.receipt)
      || receipt.status === "withdrawn" && journal.receipt.status === "accepted")) fail();
    if (journal.revocationRequest && receipt.revocation && !same(receipt.revocation.request, journal.revocationRequest)) fail();
    if (revocations) persistRevocations(revocations.map((entry) => entry === journal ? { ...journal, receipt } : entry), revocations);
    else persist({ ...journal, receipt }, journal); receipts.set(receipt, JSON.stringify(receipt)); return receipt;
  }
  const client = {
    async capabilities() {
      authorized = false;
      const raw = object(await request("capabilities")); exact(raw, ["canAdjudicate"]);
      if (typeof raw.canAdjudicate !== "boolean") fail();
      authorized = raw.canAdjudicate; return { canAdjudicate: authorized };
    },
    async prepare(input: FileShadowReviewKey): Promise<AdjudicationPreparation> {
      authorize();
      const key = checkedFileShadowReviewKey(input), raw = object(await request("prepare", { key }));
      exact(raw, ["key", "eligible", "blockers", "preconditions", "profiles", "activeAdjudication", "revocable", "revocationBlockers"]);
      if (!same(checkedFileShadowReviewKey(raw.key), key) || typeof raw.eligible !== "boolean" || !Array.isArray(raw.blockers)
        || raw.blockers.length > 100 || typeof raw.revocable !== "boolean" || !Array.isArray(raw.revocationBlockers) || raw.revocationBlockers.length > 100 || !Array.isArray(raw.profiles) || raw.profiles.length > 100) fail();
      const profiles = raw.profiles.map((value) => { const profile = object(value); exact(profile, ["profileId", "configurationRevision"]);
        const profileId = text(profile.profileId, 1024);
        if (profile.configurationRevision !== 1 || profileId.length > 256 || profileId.includes("\0")) fail();
        return { profileId, configurationRevision: 1 as const }; });
      if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) fail();
      let preconditions: AdjudicationPreparation["preconditions"] = null;
      if (raw.preconditions !== null) {
        // Validate the exact captured fields using the same canonical request parser.
        const source = object(raw.preconditions);
        const parsed = checkedRequest({ ...source, requestId: source.supersedesId === "11111111-1111-4111-8111-111111111111" ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111", key,
          sourceProfile: profiles[0] ?? { profileId: "validation-only", configurationRevision: 1 }, purpose: "research_source",
          purposeStatement: "validation", namespaceStatement: "validation", evidenceReference: "validation" });
        const { requestId: _requestId, key: _key, sourceProfile: _profile, purpose: _purpose,
          purposeStatement: _purposeStatement, namespaceStatement: _namespaceStatement, evidenceReference: _evidenceReference, ...rest } = parsed;
        if (!same(Object.keys(rest).sort(), Object.keys(source).sort())) fail();
        preconditions = rest;
      }
      const activeAdjudication = raw.activeAdjudication === null ? null : await verifyReceipt(raw.activeAdjudication);
      if (activeAdjudication && (!same(activeAdjudication.request.key, key) || activeAdjudication.status !== "accepted")) fail();
      if (activeAdjudication) receipts.set(activeAdjudication, JSON.stringify(activeAdjudication));
      const result: AdjudicationPreparation = { key, eligible: raw.eligible, blockers: raw.blockers.map((value) => text(value, 256)), preconditions, profiles, activeAdjudication, revocable: raw.revocable, revocationBlockers: raw.revocationBlockers.map((value) => text(value, 256)) };
      if (result.eligible && (!preconditions || !profiles.length || result.blockers.length || activeAdjudication)) fail();
      if (result.revocable && (!activeAdjudication || result.revocationBlockers.length)) fail();
      preparations.set(result, JSON.stringify(result)); return result;
    },
    submit: (prepared: AdjudicationPreparation, statements: AdjudicationStatements) => locked(async () => {
      checkedPreparation(prepared);
      if (!prepared.eligible || !prepared.preconditions) fail("This attachment is not ready for an evidence decision. Reread its prerequisites.");
      if (loadJournal()) fail("Resolve and dismiss the saved evidence request before recording another decision.");
      loadRevocations();
      const profile = prepared.profiles.find((candidate) => candidate.profileId === statements.profileId);
      if (!profile) fail("Choose one of the reviewed storage profiles.");
      const requestBody = checkedRequest({ ...prepared.preconditions, requestId: createUuid(), key: prepared.key, sourceProfile: profile,
        purpose: "research_source", purposeStatement: statements.purposeStatement, namespaceStatement: statements.namespaceStatement, evidenceReference: statements.evidenceReference });
      const journal: AdjudicationJournal = { version: 1, request: requestBody, receipt: null, revocationRequest: null };
      persist(journal, null); preparations = new WeakMap();
      return storeResult(await request("accept", journal.request), journal);
    }),
    inspect: (identity: string) => locked(async () => {
      const journal = expectedJournal(identity); return storeResult(await request("request", journal.request), journal);
    }),
    withdraw: (identity: string) => locked(async () => {
      const journal = expectedJournal(identity);
      if (journal.receipt || journal.revocationRequest) fail("Only an unconfirmed original request can be withdrawn. Inspect its receipt first.");
      preparations = new WeakMap();
      return storeResult(await request("withdraw", journal.request), journal);
    }),
    revoke: (prepared: AdjudicationPreparation, reason: string) => locked(async () => {
      checkedPreparation(prepared);
      const receipt = prepared.activeAdjudication;
      if (!prepared.revocable || !receipt || receipts.get(receipt) !== JSON.stringify(receipt)) fail("Read the current accepted decision before revoking it.");
      if (loadJournal()) fail("Resolve and dismiss the saved evidence request before starting a revocation.");
      const existing = loadRevocations();
      if (existing.some((entry) => entry.request.requestId === receipt.requestId)) fail("A saved revocation already exists for this decision. Inspect or retry that exact request.");
      const revocationRequest = checkedRevocation({ requestId: createUuid(), adjudicationId: receipt.requestId,
        adjudicationRequestSha256: receipt.requestSha256, reason });
      const journal: AdjudicationJournal = { version: 1, request: receipt.request, receipt, revocationRequest };
      const entries = [...existing, journal];
      persistRevocations(entries, existing); preparations = new WeakMap();
      return storeResult(await request("revoke", revocationRequest), journal, entries);
    }),
    inspectRevocation: (identity: string) => locked(async () => {
      const { entries, journal } = expectedRevocation(identity);
      return storeResult(await request("revocation/request", journal.revocationRequest), journal, entries);
    }),
    retryRevocation: (identity: string) => locked(async () => {
      const { entries, journal } = expectedRevocation(identity);
      if (!journal.revocationRequest || journal.receipt?.status !== "accepted") fail("Inspect this saved revocation before continuing.");
      return storeResult(await request("revoke", journal.revocationRequest), journal, entries);
    }),
    dismissRevocation: (identity: string) => locked(async () => {
      const { entries, journal } = expectedRevocation(identity);
      if (journal.receipt?.status !== "revoked") fail("Keep this unconfirmed revocation. Inspect or retry its exact request; unrelated evidence decisions can continue.");
      await verifyReceipt(journal.receipt, journal.request);
      persistRevocations(entries.filter((entry) => entry !== journal), entries);
    }),
    dismiss: (identity: string) => locked(async () => {
      const journal = expectedJournal(identity);
      if (!canDismissAdjudication(journal)) fail("An unconfirmed request cannot be dismissed. Inspect it or complete a durable withdrawal first.");
      await verifyReceipt(journal.receipt, journal.request);
      if (!same(loadJournal(), journal)) fail("The saved request changed in another tab. Reload it before continuing.");
      try {
        storage().removeItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY);
        if (storage().getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY) !== null) fail();
      } catch { fail("The receipt could not be dismissed. Keep it and reload the saved request."); }
      preparations = new WeakMap();
    }),
    loadJournal, loadRevocations,
  };
  return client;
}
export type FileShadowAdjudicationClient = ReturnType<typeof createFileShadowAdjudicationClient>;

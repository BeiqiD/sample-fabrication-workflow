import { checkpointStorage, type CheckpointStorage } from "../lib/browser-checkpoints";
import { captureApplicationOwner } from "../lib/authentication-client";
import { useEffect, useRef, useState } from "react";
import type { StorageCandidate } from "../../shared/contracts/storage-configuration";
import type { StorageCandidateReadiness } from "../../shared/contracts/storage-candidate-readiness";
import { checkedStorageProfileAdmissionInput, type StorageProfileAdmissionInput, type StorageProfileAdmissionReceipt,
  awsS3NativeNamespace } from "../../shared/contracts/storage-profile-admission";
import { storageConfigurationClient, StorageConfigurationRequestError } from "../lib/storage-configuration-client";
import { StorageProfileActivation } from "./StorageProfileActivation";

const intentKey = (profileId: string) => `storage-profile-registration:${profileId}`;
function rememberedIntent(storage: CheckpointStorage, profileId: string): StorageProfileAdmissionInput | null {
  try {
    const raw = storage.getItem(intentKey(profileId));
    if (!raw) return null;
    const input = checkedStorageProfileAdmissionInput(JSON.parse(raw));
    return input.profileId === profileId ? input : null;
  } catch { return null; }
}
export const hasRememberedProfileRegistration = (profileId: string) => !!rememberedIntent(checkpointStorage(), profileId);
function supported(candidate: StorageCandidate): boolean {
  try { awsS3NativeNamespace(candidate.namespace); return true; } catch { return false; }
}
export function qualifiesStorageCandidateEvidence(candidate: StorageCandidate, evidence: StorageCandidateReadiness | null): boolean {
  if (!evidence || evidence.profileId !== candidate.profileId || evidence.revision !== candidate.revision
    || evidence.credential.status !== "current" || evidence.credential.envelopeRevision === null
    || !evidence.evidence.exactCurrentContextSuccess || evidence.evidence.inProgressCount || evidence.evidence.unresolvedCleanupCount) return false;
  return supported(candidate);
}
export interface StorageProfileSetupProgress { profileId: string; revision: number; registered: boolean; activated: boolean }

/** Registration uses recorded evidence only. Retaining the request identifier
 * permits receipt reconciliation after reload; it stores no namespace or secrets. */
export function StorageProfileRegistration({ candidate, evidence, blocked, onForbidden, onStaleEvidence, enableActivation = false, onProgress }: {
  candidate: StorageCandidate; evidence: StorageCandidateReadiness | null; blocked: boolean;
  onForbidden: () => void; onStaleEvidence: () => void;
  enableActivation?: boolean;
  onProgress?: (value: StorageProfileSetupProgress) => void;
}) {
  const [owner] = useState(captureApplicationOwner);
  const [storage] = useState(() => checkpointStorage(owner));
  const [pending, setPending] = useState<StorageProfileAdmissionInput | null>(() => rememberedIntent(storage, candidate.profileId));
  const [receipt, setReceipt] = useState<StorageProfileAdmissionReceipt | null>(null);
  const [lookup, setLookup] = useState<{ key: string; state: "loading" | "absent" | "unavailable" | "registered"; receipt?: StorageProfileAdmissionReceipt } | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [activationProgress, setActivationProgress] = useState<{ key: string; nativeProfileId: string; confirmed: boolean } | null>(null);
  const generation = useRef(0), operationBusy = useRef(false), pendingRef = useRef(pending), requests = useRef(new Set<AbortController>());
  const lookupGeneration = useRef(0), lookupController = useRef<AbortController | null>(null);
  const candidateKey = `${candidate.profileId}:${candidate.revision}`, currentCandidate = useRef(candidateKey); currentCandidate.current = candidateKey;
  const currentLookup = lookup?.key === candidateKey ? lookup : null;
  const registered = currentLookup?.state === "registered" ? currentLookup.receipt : null;
  const activationContext = `${candidateKey}:${evidence?.credential.envelopeRevision ?? "none"}:${evidence?.evidence.exactCurrentContextSuccess?.checkId ?? "none"}`;
  const eligible = !blocked && qualifiesStorageCandidateEvidence(candidate, evidence);
  const registrationConfirmed = !blocked && !busy && !pending && !!registered;
  const activationConfirmed = registrationConfirmed && activationProgress?.key === activationContext
    && activationProgress.nativeProfileId === registered?.nativeProfileId && activationProgress.confirmed;
  useEffect(() => {
    if (owner.isCurrent()) onProgress?.({ profileId: candidate.profileId, revision: candidate.revision,
      registered: registrationConfirmed, activated: !!activationConfirmed });
  }, [candidate.profileId, candidate.revision, registrationConfirmed, activationConfirmed, onProgress]);
  // A pending operation keeps its original context. An explicit replay lets
  // the server return its durable receipt or reject an uncommitted stale intent.
  const pendingCanRetry = !blocked;
  async function loadRegistration() {
    if (!owner.isCurrent()) return;
    const current = ++lookupGeneration.current;
    lookupController.current?.abort();
    if (!supported(candidate)) { setLookup(null); return; }
    const controller = new AbortController(); lookupController.current = controller;
    setLookup({ key: candidateKey, state: "loading" });
    try {
      const value = await storageConfigurationClient.findProfileRegistration({ profileId: candidate.profileId, expectedRevision: candidate.revision }, controller.signal);
      if (owner.isCurrent() && current === lookupGeneration.current && !controller.signal.aborted) setLookup({ key: candidateKey, state: "registered", receipt: value });
    } catch (failure) {
      if (!owner.isCurrent() || current !== lookupGeneration.current || controller.signal.aborted || denied(failure)) return;
      setLookup({ key: candidateKey, state: failure instanceof StorageConfigurationRequestError && failure.status === 404 ? "absent" : "unavailable" });
      if (failure instanceof StorageConfigurationRequestError && failure.status === 409) onStaleEvidence();
    }
  }
  function remember(input: StorageProfileAdmissionInput | null) {
    try {
      if (input) storage.setItem(intentKey(candidate.profileId), JSON.stringify(input));
      else storage.removeItem(intentKey(candidate.profileId));
    } catch { if (input) return false; }
    pendingRef.current = input; setPending(input); return true;
  }
  async function request<T>(operation: (signal: AbortSignal) => Promise<T>) {
    owner.assertCurrent();
    const controller = new AbortController(); requests.current.add(controller);
    try { const value = await operation(controller.signal); owner.assertCurrent(); return value; } finally { requests.current.delete(controller); }
  }
  function denied(failure: unknown) {
    if (!(failure instanceof StorageConfigurationRequestError) || failure.status !== 403) return false;
    generation.current += 1;
    for (const controller of requests.current) controller.abort();
    onForbidden(); return true;
  }
  function accept(value: StorageProfileAdmissionReceipt, input: StorageProfileAdmissionInput) {
    if (value.operationId !== input.operationId || value.profileId !== input.profileId || value.revision !== input.expectedRevision
      || value.envelopeRevision !== input.expectedEnvelopeRevision || value.checkId !== input.checkId)
      throw new Error("Invalid profile registration response.");
    // Keep the non-secret request in this session so reopening reads its durable
    // receipt instead of offering another registration for the same revision.
    pendingRef.current = null; setPending(null); setReceipt(value); setMessage("");
    if (currentCandidate.current === `${input.profileId}:${input.expectedRevision}`) {
      lookupGeneration.current += 1; lookupController.current?.abort();
      setLookup({ key: currentCandidate.current, state: "registered", receipt: value });
    }
  }
  async function reconcile(input: StorageProfileAdmissionInput, current: number, retryMissing: boolean) {
    try {
      const value = await request(signal => storageConfigurationClient.readProfileRegistration(input.operationId, signal));
      if (owner.isCurrent() && current === generation.current) accept(value, input);
    } catch (failure) {
      if (!owner.isCurrent() || current !== generation.current || denied(failure)) return;
      if (retryMissing && failure instanceof StorageConfigurationRequestError && failure.status === 404) {
        await submit(input, current); return;
      }
      setMessage("The registration result is unavailable. Check its status before starting another registration.");
    }
  }
  async function submit(input: StorageProfileAdmissionInput, current: number, fresh = false) {
    try {
      const value = await request(signal => storageConfigurationClient.registerProfile(input, signal));
      if (owner.isCurrent() && current === generation.current) accept(value, input);
    } catch (failure) {
      if (!owner.isCurrent() || current !== generation.current || denied(failure)) return;
      // An older invocation may still commit after this replay's receipt check.
      if (fresh && failure instanceof StorageConfigurationRequestError && [400, 404, 409].includes(failure.status)) {
        remember(null); onStaleEvidence();
        setMessage(failure.status === 409 ? "Registration could not be completed. This storage may already be registered, or its configuration or evidence changed. Refresh evidence before trying again."
          : "Registration could not be completed. Refresh saved candidates and check evidence before trying again.");
        if (failure.status === 409 && currentCandidate.current === candidateKey) await loadRegistration();
      } else await reconcile(input, current, false);
    }
  }
  useEffect(() => {
    const current = ++generation.current;
    if (pendingRef.current) {
      operationBusy.current = true; setBusy(true);
      void reconcile(pendingRef.current, current, false).finally(() => {
        if (owner.isCurrent() && current === generation.current) { operationBusy.current = false; setBusy(false); }
      });
    }
    return () => { generation.current += 1; for (const controller of requests.current) controller.abort(); };
  }, [candidate.profileId]);
  useEffect(() => {
    void loadRegistration();
    return () => { lookupGeneration.current += 1; lookupController.current?.abort(); };
  }, [candidate.profileId, candidate.revision]);
  async function register() {
    if (!eligible || !evidence?.evidence.exactCurrentContextSuccess || evidence.credential.envelopeRevision === null
      || operationBusy.current || pendingRef.current || currentLookup?.state !== "absent") return;
    const input: StorageProfileAdmissionInput = { operationId: crypto.randomUUID(), profileId: candidate.profileId,
      expectedRevision: candidate.revision, expectedEnvelopeRevision: evidence.credential.envelopeRevision,
      checkId: evidence.evidence.exactCurrentContextSuccess.checkId };
    if (!remember(input)) { setMessage("Browser session storage is unavailable. Enable it before registering a profile."); return; }
    const current = generation.current; operationBusy.current = true; setBusy(true); setMessage("");
    try { await submit(input, current, true); }
    finally { if (owner.isCurrent() && current === generation.current) { operationBusy.current = false; setBusy(false); } }
  }
  async function checkOrRetry() {
    if (operationBusy.current || !pendingRef.current) return;
    const input = pendingRef.current, current = generation.current;
    operationBusy.current = true; setBusy(true); setMessage("");
    try { await reconcile(input, current, pendingCanRetry); }
    finally { if (owner.isCurrent() && current === generation.current) { operationBusy.current = false; setBusy(false); } }
  }
  return <>
    {eligible && !pending && currentLookup?.state === "absent" && <>
      <p className="muted">Register this tested AWS S3 configuration as a read-only profile. Registration does not enable file access or change upload destinations.</p>
      <button className="button" type="button" disabled={busy} onClick={() => void register()}>Register profile</button>
    </>}
    {currentLookup?.state === "loading" && <p role="status">Reading profile registration…</p>}
    {currentLookup?.state === "unavailable" && <><p role="status">Profile registration status is unavailable.</p>
      <button className="button" type="button" disabled={busy} onClick={() => void loadRegistration()}>Refresh registration status</button></>}
    {pending && <><p className="muted">Registration for revision {pending.expectedRevision} is awaiting confirmation.</p>
      <button className="button" type="button" disabled={busy} onClick={() => void checkOrRetry()}>
        {busy ? "Checking registration…" : pendingCanRetry ? "Check or retry registration" : "Check registration status"}
      </button></>}
    {registered && <p role="status">Profile <code>{registered.nativeProfileId}</code> {enableActivation ? "is registered. Review its activation below." : "is registered as read only. File access is not enabled and upload destinations are unchanged."} <a href="/settings/storage">View registered profiles</a></p>}
    {registered && enableActivation && <StorageProfileActivation candidate={candidate} nativeProfileId={registered.nativeProfileId} evidence={evidence}
      blocked={blocked} onForbidden={onForbidden} onStaleEvidence={onStaleEvidence}
      onActivationChange={onProgress ? value => {
        if (value.profileId !== candidate.profileId || value.revision !== candidate.revision || value.nativeProfileId !== registered.nativeProfileId) return;
        setActivationProgress(current => current?.key === activationContext && current.nativeProfileId === value.nativeProfileId && current.confirmed === value.confirmed
          ? current : { key: activationContext, nativeProfileId: value.nativeProfileId, confirmed: value.confirmed });
      } : undefined} />}
    {receipt && !registered && <p role="status">Registration confirmed for revision {receipt.revision}. <a href="/settings/storage">View registered profiles</a></p>}
    {message && <p role="status">{message}</p>}
  </>;
}

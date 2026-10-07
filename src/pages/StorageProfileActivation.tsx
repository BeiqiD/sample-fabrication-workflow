import { useEffect, useRef, useState } from "react";
import type { StorageCandidate } from "../../shared/contracts/storage-configuration";
import type { StorageCandidateReadiness } from "../../shared/contracts/storage-candidate-readiness";
import type { CurrentStorageSettingsStatus } from "../../shared/contracts/current-storage-settings";
import { checkedNativeStorageActivationInput, type NativeStorageActivationInput, type NativeStorageActivationReceipt } from "../../shared/contracts/storage-policy";
import { api, StoragePolicyRequestError } from "../lib/api";

const intentKey = (id: string) => `storage-profile-activation:${id}`;
function remembered(id: string): NativeStorageActivationInput | null {
  try {
    const raw = sessionStorage.getItem(intentKey(id)), value = raw ? checkedNativeStorageActivationInput(JSON.parse(raw)) : null;
    return value?.candidateProfileId === id ? value : null;
  } catch { return null; }
}
export function StorageProfileActivation({ candidate, nativeProfileId, evidence, blocked, onForbidden, onStaleEvidence }: {
  candidate: StorageCandidate; nativeProfileId: string; evidence: StorageCandidateReadiness | null; blocked: boolean;
  onForbidden: () => void; onStaleEvidence: () => void;
}) {
  const [status, setStatus] = useState<CurrentStorageSettingsStatus | null>(null), [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(() => remembered(candidate.profileId)), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const generation = useRef(0), operationBusy = useRef(false), pendingRef = useRef(pending), requests = useRef(new Set<AbortController>());
  const loadGeneration = useRef(0);
  const profile = status?.profiles.items.find(item => item.id === nativeProfileId);
  const enabled = !blocked && !forbidden && status?.authority.mode === "active" && status.authority.fileAccess === "enabled";
  const eligible = enabled && profile?.adapterType === "s3" && ["read_only", "read_write"].includes(profile.runtimeAccess)
    && evidence?.profileId === candidate.profileId && evidence.revision === candidate.revision && evidence.credential.status === "current"
    && evidence.credential.envelopeRevision !== null && evidence.evidence.exactCurrentContextSuccess
    && !evidence.evidence.inProgressCount && !evidence.evidence.unresolvedCleanupCount;
  async function request<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController(); requests.current.add(controller);
    try { return await operation(controller.signal); } finally { requests.current.delete(controller); }
  }
  function remember(input: NativeStorageActivationInput | null, profileId = input?.candidateProfileId ?? candidate.profileId) {
    try { if (input) sessionStorage.setItem(intentKey(profileId), JSON.stringify(input)); else sessionStorage.removeItem(intentKey(profileId)); }
    catch { if (input) return false; }
    pendingRef.current = input; setPending(input); return true;
  }
  function denied(failure: unknown) {
    if (!(failure instanceof StoragePolicyRequestError) || failure.status !== 403) return false;
    generation.current += 1; for (const request of requests.current) request.abort();
    operationBusy.current = false; setBusy(false); setLoading(false); setStatus(null); setForbidden(true);
    setMessage("System administrator access is required. Refresh saved candidates to check your access."); onForbidden(); return true;
  }
  async function load(current = generation.current) {
    const reading = ++loadGeneration.current;
    setLoading(true); setStatus(null);
    try { const value = await request(signal => api.getCurrentStorageSettings(signal)); if (current === generation.current && reading === loadGeneration.current && value.version === 3) setStatus(value); }
    catch (failure) { if (current === generation.current && reading === loadGeneration.current && !denied(failure)) setMessage("Activation settings are unavailable. Refresh activation status to try again."); }
    finally { if (current === generation.current && reading === loadGeneration.current) setLoading(false); }
  }
  function accept(value: NativeStorageActivationReceipt, input: NativeStorageActivationInput) {
    if (value.operationId !== input.operationId || value.nativeProfileId !== input.nativeProfileId || value.candidateProfileId !== input.candidateProfileId
      || value.candidateRevision !== input.expectedCandidateRevision || value.envelopeRevision !== input.expectedEnvelopeRevision || value.checkId !== input.checkId
      || input.expectedBindingRevision !== null && value.bindingRevision !== input.expectedBindingRevision + 1) throw new Error("Invalid storage activation receipt.");
    remember(null, input.candidateProfileId); setMessage("Profile activation confirmed. Select this profile in current storage settings to use it for new uploads.");
  }
  async function submit(input: NativeStorageActivationInput, current: number) {
    try { const value = await request(signal => api.activateStorageProfile(input, signal)); if (current === generation.current) { accept(value, input); await load(current); } }
    catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      if (failure instanceof StoragePolicyRequestError && [400, 404, 409].includes(failure.status)) {
        remember(null, input.candidateProfileId); onStaleEvidence(); setMessage("Activation could not be completed. Refresh evidence and activation status before trying again.");
      } else await reconcile(input, current, false);
    }
  }
  async function reconcile(input: NativeStorageActivationInput, current: number, retry: boolean) {
    try { const value = await request(signal => api.readStorageActivation(input.operationId, signal)); if (current === generation.current) { accept(value, input); await load(current); } }
    catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      if (retry && enabled && failure instanceof StoragePolicyRequestError && failure.status === 404) { await submit(input, current); return; }
      setMessage("The activation result is unconfirmed. Check or retry the original activation before starting another.");
    }
  }
  useEffect(() => {
    const current = ++generation.current, saved = remembered(candidate.profileId);
    pendingRef.current = saved; setPending(saved); setMessage(""); operationBusy.current = false; setBusy(false);
    void load(current);
    if (saved) {
      operationBusy.current = true; setBusy(true);
      void reconcile(saved, current, false).finally(() => { if (current === generation.current) { operationBusy.current = false; setBusy(false); } });
    }
    return () => { generation.current += 1; for (const request of requests.current) request.abort(); operationBusy.current = false; };
  }, [candidate.profileId, nativeProfileId]);
  async function activate() {
    if (!eligible || !profile || !evidence?.evidence.exactCurrentContextSuccess || evidence.credential.envelopeRevision === null
      || pendingRef.current || operationBusy.current) return;
    const input: NativeStorageActivationInput = { operationId: crypto.randomUUID(), nativeProfileId, candidateProfileId: candidate.profileId,
      expectedCandidateRevision: candidate.revision, expectedEnvelopeRevision: evidence.credential.envelopeRevision,
      checkId: evidence.evidence.exactCurrentContextSuccess.checkId, expectedBindingRevision: profile.bindingRevision };
    if (!remember(input)) { setMessage("Browser session storage is unavailable. Enable it before activating a profile."); return; }
    const current = generation.current; operationBusy.current = true; setBusy(true); setMessage("");
    try { await submit(input, current); } finally { if (current === generation.current) { operationBusy.current = false; setBusy(false); } }
  }
  async function retry() {
    if (!pendingRef.current || operationBusy.current) return;
    const input = pendingRef.current, current = generation.current; operationBusy.current = true; setBusy(true);
    try { await reconcile(input, current, true); } finally { if (current === generation.current) { operationBusy.current = false; setBusy(false); } }
  }
  return <div className="storage-profile-activation">
    <h4>Profile activation</h4>
    <p className="muted">Activation binds this registered profile to the tested configuration and current credentials. Upload destinations change only when you save your choices in storage settings.</p>
    {loading && <p role="status">Reading activation status…</p>}
    {profile?.bindingRevision !== null && profile?.bindingRevision !== undefined && <p className="muted">Current activation revision: {profile.bindingRevision}.</p>}
    {!loading && !enabled && <p className="muted">Activation is unavailable while file access or configuration work is paused.</p>}
    {!loading && enabled && !eligible && <p className="muted">Refresh matching successful test evidence before activating this profile.</p>}
    {!pending && <button className="button" type="button" disabled={!eligible || loading || busy} onClick={() => void activate()}>
      {busy ? "Activating…" : profile?.bindingRevision ? "Update profile activation" : "Activate profile"}</button>}
    {pending && <p className="muted">Activation for <code>{pending.nativeProfileId}</code> from candidate revision {pending.expectedCandidateRevision} is awaiting confirmation.</p>}
    {pending && <button className="button" type="button" disabled={busy || blocked || forbidden} onClick={() => void retry()}>{busy ? "Checking activation…" : "Check or retry activation"}</button>}
    <button className="button" type="button" disabled={busy || loading} onClick={() => void load()}>Refresh activation status</button>
    {message && <p role="status">{message}</p>}
    <p><a href="/settings/storage">Choose upload destinations</a></p>
  </div>;
}

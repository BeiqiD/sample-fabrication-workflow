import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CurrentStorageSettingsStatus } from "../../shared/contracts/current-storage-settings";
import { checkedStorageRolePolicyInput, type StorageRolePolicyInput, type StorageRolePolicyReceipt } from "../../shared/contracts/storage-policy";
import { api, StoragePolicyRequestError } from "../lib/api";
import { ReadStatus } from "../components/ReadStatus";

const key = "storage-role-policy:pending";
function remembered(): StorageRolePolicyInput | null {
  try { const value = sessionStorage.getItem(key); return value ? checkedStorageRolePolicyInput(JSON.parse(value)) : null; } catch { return null; }
}
export function StorageRoleDefaultsForm({ status, canManage, accessStatus = "resolved", onChanged, onRetryAccess, onForbidden }: {
  status: CurrentStorageSettingsStatus; canManage: boolean; onChanged: () => void; onRetryAccess: () => void; onForbidden: () => void;
  accessStatus?: "checking" | "unavailable" | "resolved";
}) {
  const eligible = status.profiles.items.filter(profile => profile.availability === "available" && ["r2", "s3"].includes(profile.adapterType));
  const [internal, setInternal] = useState(status.roleDefaults.internal?.profileId ?? eligible[0]?.id ?? "");
  const [originals, setOriginals] = useState(status.roleDefaults.originals?.profileId ?? eligible[0]?.id ?? "");
  const [pending, setPending] = useState(remembered), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [stale, setStale] = useState(false);
  const pendingRef = useRef(pending), operationBusy = useRef(false), generation = useRef(0), controller = useRef<AbortController | null>(null);
  const enabled = canManage && !stale && status.authority.mode === "active" && status.authority.fileAccess === "enabled";
  function remember(input: StorageRolePolicyInput | null) {
    try { if (input) sessionStorage.setItem(key, JSON.stringify(input)); else sessionStorage.removeItem(key); }
    catch { if (input) return false; }
    pendingRef.current = input; setPending(input); return true;
  }
  function accept(receipt: StorageRolePolicyReceipt, input: StorageRolePolicyInput) {
    if (receipt.operationId !== input.operationId || receipt.internalProfileId !== input.internalProfileId || receipt.originalsProfileId !== input.originalsProfileId
      || receipt.policyRevision !== Math.max(3, (input.expectedPolicyRevision ?? 2) + 1)) throw new Error("Invalid storage policy receipt.");
    remember(null); setMessage("Upload destinations saved. Existing files keep their recorded storage location."); onChanged();
  }
  function denied(failure: unknown) {
    if (!(failure instanceof StoragePolicyRequestError) || failure.status !== 403) return false;
    onForbidden(); setMessage("System administrator access is required. Refresh to check your access."); return true;
  }
  async function submit(input: StorageRolePolicyInput, current: number, signal: AbortSignal) {
    try { const value = await api.setStorageRoleDefaults(input, signal); if (current === generation.current && !signal.aborted) accept(value, input); }
    catch (failure) {
      if (current !== generation.current || signal.aborted || denied(failure)) return;
      if (failure instanceof StoragePolicyRequestError && [400, 404, 409].includes(failure.status)) {
        remember(null); setStale(true); setMessage("The selected profiles or policy changed. Refresh storage settings before saving again.");
      } else await reconcile(input, current, signal, false);
    }
  }
  async function reconcile(input: StorageRolePolicyInput, current: number, signal: AbortSignal, retry: boolean) {
    try { const value = await api.readStorageRolePolicy(input.operationId, signal); if (current === generation.current && !signal.aborted) accept(value, input); }
    catch (failure) {
      if (current !== generation.current || signal.aborted || denied(failure)) return;
      if (retry && enabled && failure instanceof StoragePolicyRequestError && failure.status === 404) { await submit(input, current, signal); return; }
      setMessage("The save result is unconfirmed. Check or retry the original save before making another selection.");
    }
  }
  async function run(input: StorageRolePolicyInput, initial: boolean) {
    if (operationBusy.current) return;
    operationBusy.current = true; setBusy(true); setMessage("");
    const current = generation.current, request = new AbortController(); controller.current = request;
    try { if (initial) await submit(input, current, request.signal); else await reconcile(input, current, request.signal, true); }
    finally { if (current === generation.current) { operationBusy.current = false; setBusy(false); } }
  }
  useEffect(() => {
    const current = ++generation.current;
    if (canManage && pendingRef.current) {
      const input = pendingRef.current, request = new AbortController(); controller.current = request;
      operationBusy.current = true; setBusy(true);
      void reconcile(input, current, request.signal, false).finally(() => { if (current === generation.current) { operationBusy.current = false; setBusy(false); } });
    }
    return () => { generation.current += 1; controller.current?.abort(); operationBusy.current = false; };
  }, [canManage]);
  function save(event: FormEvent) {
    event.preventDefault();
    if (!enabled || pendingRef.current || operationBusy.current || !eligible.some(p => p.id === internal) || !eligible.some(p => p.id === originals)) return;
    const input: StorageRolePolicyInput = { operationId: crypto.randomUUID(), expectedPolicyRevision: status.roleDefaults.policyRevision,
      internalProfileId: internal, originalsProfileId: originals };
    if (!remember(input)) { setMessage("Browser session storage is unavailable. Enable it before saving upload destinations."); return; }
    void run(input, true);
  }
  return <section className="card storage-settings-section" aria-labelledby="storage-default-policy-title">
    <h2 className="card-title" id="storage-default-policy-title">Upload destinations</h2>
    <p className="muted">Choose where new files are stored. Existing files keep their recorded storage location.</p>
    <ReadStatus loading={accessStatus === "checking"} loadingMessage="Checking administrator access…"
      error={accessStatus === "unavailable" ? "Administrator access could not be checked. Upload destinations are read only until access can be confirmed." : null}
      errorTitle="Access check unavailable" onRetry={onRetryAccess} retryLabel="Retry access check" />
    {!canManage ? accessStatus === "resolved" && <p className="muted">Only system administrators can change upload destinations.</p> : <>
      {!enabled && !stale && <p className="muted">Upload destination changes are unavailable while file access is paused or historical file authority is active.</p>}
      {eligible.length === 0 && <p className="muted">No profile is currently available for new uploads. Register and activate a tested S3 profile, or restore the current R2 configuration.</p>}
      <form className="storage-candidate-form" onSubmit={save}><fieldset disabled={!enabled || busy || !!pending}>
        <div className="storage-candidate-fields">
          <label>Images and Project attachments<select value={internal} onChange={event => setInternal(event.target.value)} required>
            <option value="">Choose a profile</option>{!eligible.some(p => p.id === internal) && internal && <option value={internal} disabled>{internal} (unavailable)</option>}
            {eligible.map(profile => <option key={profile.id} value={profile.id}>{profile.adapterType === "s3" ? "S3" : "Cloudflare R2"} · {profile.id}</option>)}</select></label>
          <label>Original comment files<select value={originals} onChange={event => setOriginals(event.target.value)} required>
            <option value="">Choose a profile</option>{!eligible.some(p => p.id === originals) && originals && <option value={originals} disabled>{originals} (unavailable)</option>}
            {eligible.map(profile => <option key={profile.id} value={profile.id}>{profile.adapterType === "s3" ? "S3" : "Cloudflare R2"} · {profile.id}</option>)}</select></label>
        </div><button className="button primary" type="submit" disabled={!eligible.some(profile => profile.id === internal) || !eligible.some(profile => profile.id === originals)}>{busy ? "Saving…" : "Save upload destinations"}</button>
      </fieldset></form>
    </>}
    {pending && canManage && <button className="button" type="button" disabled={busy} onClick={() => void run(pending, false)}>
      {busy ? "Checking save…" : "Check or retry save"}</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}

import { useEffect, useId, useRef, useState } from "react";
import type { StorageCandidate } from "../../shared/contracts/storage-configuration";
import { checkedReenvelopeStorageCredentialInput, type ReenvelopeStorageCredentialInput, type StorageCredentialEnvelopeList,
  type StorageCredentialEnvelopeMetadata, type StorageCredentialReenvelopeReceipt } from "../../shared/contracts/storage-credential-reenvelope";
import { storageConfigurationClient, StorageConfigurationRequestError } from "../lib/storage-configuration-client";

const intentKey = (profileId: string) => `storage-credential-reenvelope:${profileId}`;
function rememberedIntent(profileId: string): ReenvelopeStorageCredentialInput | null {
  try {
    const raw = sessionStorage.getItem(intentKey(profileId));
    if (!raw) return null;
    const input = checkedReenvelopeStorageCredentialInput(JSON.parse(raw));
    return input.profileId === profileId ? input : null;
  } catch { return null; }
}
const statusNames: Record<StorageCredentialEnvelopeMetadata["status"], string> = {
  current: "Uses the current encryption key", needs_reenvelope: "Encryption update available", unavailable: "Encryption unavailable",
};

/** Encryption administration reads only opaque references and revision metadata.
 * A lost response retains the same operation ID; retries never create a new intent. */
export function StorageCredentialEncryption({ candidate, canUpdate, onForbidden }: {
  candidate: StorageCandidate; canUpdate: boolean; onForbidden: () => void;
}) {
  const [pending, setPending] = useState<ReenvelopeStorageCredentialInput | null>(() => rememberedIntent(candidate.profileId));
  const [expanded, setExpanded] = useState(() => !!rememberedIntent(candidate.profileId));
  const [metadata, setMetadata] = useState<StorageCredentialEnvelopeList>({ items: [], hasMore: false });
  const [metadataReady, setMetadataReady] = useState(false);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [notice, setNotice] = useState("");
  const pendingRef = useRef(pending), generation = useRef(0), requests = useRef(new Set<AbortController>()), operationBusy = useRef(false);
  const panelId = useId();
  function remember(input: ReenvelopeStorageCredentialInput | null) {
    try {
      if (input) sessionStorage.setItem(intentKey(candidate.profileId), JSON.stringify(input));
      else sessionStorage.removeItem(intentKey(candidate.profileId));
    } catch { if (input) return false; }
    pendingRef.current = input; setPending(input); return true;
  }
  async function request<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController(); requests.current.add(controller);
    try { return await operation(controller.signal); } finally { requests.current.delete(controller); }
  }
  function denied(failure: unknown) {
    if (!(failure instanceof StorageConfigurationRequestError) || failure.status !== 403) return false;
    generation.current += 1;
    for (const controller of requests.current) controller.abort();
    onForbidden(); return true;
  }
  function accept(receipt: StorageCredentialReenvelopeReceipt, input: ReenvelopeStorageCredentialInput) {
    if (receipt.operationId !== input.operationId || receipt.profileId !== input.profileId || receipt.revision !== input.revision
      || receipt.credentialRef !== input.credentialRef || receipt.previousEnvelopeRevision !== input.expectedEnvelopeRevision)
      throw new Error("Invalid credential encryption response.");
    if (pendingRef.current?.operationId === input.operationId) remember(null);
    setMessage("");
    setNotice(receipt.outcome === "reenveloped" ? `Credential encryption updated for revision ${receipt.revision}.`
      : `Revision ${receipt.revision} already uses the current encryption key.`);
  }
  async function readMetadata(current: number) {
    if (current === generation.current) setMetadataReady(false);
    const list = await request(signal => storageConfigurationClient.listCredentialEnvelopes(candidate.profileId, signal));
    if (current === generation.current) { setMetadata(list); setMetadataReady(true); }
  }
  async function reconcile(input: ReenvelopeStorageCredentialInput, current: number, retryMissing: boolean): Promise<void> {
    try {
      const receipt = await request(signal => storageConfigurationClient.readCredentialReenvelope(input.operationId, signal));
      if (current !== generation.current) return;
      accept(receipt, input);
      await readMetadata(current);
    } catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      if (retryMissing && canUpdate && failure instanceof StorageConfigurationRequestError && failure.status === 404) {
        await submit(input, current); return;
      }
      setMessage(pendingRef.current ? "The encryption update result is unavailable. Check or retry this same operation."
        : "Encryption updated. Refresh encryption status to read the latest result.");
    }
  }
  async function submit(input: ReenvelopeStorageCredentialInput, current: number) {
    try {
      const receipt = await request(signal => storageConfigurationClient.reenvelopeCredential(input, signal));
      if (current !== generation.current) return;
      accept(receipt, input);
      await readMetadata(current);
    } catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      if (failure instanceof StorageConfigurationRequestError && failure.status === 409) {
        remember(null); setMessage("Stored credential encryption changed. Read the latest status before trying again.");
        try { await readMetadata(current); } catch (readFailure) {
          if (current !== generation.current || denied(readFailure)) return;
          setMessage("Stored credential encryption changed. Refresh encryption status before trying again.");
        }
      } else if (failure instanceof StorageConfigurationRequestError && failure.status === 400) {
        // Invalid input is rejected before persistence. Unknown outcomes, including
        // server unavailability after commit, retain the same operation identifier.
        remember(null); setMessage("Credential encryption cannot be updated. Refresh encryption status before trying again.");
        try { await readMetadata(current); } catch (readFailure) {
          if (current !== generation.current || denied(readFailure)) return;
        }
      } else if (pendingRef.current) await reconcile(input, current, false);
      else setMessage("Encryption updated. Refresh encryption status to read the latest result.");
    }
  }
  async function load() {
    const current = generation.current;
    setLoading(true); setMessage("");
    try {
      await readMetadata(current);
      if (current !== generation.current) return;
      if (pendingRef.current) await reconcile(pendingRef.current, current, false);
    } catch (failure) {
      if (current !== generation.current || denied(failure)) return;
      setMessage("Credential encryption status is unavailable. Refresh encryption status to try again.");
    } finally { if (current === generation.current) setLoading(false); }
  }
  useEffect(() => {
    generation.current += 1; operationBusy.current = false; setBusy(false); setMetadata({ items: [], hasMore: false }); setMetadataReady(false); setLoading(false);
    if (expanded) void load();
    return () => { generation.current += 1; for (const controller of requests.current) controller.abort(); };
  }, [candidate.profileId, candidate.revision, expanded]);
  async function update(item: StorageCredentialEnvelopeMetadata) {
    if (!canUpdate || !metadataReady || loading || operationBusy.current || pendingRef.current || item.status !== "needs_reenvelope" || item.envelopeRevision === null) return;
    const input: ReenvelopeStorageCredentialInput = { operationId: crypto.randomUUID(), profileId: item.profileId, revision: item.revision,
      credentialRef: item.credentialRef, expectedEnvelopeRevision: item.envelopeRevision };
    if (!remember(input)) { setMessage("Browser session storage is unavailable. Enable it before updating credential encryption."); return; }
    const current = generation.current; operationBusy.current = true; setBusy(true); setMessage(""); setNotice("");
    try { await submit(input, current); } finally { if (current === generation.current) { operationBusy.current = false; setBusy(false); } }
  }
  async function checkOrRetry() {
    if (loading || operationBusy.current || !pendingRef.current) return;
    const current = generation.current; operationBusy.current = true; setBusy(true); setMessage("");
    try { await reconcile(pendingRef.current, current, true); } finally { if (current === generation.current) { operationBusy.current = false; setBusy(false); } }
  }
  return <div className="storage-credential-encryption">
    <button className="button" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(current => !current)}>
      Credential encryption for {candidate.label}
    </button>
    {expanded && <section id={panelId} aria-label={`Credential encryption for ${candidate.label}`}>
      <p className="muted">Update stored credentials to use the installation’s current encryption key. Provider credentials, connection test results and upload destinations stay unchanged.</p>
      <p className="muted">Earlier encryption keys may still be needed by immutable connection test snapshots and installation backups. Updating these rows does not prove that an earlier key can be removed.</p>
      <button className="button" type="button" disabled={loading || busy} onClick={() => void load()}>Refresh encryption status</button>
      {loading && <p role="status">Reading credential encryption status…</p>}
      {message && <p role="status">{message}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && <><p className="muted">An encryption update for revision {pending.revision} is unresolved. Its operation identifier is retained for safe reconciliation.</p>
        <button className="button" type="button" disabled={loading || busy} onClick={() => void checkOrRetry()}>{busy ? "Updating encryption…" : "Check or retry encryption update"}</button></>}
      {!loading && metadataReady && metadata.items.length === 0 && <p className="muted">No retained credential revisions are available.</p>}
      <ul className="storage-encryption-history">{metadata.items.map(item => <li key={item.credentialRef}>
        <div className="storage-check-heading"><strong>{item.isCurrentCandidate ? "Current candidate credential" : item.revision < candidate.revision ? "Historical credential" : "Retained credential"} revision {item.revision}</strong>
          <span>{statusNames[item.status]}</span></div>
        {!item.isCurrentCandidate && <p className="muted">Retained credentials for this configuration identity.</p>}
        {item.status === "needs_reenvelope" && <button className="button" type="button" disabled={!canUpdate || !metadataReady || loading || busy || !!pending}
          onClick={() => void update(item)}>Update encryption for revision {item.revision}</button>}
      </li>)}</ul>
      {metadata.hasMore && <p className="muted">Additional retained credential revisions are not shown.</p>}
    </section>}
  </div>;
}

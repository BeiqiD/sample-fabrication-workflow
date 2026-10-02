import { useEffect, useId, useRef, useState } from "react";
import type { StorageCandidate } from "../../shared/contracts/storage-configuration";
import type { StorageCandidateReadiness as Readiness } from "../../shared/contracts/storage-candidate-readiness";
import { storageConfigurationClient, StorageConfigurationRequestError } from "../lib/storage-configuration-client";

const credentialNames: Record<Readiness["credential"]["status"], string> = {
  current: "Credentials readable; current encryption",
  needs_reenvelope: "Credentials readable; encryption update available",
  unavailable: "Credentials unavailable",
};

/** Evidence is a dated observation, never activation permission or a new provider test.
 * Every operation invalidation drops the observation; only opening or refreshing reads again. */
export function StorageCandidateReadiness({ candidate, evidenceGeneration, blocked, onForbidden }: {
  candidate: StorageCandidate; evidenceGeneration: number; blocked: boolean; onForbidden: () => void;
}) {
  const [expanded, setExpanded] = useState(false), [loading, setLoading] = useState(false), [message, setMessage] = useState("");
  const [observation, setObservation] = useState<{ key: string; value: Readiness } | null>(null);
  const sequence = useRef(0), request = useRef<AbortController | null>(null);
  const previous = useRef({ expanded: false, profileId: candidate.profileId, revision: candidate.revision });
  const forbidden = useRef(onForbidden); forbidden.current = onForbidden;
  const panelId = useId(), key = `${candidate.profileId}:${candidate.revision}:${evidenceGeneration}`;
  const result = !blocked && observation?.key === key ? observation.value : null;
  async function refresh() {
    if (blocked) return;
    const current = ++sequence.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setObservation(null); setMessage(""); setLoading(true);
    try {
      const value = await storageConfigurationClient.readReadiness({ profileId: candidate.profileId, expectedRevision: candidate.revision }, controller.signal);
      if (current === sequence.current && !controller.signal.aborted) setObservation({ key, value });
    } catch (failure) {
      if (current !== sequence.current || controller.signal.aborted) return;
      if (failure instanceof StorageConfigurationRequestError && failure.status === 403) {
        sequence.current += 1; controller.abort(); setObservation(null); forbidden.current(); return;
      }
      setMessage(failure instanceof StorageConfigurationRequestError && failure.status === 409
        ? "This candidate changed. Refresh saved candidates before reading its evidence."
        : "Check evidence is unavailable. Refresh evidence to try again.");
    } finally { if (current === sequence.current) setLoading(false); }
  }
  useEffect(() => {
    sequence.current += 1; request.current?.abort(); setObservation(null); setMessage(""); setLoading(false);
    const opened = expanded && (!previous.current.expanded || previous.current.profileId !== candidate.profileId || previous.current.revision !== candidate.revision);
    previous.current = { expanded, profileId: candidate.profileId, revision: candidate.revision };
    if (opened && !blocked) void refresh();
    return () => { sequence.current += 1; request.current?.abort(); };
  }, [candidate.profileId, candidate.revision, expanded, evidenceGeneration, blocked]);
  return <div className="storage-candidate-readiness">
    <button className="button" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(value => !value)}>
      Check evidence for {candidate.label}
    </button>
    {expanded && <section id={panelId} aria-label={`Check evidence for ${candidate.label}`}>
      <p className="muted">Review recorded tests against the current configuration and stored credential version. This does not run a connection test.</p>
      <button className="button" type="button" disabled={blocked || loading} onClick={() => void refresh()}>Refresh evidence</button>
      {blocked ? <p role="status">Evidence cleared while configuration or test work is unresolved. Refresh evidence when it settles.</p>
        : loading ? <p role="status">Reading check evidence…</p>
        : message ? <p role="status">{message}</p>
        : !result && <p role="status">Refresh evidence to read the latest recorded status.</p>}
      {result && <>
        <p className="storage-evidence-result"><strong>{result.evidence.exactCurrentContextSuccess
          ? "Recorded success matches the current configuration and stored credential version."
          : "No recorded success matches the current configuration and stored credential version."}</strong></p>
        {result.evidence.exactCurrentContextSuccess && <p className="muted">Matching test completed <time dateTime={result.evidence.exactCurrentContextSuccess.completedAt}>
          {new Date(result.evidence.exactCurrentContextSuccess.completedAt).toLocaleString()}</time>.</p>}
        <dl className="storage-readiness-details">
          <div><dt>Credential access now</dt><dd>{credentialNames[result.credential.status]}</dd></div>
          <div><dt>Successful tests of this configuration</dt><dd>{result.evidence.currentConfigurationSuccessCount}</dd></div>
          <div><dt>Successful tests of other configurations</dt><dd>{result.evidence.historicalConfigurationSuccessCount}</dd></div>
          <div><dt>Recorded as in progress</dt><dd>{result.evidence.inProgressCount}</dd></div>
          <div><dt>Tests with unresolved cleanup</dt><dd>{result.evidence.unresolvedCleanupCount}</dd></div>
        </dl>
        <p className="muted">Counts include all recorded history. Refresh test status to reconcile interrupted tests. Success for this configuration may use an earlier stored credential version.</p>
        <p className="muted">Observed <time dateTime={result.observedAt}>{new Date(result.observedAt).toLocaleString()}</time>. Recorded success does not guarantee that the provider is reachable now.</p>
      </>}
      <p className="muted">Candidate activation is unavailable. Current upload destinations are unchanged.</p>
    </section>}
  </div>;
}

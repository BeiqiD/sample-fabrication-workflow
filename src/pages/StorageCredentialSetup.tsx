import { useEffect, useRef, useState } from "react";
import { generateInstallationSecretSeed, INSTALLATION_SECRET_SEED_NAME } from "../../shared/contracts/installation-secret-seed";
import type { StorageCredentialSetupStatus } from "../../shared/contracts/storage-credential-setup";
import { captureApplicationOwner, subscribeAuthentication } from "../lib/authentication-client";
import { storageConfigurationClient, StorageConfigurationRequestError } from "../lib/storage-configuration-client";

/** Setup observes a deployment-owned secret. The browser never sends, saves or
 * installs a generated seed, and provider credentials are collected afterwards. */
export function StorageCredentialSetup({ onReady, onForbidden, onCancel }: {
  onReady: (signal: AbortSignal) => Promise<void>; onForbidden: () => void; onCancel: () => void;
}) {
  const [owner] = useState(captureApplicationOwner);
  const [readiness, setReadiness] = useState<StorageCredentialSetupStatus | null>(null);
  const [seed, setSeed] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false), [copying, setCopying] = useState(false), [message, setMessage] = useState("");
  const sequence = useRef(0), request = useRef<AbortController | null>(null), busy = useRef(false);
  const callbacks = useRef({ onReady, onForbidden, onCancel }); callbacks.current = { onReady, onForbidden, onCancel };
  function clearSeed() { setSeed(null); setCopied(false); setCopying(false); }
  async function recheck() {
    if (!owner.isCurrent() || busy.current) return;
    const current = ++sequence.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    busy.current = true; setLoading(true); setMessage(""); setReadiness(null); clearSeed();
    try {
      const value = await storageConfigurationClient.readEncryptionReadiness(controller.signal);
      if (!owner.isCurrent() || current !== sequence.current || controller.signal.aborted) return;
      setReadiness(value);
      if (value.state === "legacy_ready" || value.state === "seed_ready") await callbacks.current.onReady(controller.signal);
    } catch (failure) {
      if (!owner.isCurrent() || current !== sequence.current || controller.signal.aborted) return;
      if (failure instanceof StorageConfigurationRequestError && failure.status === 403) {
        sequence.current += 1; controller.abort(); clearSeed(); callbacks.current.onForbidden(); return;
      }
      setMessage(failure instanceof StorageConfigurationRequestError && failure.status === 404
        ? "Guided credential setup is unavailable for this installation. Ask its operator to check the protected server credential configuration."
        : "Credential setup status is unavailable. Recheck before continuing.");
    } finally {
      if (owner.isCurrent() && current === sequence.current) { busy.current = false; setLoading(false); }
    }
  }
  useEffect(() => {
    void recheck();
    const unsubscribe = subscribeAuthentication(() => {
      if (owner.isCurrent()) return;
      sequence.current += 1; request.current?.abort(); clearSeed(); callbacks.current.onForbidden();
    });
    return () => { unsubscribe(); sequence.current += 1; request.current?.abort(); };
  }, []);
  function generate() {
    if (!owner.isCurrent() || busy.current || readiness?.state !== "setup_required" || seed) return;
    try {
      if (!window.isSecureContext) throw new Error("Secure context required");
      setSeed(generateInstallationSecretSeed()); setCopied(false); setMessage("");
    }
    catch { setMessage("A secure browser is required to generate the seed. Open this installation over HTTPS and try again."); }
  }
  async function copy() {
    if (!owner.isCurrent() || busy.current || copying || !seed || readiness?.state !== "setup_required") return;
    const current = sequence.current;
    setCopying(true); setMessage("");
    try {
      owner.assertCurrent();
      await navigator.clipboard.writeText(seed);
      if (owner.isCurrent() && current === sequence.current) setCopied(true);
    } catch {
      if (owner.isCurrent() && current === sequence.current) setMessage("Copy is unavailable. Select the displayed seed and copy it using your browser.");
    } finally { if (owner.isCurrent() && current === sequence.current) setCopying(false); }
  }
  function cancel() {
    sequence.current += 1; request.current?.abort(); clearSeed(); callbacks.current.onCancel();
  }
  return <section className="storage-credential-setup" aria-labelledby="storage-credential-setup-title">
    <h3 id="storage-credential-setup-title">Set up secure credentials — required once</h3>
    <p>The application needs an installation encryption secret before it can save AWS access keys. Your current R2 storage and existing Files stay unchanged.</p>
    {loading && <p role="status">Checking credential setup…</p>}
    {message && <p role="status">{message}</p>}
    {readiness?.state === "setup_required" && <>
      <p>Generate a strong installation seed in this browser. Keep a protected recovery backup: losing this seed can make saved external credentials unreadable.</p>
      {!seed && <button className="button primary" type="button" disabled={loading} onClick={generate}>Generate seed</button>}
      {seed && <div className="storage-installation-seed">
        <span>Installation seed</span><output aria-label="Installation seed">{seed}</output>
        <button className="button" type="button" disabled={copying || loading} onClick={() => void copy()}>{copying ? "Copying…" : "Copy seed"}</button>
        {copied && <p role="status">Seed copied. Save a protected recovery backup before continuing.</p>}
      </div>}
      <ol className="storage-secret-instructions">
        <li>Open your Cloudflare dashboard and choose this Worker.</li>
        <li>Go to <strong>Settings → Variables and Secrets → Secret</strong>.</li>
        <li>Set the name to <code>{INSTALLATION_SECRET_SEED_NAME}</code> and paste the seed as its encrypted runtime Secret value. Save and apply the configuration.</li>
        <li>Return here and choose <strong>Recheck setup</strong>. Enter your AWS access keys only after setup is confirmed.</li>
      </ol>
      <p className="muted">Use a runtime Secret, rather than a Build Variable or plain variable. This application cannot install the Secret for you. The seed is shown only for this setup; it is not saved in browser storage or sent to the application server.</p>
    </>}
    {readiness?.state === "restore_required" && <>
      <h4>Restore existing seed/key</h4>
      <p>This installation has an existing or unavailable encryption configuration. Ask its operator to restore the original protected seed or keyring from its recovery backup, then recheck. Existing encrypted credentials and history are preserved.</p>
    </>}
    {readiness?.state === "configuration_conflict" && <>
      <h4>Resolve the existing secret configuration</h4>
      <p>More than one encryption-root configuration is present. Ask the operator to restore the intended existing configuration without replacing its keys, then recheck.</p>
    </>}
    {readiness?.state === "unavailable" && <p>Credential setup cannot be confirmed. Recheck when the installation is available; current R2 storage does not need a seed.</p>}
    {(readiness?.state === "legacy_ready" || readiness?.state === "seed_ready") && <p role="status">Encryption is configured. Checking access before continuing to AWS S3…</p>}
    <div className="storage-candidate-actions">
      <button className="button" type="button" disabled={loading || copying} onClick={() => void recheck()}>Recheck setup</button>
      <button className="button" type="button" onClick={cancel}>Cancel setup</button>
    </div>
  </section>;
}

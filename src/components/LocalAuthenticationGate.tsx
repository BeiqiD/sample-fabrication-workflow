import { Fragment, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { authenticationGeneration, authenticationSnapshot, readApplicationIdentity, readAuthentication, signIn, signOut, subscribeAuthentication, usesLocalAuthentication } from "../lib/authentication-client";
import { hasUnownedBrowserCheckpoints } from "../lib/browser-checkpoints";

/** The route URL remains untouched while a local session is read or created.
 * Setup and administrator recovery remain deployment-owned offline actions. */
export function LocalAuthenticationGate({ children, verifyRemoteIdentity = false }: { children: ReactNode; verifyRemoteIdentity?: boolean }) {
  const state = useSyncExternalStore(subscribeAuthentication, authenticationSnapshot);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const local = usesLocalAuthentication(), enabled = local || verifyRemoteIdentity;
  const check = local ? readAuthentication : readApplicationIdentity;
  useEffect(() => { if (enabled) void check(); }, [enabled, check]);
  useEffect(() => { if (state.phase !== "anonymous") setPassword(""); }, [state.phase]);
  if (!enabled) return children;
  if (state.phase === "authenticated") return <Fragment key={`${state.principal?.id}:${authenticationGeneration()}`}>
    {hasUnownedBrowserCheckpoints() && <p className="page" role="status">Earlier browser recovery records have no verified account owner and remain saved separately.
      {" "}Review saved jobs from the original account before starting equivalent work.</p>}
    {children}
  </Fragment>;
  if (state.phase === "loading") return <section className="page" aria-live="polite"><p>Checking sign-in status…</p></section>;
  if (state.phase === "error") return <section className="page"><p role="alert">{state.message}</p>
    <button type="button" className="button" onClick={() => void check()}>{local ? "Check session" : "Check access"}</button></section>;
  if (!local) return <section className="page"><p role="alert">Application access changed. Check access before continuing.</p>
    <button type="button" className="button" onClick={() => void readApplicationIdentity()}>Check access</button></section>;
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault(); const secret = password; setPassword(""); await signIn(username, secret);
  }
  return <section className="page">
    <h1>Sign in</h1>
    <p>Use the account created for this installation.</p>
    {state.message && <p role="alert">{state.message}</p>}
    <form onSubmit={event => { void submit(event); }} className="form-grid">
      <label>Account name<input name="username" autoComplete="username" required maxLength={64}
        pattern="[a-z0-9][a-z0-9._-]{0,63}" value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={1024}
        value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button type="submit" className="button primary">Sign in</button>
    </form>
    <button type="button" className="text-button" onClick={() => void readAuthentication()}>Check existing session</button>
  </section>;
}

/** The account action stays in the existing header; a session does not insert
 * an extra row before the mature content/grid geometry. */
export function LocalSessionAction() {
  const state = useSyncExternalStore(subscribeAuthentication, authenticationSnapshot);
  if (!usesLocalAuthentication() || state.phase !== "authenticated") return null;
  return <button type="button" className="theme-toggle" onClick={() => void signOut()}>Sign out</button>;
}

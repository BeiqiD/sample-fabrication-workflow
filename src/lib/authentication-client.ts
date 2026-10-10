/** Only the independent Node client enables this gate. Server session checks
 * remain authoritative; this module never stores a bearer or retries writes. */
export const usesLocalAuthentication = () => import.meta.env.VITE_LOCAL_AUTHENTICATION === "1";
export interface BrowserPrincipal { id: string; actor: string }
export interface AuthenticationSnapshot {
  phase: "loading" | "anonymous" | "authenticated" | "error";
  principal: BrowserPrincipal | null;
  message: string | null;
}
let snapshot: AuthenticationSnapshot = Object.freeze({ phase: "loading", principal: null, message: null });
let csrf: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();
export const authenticationSnapshot = () => snapshot;
export function subscribeAuthentication(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function publish(phase: AuthenticationSnapshot["phase"], principal: BrowserPrincipal | null = null, message: string | null = null): void {
  snapshot = Object.freeze({ phase, principal, message }); listeners.forEach(listener => listener());
}
function anonymous(message: string | null = null): void { csrf = null; publish("anonymous", null, message); }
function required(): void { generation++; anonymous("Your session ended. Sign in to continue."); }

/** Keep the original request and response, including uncertain mutation results.
 * Local mutations carry only the domain-separated CSRF delivered by the server.
 * No cross-origin URL or redirect can receive that value. Cloudflare requests
 * retain their exact existing arguments and never perform a mode/session probe. */
export async function applicationFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!usesLocalAuthentication()) return arguments.length === 1 ? fetch(input) : fetch(input, init);
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), window.location.href);
  if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol)
    || !url.pathname.startsWith("/api/") || url.username || url.password) throw new Error("Application request is unavailable.");
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  headers.delete("x-sfw-csrf");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!csrf || snapshot.phase !== "authenticated") throw new Error("Sign in before changing records.");
    headers.set("x-sfw-csrf", csrf);
  }
  const owner = generation;
  const response = await fetch(input, { ...init, headers, credentials: "same-origin", redirect: "error" });
  if (response.status === 401 && owner === generation) required();
  return response;
}

async function sessionDelivery(response: Response): Promise<{ principal: BrowserPrincipal; csrf: string }> {
  if (!response.ok || !response.body) throw new Error("Authentication is unavailable.");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 4096) throw new Error("Authentication is unavailable.");
      chunks.push(result.value);
    }
    const all = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Authentication is unavailable.");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record.csrf)
      || !record.principal || typeof record.principal !== "object" || Array.isArray(record.principal)) throw new Error("Authentication is unavailable.");
    const principal = record.principal as Record<string, unknown>;
    if (Object.keys(principal).length !== 3 || typeof principal.id !== "string"
      || !/^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(principal.id)
      || principal.actor !== `local-account:${principal.id}` || !principal.capabilities
      || typeof principal.capabilities !== "object" || Array.isArray(principal.capabilities)) throw new Error("Authentication is unavailable.");
    const caps = principal.capabilities as Record<string, unknown>;
    if (Object.keys(caps).length !== 2 || typeof caps.systemAdministrator !== "boolean" || caps.fileEvidenceOperator !== false) throw new Error("Authentication is unavailable.");
    return { principal: Object.freeze({ id: principal.id, actor: principal.actor }), csrf: record.csrf };
  } finally {
    try { await reader.cancel(); } catch { /* Reader cleanup cannot authorize a session. */ }
    reader.releaseLock();
  }
}
const authRequest = (path: string, init: RequestInit = {}) => fetch(`/api/auth${path}`, {
  ...init, cache: "no-store", credentials: "same-origin", redirect: "error",
});
export async function readAuthentication(): Promise<void> {
  const owner = ++generation; csrf = null; publish("loading");
  try {
    const response = await authRequest("/session");
    if (response.status === 401) { if (owner === generation) anonymous(); return; }
    const result = await sessionDelivery(response);
    if (owner === generation) { csrf = result.csrf; publish("authenticated", result.principal); }
  } catch { if (owner === generation) publish("error", null, "Sign-in status is unavailable. Check it again."); }
}
export async function signIn(username: string, password: string): Promise<void> {
  const owner = ++generation;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username) || !password.length || password.length > 1024
    || /[\r\n\0]/.test(password) || new TextEncoder().encode(password).byteLength > 1024) {
    anonymous("Enter your account name and password."); return;
  }
  csrf = null; publish("loading");
  try {
    const response = await authRequest("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    if (response.status === 401) { if (owner === generation) anonymous("Sign-in failed. Check your account name and password."); return; }
    const result = await sessionDelivery(response);
    if (owner === generation) { csrf = result.csrf; publish("authenticated", result.principal); }
  } catch { if (owner === generation) publish("error", null, "The sign-in result is unavailable. Check your session before trying again."); }
}
export async function signOut(): Promise<void> {
  if (!csrf || snapshot.phase !== "authenticated") return;
  const owner = ++generation, token = csrf; csrf = null; publish("loading");
  try {
    const response = await authRequest("/logout", { method: "POST", headers: { "x-sfw-csrf": token } });
    if (owner !== generation) return;
    if (response.status === 204 || response.status === 401) anonymous();
    else publish("error", null, "The sign-out result is unavailable. Check your session.");
  } catch { if (owner === generation) publish("error", null, "The sign-out result is unavailable. Check your session."); }
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { LocalPrincipal, createInstalledLocalIdentity } from './identity';
import { IdentityError } from './identity';
import { PasswordHashError, MAX_PASSWORD_BYTES } from './passwords';
import { hashSessionToken } from './tokens';
import { localAuthTransportAuthority, type LoopbackLocalAuthTransport } from './local-auth-transport';
import type { PrivilegedCapability } from '../../worker/runtime/authorization';

export type LocalIdentityHttpService = Pick<Awaited<ReturnType<typeof createInstalledLocalIdentity>>,
  'login' | 'authenticate' | 'rotate' | 'revoke'>;
export type LocalAuthEnvironment<Bindings extends object = object> = {
  Bindings: Bindings; Variables: { userEmail: string; currentPrincipal: LocalPrincipal };
};
export const MAX_LOCAL_LOGIN_BYTES = 4096;
const CSRF_HEADER = 'x-sfw-csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const denied = (status: 401 | 403) => new HTTPException(status, { message: status === 401 ? 'Authentication is required.' : 'Request admission is required.' });

/** Domain-separated from the persisted session digest. Only this derivation is
 * returned to JavaScript; the high-entropy bearer stays in an HttpOnly cookie. */
function csrf(token: string): string {
  hashSessionToken(token); // Require the versioned canonical bearer spelling.
  return createHash('sha256').update('sample-workflow:session-csrf:v1\0').update(token).digest('base64url');
}
function csrfMatches(token: string, supplied: string | null): boolean {
  if (!supplied || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  const expected = Buffer.from(csrf(token)), actual = Buffer.from(supplied);
  try { return actual.length === expected.length && timingSafeEqual(actual, expected); }
  finally { expected.fill(0); actual.fill(0); }
}
function cookieToken(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header || header.length > 8192) return null;
  let token: string | null = null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('='); if (equals < 0) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    if (token !== null) return null; // Ambiguous path/domain cookies fail closed.
    token = part.slice(equals + 1).trim();
  }
  if (!token) return null;
  try { hashSessionToken(token); return token; } catch { return null; }
}
async function credentials(request: Request): Promise<{ username: string; password: string }> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
    || request.headers.has('content-encoding')) throw new HTTPException(400, { message: 'Credentials are invalid.' });
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: 'Credentials are invalid.' });
  const bytes = new Uint8Array(MAX_LOCAL_LOGIN_BYTES); let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      if (part.value.byteLength > bytes.byteLength - length) throw new HTTPException(413, { message: 'Credentials exceed the supported limit.' });
      bytes.set(part.value, length); length += part.value.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !('username' in value) || !('password' in value)
      || typeof value.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.username)
      || typeof value.password !== 'string' || !value.password.length || value.password.length > MAX_PASSWORD_BYTES
      || Buffer.byteLength(value.password) > MAX_PASSWORD_BYTES || Buffer.from(value.password).toString('utf8') !== value.password) {
      throw new HTTPException(400, { message: 'Credentials are invalid.' });
    }
    return { username: value.username, password: value.password };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: 'Credentials are invalid.' });
  } finally { bytes.fill(0); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** A route/middleware library, not a mounted Node application. Its identity
 * service has already passed current installed admission. The composer retains
 * immutable schema/ledger ownership and discards services before recovery or
 * migrations. No offline bootstrap/reset capability reaches these routes. */
export function createLocalAuthentication<Bindings extends object = object>(options: {
  identity: LocalIdentityHttpService; transport: LoopbackLocalAuthTransport; now: () => number;
}) {
  const { identity, transport, now } = options, authority = localAuthTransportAuthority(transport);
  const routes = new Hono<LocalAuthEnvironment<Bindings>>();
  function originAdmission(request: Request, unsafe: boolean): void {
    // Must be the exact request admitted from actual ingress. Unsupported
    // ingress is an ordinary fixed denial, without native/header error details.
    try { authority.context(request); } catch { throw denied(403); }
    if (new URL(request.url).origin !== authority.publicOrigin) throw denied(403);
    const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
    if (unsafe && origin !== authority.publicOrigin || origin !== null && origin !== authority.publicOrigin
      || site !== null && site !== 'same-origin') throw denied(403);
  }
  function sessionCookie(token: string, expires: number): string {
    // This separate name is development-only. Production requires an actual
    // TLS ingress adapter and __Host- cookie+Secure; no https-header fallback.
    return `${authority.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expires).toUTCString()}`;
  }
  const clearCookie = `${authority.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  async function authenticateRequest(request: Request): Promise<LocalPrincipal> {
    const unsafe = !SAFE.has(request.method); originAdmission(request, unsafe);
    const token = cookieToken(request, authority.cookieName); if (!token) throw denied(401);
    if (unsafe && !csrfMatches(token, request.headers.get(CSRF_HEADER))) throw denied(403);
    let principal: LocalPrincipal | null;
    try { principal = await identity.authenticate(token, now()); }
    catch { throw new HTTPException(503, { message: 'Authentication is unavailable.' }); }
    if (!principal) throw denied(401);
    return principal;
  }
  async function admitActor(request: Request, actor: string): Promise<void> {
    if ((await authenticateRequest(request)).actor !== actor) throw denied(403);
  }
  async function authorize(request: Request, actor: string, capability: PrivilegedCapability): Promise<boolean> {
    const principal = await authenticateRequest(request);
    return principal.actor === actor && principal.capabilities[capability] === true;
  }
  const middleware: MiddlewareHandler<LocalAuthEnvironment<Bindings>> = async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    const principal = await authenticateRequest(c.req.raw);
    c.set('userEmail', principal.actor); c.set('currentPrincipal', principal);
    await next();
  };
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); c.header('X-Content-Type-Options', 'nosniff'); await next(); });
  routes.post('/login', async c => {
    originAdmission(c.req.raw, true);
    const input = await credentials(c.req.raw), timestamp = now();
    try {
      const result = await identity.login({ ...input, now: timestamp, sourceKey: authority.context(c.req.raw).sourceKey });
      c.header('Set-Cookie', sessionCookie(result.token, result.absoluteExpiresAt));
      return c.json({ principal: result.principal, csrf: csrf(result.token) });
    } catch (error) {
      if (error instanceof IdentityError) throw denied(401);
      if (error instanceof PasswordHashError) throw new HTTPException(503, { message: 'Authentication is unavailable.' });
      throw new HTTPException(503, { message: 'Authentication is unavailable.' });
    }
  });
  routes.get('/session', async c => {
    const principal = await authenticateRequest(c.req.raw);
    return c.json({ principal, csrf: csrf(cookieToken(c.req.raw, authority.cookieName)!) });
  });
  routes.post('/logout', async c => {
    await authenticateRequest(c.req.raw);
    try { await identity.revoke(cookieToken(c.req.raw, authority.cookieName), now()); }
    catch { throw new HTTPException(503, { message: 'Authentication is unavailable.' }); }
    c.header('Set-Cookie', clearCookie); return c.body(null, 204);
  });
  routes.post('/rotate', async c => {
    await authenticateRequest(c.req.raw);
    let result: Awaited<ReturnType<LocalIdentityHttpService['rotate']>>;
    try { result = await identity.rotate(cookieToken(c.req.raw, authority.cookieName), now()); }
    catch { throw new HTTPException(503, { message: 'Authentication is unavailable.' }); }
    if (!result) throw denied(401);
    c.header('Set-Cookie', sessionCookie(result.token, result.absoluteExpiresAt));
    return c.json({ principal: result.principal, csrf: csrf(result.token) });
  });
  return Object.freeze({ routes, middleware, authenticateRequest, admitActor, authorize });
}

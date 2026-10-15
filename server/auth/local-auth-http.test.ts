import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server, type IncomingMessage, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createSqliteCapability } from '../sqlite';
import { createPasswordHasher } from './passwords';
import { createPrototypeLocalIdentity, type IdentityPolicy } from './identity';
import { inspectPrototypeIdentityCatalog, PROTOTYPE_IDENTITY_STATEMENTS } from './identity-catalog';
import { createLocalAuthentication, MAX_LOCAL_LOGIN_BYTES, type LocalAuthEnvironment } from './local-auth-http';
import { createLoopbackLocalAuthTransport } from './local-auth-transport';
import { createSessionToken, hashSessionToken } from './tokens';

const POLICY: IdentityPolicy = { absoluteLifetimeMs: 60_000, idleLifetimeMs: 5000, loginWindowMs: 1000, loginAttempts: 5, throttleBuckets: 100 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { initialized?: boolean; admit?: boolean; bind?: string } = {}) {
  const dir = await mkdtemp(join(process.cwd(), '.identity-http-fixture-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'identity.sqlite'), native = new DatabaseSync(path, { allowExtension: false });
  native.exec(PROTOTYPE_IDENTITY_STATEMENTS.join(';'));
  const database = createSqliteCapability(native); cleanups.push(async () => database.close());
  const identity = await createPrototypeLocalIdentity({ database, hasher: createPasswordHasher(), policy: POLICY,
    admission: await inspectPrototypeIdentityCatalog(database) });
  let timestamp = Date.now();
  const offline = identity.offline({ assertHeld() {} });
  const principal = options.initialized === false ? null : await offline.bootstrap({ username: 'operator', password: 'synthetic HTTP password', now: timestamp });
  let dispatch: (request: IncomingMessage, server: Server) => Promise<Response> = async () => new Response(null, { status: 503 });
  const server = createServer((incoming, outgoing) => {
    void dispatch(incoming, server).then(async response => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value;
      const cookies = response.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies;
      outgoing.writeHead(response.status, headers); outgoing.end(Buffer.from(await response.arrayBuffer()));
    }).catch(() => { outgoing.writeHead(403); outgoing.end('Request admission is required.'); });
  });
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  server.listen(0, options.bind ?? '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener failed');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = createLoopbackLocalAuthTransport({ publicOrigin: origin });
  const auth = createLocalAuthentication({ identity, transport, now: () => timestamp });
  const app = new Hono<LocalAuthEnvironment>(); app.route('/api/auth', auth.routes);
  app.use('/api/protected', auth.middleware); app.use('/api/admin', auth.middleware);
  app.get('/api/protected', c => c.json({ actor: c.get('userEmail'), principal: c.get('currentPrincipal') }));
  app.post('/api/protected', c => c.json({ accepted: true, actor: c.get('userEmail') }));
  app.post('/api/admin', async c => c.json({ administrator: await auth.authorize(c.req.raw, c.get('userEmail'), 'systemAdministrator'),
    fileOperator: await auth.authorize(c.req.raw, c.get('userEmail'), 'fileEvidenceOperator') }));
  app.get('/api/recheck-grant', auth.middleware, async c => {
    native.prepare('DELETE FROM local_admin_grants').run();
    return c.json({ administrator: await auth.authorize(c.req.raw, c.get('userEmail'), 'systemAdministrator') });
  });
  app.get('/api/recheck-account', auth.middleware, async c => {
    native.prepare('UPDATE local_accounts SET enabled=0').run();
    await auth.admitActor(c.req.raw, c.get('userEmail')); return c.json({ accepted: true });
  });
  dispatch = async incoming => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const part of value) headers.append(name, part);
      else if (value !== undefined) headers.set(name, value);
    }
    const init: RequestInit & { duplex?: 'half' } = { method: incoming.method, headers };
    if (!['GET', 'HEAD'].includes(incoming.method ?? 'GET')) { init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>; init.duplex = 'half'; }
    const request = new Request(new URL(incoming.url ?? '/', origin), init);
    if (options.admit !== false) transport.admit(request, incoming, server);
    return app.fetch(request);
  };
  async function request(pathname: string, init: RequestInit = {}) { return fetch(origin + pathname, { ...init, redirect: 'manual' }); }
  async function login(init: RequestInit = {}) {
    return request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ username: 'operator', password: 'synthetic HTTP password' }), ...init });
  }
  return { identity, offline, native, database, path, origin, transport, auth, principal, request, login,
    advance(ms: number) { timestamp += ms; } };
}
function bearer(response: Response): string { return response.headers.getSetCookie()[0]!.split(';', 1)[0]!; }
function secret(cookie: string): string { return cookie.slice(cookie.indexOf('=') + 1); }
async function delivery(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.login(); expect(response.status).toBe(200);
  const cookie = bearer(response), body = await response.json() as { principal: { actor: string }; csrf: string };
  return { response, cookie, body };
}

describe('private genuine local identity HTTP library over actual loopback sockets', () => {
  it('delivers the raw bearer only in its development HttpOnly cookie and persists only its hash', async () => {
    const f = await fixture(), { response, cookie, body } = await delivery(f), token = secret(cookie);
    expect(response.headers.get('set-cookie')).toContain('Path=/; HttpOnly; SameSite=Strict; Expires=');
    expect(response.headers.get('set-cookie')).not.toContain('Domain=');
    expect(response.headers.get('set-cookie')).not.toContain('Secure');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(JSON.stringify(body)).not.toContain(token); expect(body.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.csrf).not.toBe(hashSessionToken(token).slice('sha256$1$'.length));
    expect(f.native.prepare('SELECT token_hash FROM local_sessions').get()?.token_hash).toBe(hashSessionToken(token));
    const status = await f.request('/api/auth/session', { headers: { cookie } });
    expect(status.status).toBe(200); expect(await status.json()).toEqual(body);
    expect((await readFile(f.path)).includes(Buffer.from(token))).toBe(false);
  });
  it('requires exact configured Origin and same-origin Fetch Metadata before writing login state', async () => {
    const f = await fixture();
    const deniedHeaders: Record<string, string>[] = [ { 'content-type': 'application/json' }, { 'content-type': 'application/json', origin: 'http://hostile.example' },
      { 'content-type': 'application/json', origin: f.origin, 'sec-fetch-site': 'same-site' },
      { 'content-type': 'application/json', origin: f.origin, 'sec-fetch-site': 'cross-site' } ];
    for (const headers of deniedHeaders) {
      expect((await f.login({ headers })).status).toBe(403);
    }
    expect(f.native.prepare('SELECT COUNT(*) n FROM local_login_throttle').get()?.n).toBe(0);
    expect(f.native.prepare('SELECT COUNT(*) n FROM local_sessions').get()?.n).toBe(0);
  });
  it('bounds streamed credentials, enforces fatal UTF8 and exact input without relying on Content-Length', async () => {
    const f = await fixture();
    const oversized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_LOCAL_LOGIN_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } });
    expect((await f.login({ body: oversized, duplex: 'half' } as RequestInit)).status).toBe(413);
    for (const body of [new Uint8Array([0xff]), '{bad', JSON.stringify({ username: 'operator', password: 'x', unexpected: true }),
      JSON.stringify({ username: 'operator', password: '\ud800' }), JSON.stringify({ username: 'operator', password: 'x'.repeat(1025) })]) {
      expect((await f.login({ body })).status).toBe(400);
    }
    expect((await f.login({ headers: { origin: f.origin, 'content-type': 'text/plain' } })).status).toBe(400);
    expect(f.native.prepare('SELECT COUNT(*) n FROM local_login_throttle').get()?.n).toBe(0);
  });
  it('refuses anonymous initialization and leaves offline bootstrap available', async () => {
    const f = await fixture({ initialized: false }); expect((await f.login()).status).toBe(401);
    expect((await f.request('/api/auth/bootstrap', { method: 'POST', headers: { origin: f.origin } })).status).toBe(404);
    expect(f.native.prepare('SELECT COUNT(*) n FROM local_accounts').get()?.n).toBe(0);
    expect(f.native.prepare('SELECT COUNT(*) n FROM local_auth_events').get()?.n).toBe(0);
    await f.offline.bootstrap({ username: 'operator', password: 'synthetic HTTP password', now: Date.now() });
  });
  it('denies unknown and wrong passwords generically with no cookie or credential reflection', async () => {
    const f = await fixture();
    for (const username of ['operator', 'unknown']) {
      const response = await f.login({ body: JSON.stringify({ username, password: 'wrong synthetic value' }) });
      expect(response.status).toBe(401); expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toBe('Authentication is required.');
    }
  });
  it('requires a fresh persisted session plus exact Origin and matching derived CSRF on domain mutations', async () => {
    const f = await fixture(), { cookie, body } = await delivery(f);
    const anonymousRead = await f.request('/api/protected');
    expect(anonymousRead.status).toBe(401); expect(anonymousRead.headers.get('cache-control')).toBe('private, no-store');
    const protectedRead = await f.request('/api/protected', { headers: { cookie } });
    expect(protectedRead.status).toBe(200); expect((await protectedRead.json() as { actor: string }).actor).toBe(f.principal?.actor);
    const deniedHeaders: Record<string, string>[] = [ { cookie }, { cookie, origin: f.origin }, { cookie, origin: 'http://hostile.example', 'x-sfw-csrf': body.csrf },
      { cookie, origin: f.origin, 'x-sfw-csrf': 'A'.repeat(43) }, { cookie, origin: f.origin, 'x-sfw-csrf': body.csrf, 'sec-fetch-site': 'cross-site' } ];
    for (const headers of deniedHeaders) {
      const response = await f.request('/api/protected', { method: 'POST', headers });
      expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect((await f.request('/api/protected', { method: 'POST', headers: { cookie, origin: f.origin, 'x-sfw-csrf': body.csrf } })).status).toBe(200);
    const random = createSessionToken().token;
    expect((await f.request('/api/auth/session', { headers: { cookie: `sfw_dev_session=${random}` } })).status).toBe(401);
  });
  it('rejects duplicate/malformed cookies and Access-style headers without a genuine local session', async () => {
    const f = await fixture(), { cookie } = await delivery(f);
    const deniedHeaders: Record<string, string>[] = [ { cookie: `${cookie}; ${cookie}` }, { cookie: 'sfw_dev_session=malformed' },
      { 'cf-access-authenticated-user-email': 'operator@example.com', 'x-user-email': f.principal!.actor } ];
    for (const headers of deniedHeaders) {
      expect((await f.request('/api/auth/session', { headers })).status).toBe(401);
    }
    expect((await f.request('/api/auth/session', { headers: { cookie, origin: 'http://hostile.example' } })).status).toBe(403);
  });
  it('rotates explicitly, invalidates old bearer and CSRF, and preserves the original absolute deadline', async () => {
    const f = await fixture(), first = await delivery(f), expires = f.native.prepare('SELECT absolute_expires_at FROM local_sessions').get()?.absolute_expires_at;
    f.advance(500);
    const response = await f.request('/api/auth/rotate', { method: 'POST', headers: { cookie: first.cookie, origin: f.origin, 'x-sfw-csrf': first.body.csrf } });
    expect(response.status).toBe(200); const nextCookie = bearer(response), next = await response.json() as { csrf: string };
    expect(nextCookie).not.toBe(first.cookie); expect(next.csrf).not.toBe(first.body.csrf);
    expect(f.native.prepare('SELECT absolute_expires_at FROM local_sessions').get()?.absolute_expires_at).toBe(expires);
    expect((await f.request('/api/auth/session', { headers: { cookie: first.cookie } })).status).toBe(401);
    expect((await f.request('/api/protected', { method: 'POST', headers: { cookie: nextCookie, origin: f.origin, 'x-sfw-csrf': first.body.csrf } })).status).toBe(403);
    expect((await f.request('/api/auth/session', { headers: { cookie: nextCookie } })).status).toBe(200);
  });
  it('revokes before clearing its cookie and rejects the same bearer after logout', async () => {
    const f = await fixture(), { cookie, body } = await delivery(f);
    const response = await f.request('/api/auth/logout', { method: 'POST', headers: { cookie, origin: f.origin, 'x-sfw-csrf': body.csrf } });
    expect(response.status).toBe(204); expect(await response.text()).toBe('');
    expect(response.headers.get('set-cookie')).toBe('sfw_dev_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    expect(f.native.prepare('SELECT COUNT(*) n FROM local_sessions').get()?.n).toBe(0);
    expect((await f.request('/api/auth/session', { headers: { cookie } })).status).toBe(401);
  });
  it('selects current admin grants separately from actor provenance and keeps File operator false', async () => {
    const f = await fixture(), { cookie, body } = await delivery(f);
    const response = await f.request('/api/admin', { method: 'POST', headers: { cookie, origin: f.origin, 'x-sfw-csrf': body.csrf } });
    expect(await response.json()).toEqual({ administrator: true, fileOperator: false });
    const recheck = await f.request('/api/recheck-grant', { headers: { cookie } });
    expect(await recheck.json()).toEqual({ administrator: false });
    const status = await f.request('/api/auth/session', { headers: { cookie } });
    expect((await status.json() as { principal: { capabilities: { systemAdministrator: boolean } } }).principal.capabilities.systemAdministrator).toBe(false);
  });
  it('fails a later trusted actor admission after the actual account becomes disabled', async () => {
    const f = await fixture(), { cookie } = await delivery(f);
    expect((await f.request('/api/recheck-account', { headers: { cookie } })).status).toBe(401);
    expect((await f.request('/api/auth/session', { headers: { cookie } })).status).toBe(401);
  });
  it('rejects idle expiry and current password-reset revocation through the same actual HTTP surface', async () => {
    const f = await fixture(), first = await delivery(f); f.advance(5000);
    expect((await f.request('/api/auth/session', { headers: { cookie: first.cookie } })).status).toBe(401);
    const next = await delivery(f);
    await f.offline.resetPassword(f.principal!.id, 'replacement synthetic password', Date.now());
    expect((await f.request('/api/auth/session', { headers: { cookie: next.cookie } })).status).toBe(401);
    f.database.close();
    const unavailable = await f.request('/api/protected', { headers: { cookie: next.cookie } });
    expect(unavailable.status).toBe(503); expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
    expect(await unavailable.text()).toBe('Authentication is unavailable.');
  });
  it('rejects a Fetch request with no actual ingress admission and refuses public/proxy origin modes', async () => {
    const f = await fixture({ admit: false }); expect((await f.login()).status).toBe(403);
    for (const publicOrigin of ['https://127.0.0.1', 'https://public.example', 'http://localhost', 'http://0.0.0.0', 'http://127.0.0.2', 'http://127.0.0.1/path']) {
      expect(() => createLoopbackLocalAuthTransport({ publicOrigin })).toThrow('transport');
    }
    expect(() => createLocalAuthentication({ identity: f.identity, now: Date.now,
      transport: { kind: 'numeric-loopback-development', admit() {} } })).toThrow('transport');
  });
  it('rejects a wildcard-bound actual listener despite a loopback request and refuses spoofed Host/proxy headers', async () => {
    const f = await fixture({ bind: '0.0.0.0' }); expect((await f.login()).status).toBe(403);
    const g = await fixture();
    const response = await new Promise<number>(resolve => {
      const request = httpRequest(g.origin + '/api/auth/session', { headers: { host: 'hostile.example', 'x-forwarded-host': new URL(g.origin).host,
        'x-forwarded-proto': 'https', forwarded: `host=${new URL(g.origin).host};proto=https` } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
      request.end();
    });
    expect(response).toBe(403);
  });
});

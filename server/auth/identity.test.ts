import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { createSqliteCapability } from '../sqlite';
import { createPasswordHasher, type PasswordHasher } from './passwords';
import { createSessionToken } from './tokens';
import { createPrototypeLocalIdentity, IdentityError, type IdentityPolicy } from './identity';
import { PROTOTYPE_IDENTITY_STATEMENTS, inspectPrototypeIdentityCatalog } from './identity-catalog';

const POLICY: IdentityPolicy = { absoluteLifetimeMs: 10000, idleLifetimeMs: 1000, loginWindowMs: 5000, loginAttempts: 5, throttleBuckets: 100 };
const paths: string[] = [], connections: ReturnType<typeof createSqliteCapability>[] = [], children: ChildProcess[] = [];
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL'); for (const db of connections.splice(0)) db.close(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(options: { hasher?: PasswordHasher; policy?: IdentityPolicy; bootstrap?: boolean } = {}) {
  const dir = await mkdtemp(join(process.cwd(), '.identity-fixture-')); paths.push(dir);
  const path = join(dir, 'identity.sqlite'), native = new DatabaseSync(path, { allowExtension: false });
  native.exec(PROTOTYPE_IDENTITY_STATEMENTS.join(';'));
  const db = createSqliteCapability(native); connections.push(db);
  const hasher = options.hasher ?? createPasswordHasher();
  const service = await createPrototypeLocalIdentity({ database: db, admission: await inspectPrototypeIdentityCatalog(db), hasher, policy: options.policy ?? POLICY });
  const fence = { assertHeld() {} }, offline = service.offline(fence);
  const actor = options.bootstrap === false ? null : await offline.bootstrap({ username: 'operator', password: 'a real test password', now: 100 });
  return { path, dir, native, db, hasher, service, offline, actor };
}
const login = (service: Awaited<ReturnType<typeof createPrototypeLocalIdentity>>, now = 200, password = 'a real test password', username = 'operator', sourceKey = 'loopback:1') => service.login({ username, password, sourceKey, now });

function message(child: ChildProcess, expected: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Child handshake deadline exceeded')); }, 8000);
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
    const onMessage = (data: unknown) => { if (data && typeof data === 'object' && 'kind' in data && data.kind === expected) { cleanup(); resolve(data as Record<string, unknown>); } };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Child exited before handshake: ${code}`)); };
    child.on('message', onMessage); child.on('exit', onExit);
  });
}
async function raceChildren(path: string, dir: string, command: 'bootstrap' | 'rotate' | 'restore', token?: string, principalId?: string) {
  const output = join(dir, 'identity-child.mjs');
  await build({ entryPoints: [join(import.meta.dirname, 'identity-test-child.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
  const childPair = [0, 1].map(() => { const child = fork(output, [path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child); return child; });
  await Promise.all(childPair.map(child => message(child, 'ready')));
  const outputs = childPair.map(child => message(child, 'result'));
  for (const child of childPair) child.send({ command, token, principalId });
  const result = await Promise.all(outputs);
  await Promise.all(childPair.map(child => new Promise<void>((resolve, reject) => { if (child.exitCode !== null) return child.exitCode === 0 ? resolve() : reject(new Error('Child failed')); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Child failed'))); })));
  return result;
}

describe('isolated local identity persistence', () => {
  it('admits exact code-owned schema, refuses fabricated admission and altered or extra application tables', async () => {
    const f = await fixture({ bootstrap: false });
    await expect(createPrototypeLocalIdentity({ database: f.db, admission: { scope: 'isolated-prototype-only' }, hasher: f.hasher, policy: POLICY })).rejects.toThrow('inspected');
    // LIKE's underscore wildcard must not hide an ordinary application table.
    f.native.exec('CREATE TABLE sqliteX_unreviewed(id TEXT)');
    await expect(inspectPrototypeIdentityCatalog(f.db)).rejects.toThrow('catalog');
    f.native.exec('DROP TABLE sqliteX_unreviewed; CREATE TABLE samples(id TEXT)');
    await expect(inspectPrototypeIdentityCatalog(f.db)).rejects.toThrow('catalog');
    f.native.exec('DROP TABLE samples; ALTER TABLE local_accounts ADD COLUMN surprise TEXT');
    await expect(inspectPrototypeIdentityCatalog(f.db)).rejects.toThrow('catalog');
  });
  it('leaves pre-bootstrap anonymous attempts inert so they cannot prevent offline initialization', async () => {
    const f = await fixture({ bootstrap: false });
    await expect(login(f.service)).rejects.toMatchObject({ code: 'login_denied' });
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_login_throttle').first())?.n).toBe(0n);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_auth_events').first())?.n).toBe(0n);
    const p = await f.offline.bootstrap({ username: 'operator', password: 'real password', now: 300 });
    expect(p.capabilities.systemAdministrator).toBe(true);
  });
  it('creates one offline administrator and stores only versioned verifiers and stable non-email actors', async () => {
    const f = await fixture();
    expect(f.actor?.actor).toBe(`local-account:${f.actor?.id}`);
    expect(f.actor?.capabilities).toEqual({ systemAdministrator: true, fileEvidenceOperator: false });
    const account = await f.db.prepare('SELECT * FROM local_accounts').first();
    expect(account?.password_verifier).toMatch(/^scrypt\$1\$131072\$8\$1\$32\$/);
    expect(JSON.stringify(account, (_, v) => typeof v === 'bigint' ? v.toString() : v)).not.toContain('a real test password');
    await expect(f.offline.bootstrap({ username: 'another', password: 'new password', now: 300 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_accounts').first())?.n).toBe(1n);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_auth_events').first())?.n).toBe(1n);
  });
  it('requires the offline fence before and after asynchronous password work', async () => {
    const f = await fixture({ bootstrap: false }); let calls = 0;
    const offline = f.service.offline({ assertHeld() { if (++calls === 2) throw new Error('Writer fence lost'); } });
    await expect(offline.bootstrap({ username: 'operator', password: 'real password', now: 100 })).rejects.toThrow('Writer fence lost');
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_accounts').first())?.n).toBe(0n);
  });
  it('refuses bootstrap after lost sentinel when any account/audit remains', async () => {
    const f = await fixture(); await f.db.prepare('DELETE FROM local_identity_installation').run();
    await expect(f.offline.bootstrap({ username: 'newoperator', password: 'password', now: 300 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_admin_grants').first())?.n).toBe(1n);
    await expect(login(f.service)).rejects.toMatchObject({ code: 'login_denied' });
  });
  it('survives a real database close/reopen with original identity, current grant and valid session', async () => {
    const f = await fixture(), session = await login(f.service);
    f.db.close(); connections.splice(connections.indexOf(f.db), 1);
    const native = new DatabaseSync(f.path, { allowExtension: false }), reopened = createSqliteCapability(native); connections.push(reopened);
    const service = await createPrototypeLocalIdentity({ database: reopened, admission: await inspectPrototypeIdentityCatalog(reopened), hasher: f.hasher, policy: POLICY });
    expect(await service.authenticate(session.token, 300)).toEqual(f.actor);
    await expect(service.offline({ assertHeld() {} }).bootstrap({ username: 'other', password: 'pass', now: 400 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    const bytes = await readFile(f.path); expect(bytes.includes(Buffer.from(session.token))).toBe(false);
  });
  it('denies wrong, unknown and malformed-password credentials generically without plaintext audit material', async () => {
    const f = await fixture();
    for (const [password, name, src] of [['wrong', 'operator', 'source:1'], ['wrong', 'unknown', 'source:2'], ['', 'operator', 'source:3']]) {
      await expect(login(f.service, 200, password!, name!, src!)).rejects.toMatchObject({ code: 'login_denied' });
    }
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_sessions').first())?.n).toBe(0n);
    const events = (await f.db.prepare('SELECT * FROM local_auth_events').all()).results;
    expect(events.filter(e => e.kind === 'login_denied')).toHaveLength(3);
    expect(JSON.stringify(events, (_, v) => typeof v === 'bigint' ? v.toString() : v)).not.toContain('unknown');
  });
  it('uses persisted username and source quotas with finite bucket count, restart and window admission', async () => {
    const f = await fixture({ policy: { ...POLICY, loginAttempts: 2 } });
    await expect(login(f.service, 200, 'wrong', 'operator', 'src:1')).rejects.toMatchObject({ code: 'login_denied' });
    await expect(login(f.service, 201, 'wrong', 'operator', 'src:2')).rejects.toMatchObject({ code: 'login_denied' });
    await expect(login(f.service, 202, 'a real test password', 'operator', 'src:3')).rejects.toMatchObject({ code: 'login_denied' });
    expect((await f.db.prepare('SELECT attempts FROM local_login_throttle ORDER BY attempts DESC LIMIT 1').first())?.attempts).toBe(2n);
    const allowed = await login(f.service, 5201); expect(allowed.principal.id).toBe(f.actor?.id);
    const limited = await fixture({ policy: { ...POLICY, throttleBuckets: 1 } });
    await expect(login(limited.service)).rejects.toMatchObject({ code: 'login_denied' });
    expect((await limited.db.prepare('SELECT COUNT(*) n FROM local_login_throttle').first())?.n).toBe(1n);
  });
  it('rejects token forgery, idle expiry, absolute expiry and backwards-clock renewal', async () => {
    const f = await fixture(); const s = await login(f.service);
    expect(await f.service.authenticate(`${s.token.slice(0,-1)}!`, 201)).toBeNull();
    expect(await f.service.authenticate('st1_' + 'a'.repeat(43), 201)).toBeNull();
    expect(await f.service.authenticate(s.token, 199)).toBeNull();
    expect(await f.service.authenticate(s.token, 1200)).toBeNull();
    const absolute = await login(f.service, 2000);
    for (let t = 2500; t < 12000; t += 500) expect(await f.service.authenticate(absolute.token, t)).not.toBeNull();
    expect(await f.service.authenticate(absolute.token, 12000)).toBeNull();
  });
  it('rechecks a revoked administrator grant without rewriting principal or ordinary access', async () => {
    const f = await fixture(), s = await login(f.service);
    await f.offline.revokeAdministrator(f.actor!.id, 250);
    const p = await f.service.authenticate(s.token, 300);
    expect(p).toMatchObject({ id: f.actor?.id, actor: f.actor?.actor, capabilities: { systemAdministrator: false, fileEvidenceOperator: false } });
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_sessions').first())?.n).toBe(1n);
  });
  it('rotates atomically, preserves the original absolute deadline and cleans revoked token rows', async () => {
    const f = await fixture(), s = await login(f.service);
    const next = await f.service.rotate(s.token, 400);
    expect(next?.token).not.toBe(s.token); expect(next?.absoluteExpiresAt).toBe(s.absoluteExpiresAt);
    expect(await f.service.authenticate(s.token, 450)).toBeNull();
    expect(await f.service.authenticate(next?.token, 450)).toEqual(f.actor);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_sessions').first())?.n).toBe(1n);
    expect(await f.service.rotate(s.token, 500)).toBeNull();
  });
  it('revokes a session and disables an account across independent current reads', async () => {
    const f = await fixture(), s = await login(f.service);
    // A backwards wall clock cannot turn a successful logout into a no-op.
    await f.service.revoke(s.token, 199); expect(await f.service.authenticate(s.token, 201)).toBeNull();
    const next = await login(f.service, 400);
    await f.offline.disableAccount(f.actor!.id, 450);
    expect(await f.service.authenticate(next.token, 500)).toBeNull();
    await expect(login(f.service, 550)).rejects.toMatchObject({ code: 'login_denied' });
  });
  it('offline password recovery preserves identity, revokes every old credential revision and audits no secret', async () => {
    const f = await fixture(), s = await login(f.service);
    await f.offline.resetPassword(f.actor!.id, 'replacement password', 300);
    expect(await f.service.authenticate(s.token, 350)).toBeNull();
    await expect(login(f.service, 400)).rejects.toMatchObject({ code: 'login_denied' });
    const next = await login(f.service, 500, 'replacement password'); expect(next.principal).toEqual(f.actor);
    expect((await f.db.prepare('SELECT credential_revision FROM local_accounts').first())?.credential_revision).toBe(2n);
    const events = (await f.db.prepare('SELECT * FROM local_auth_events').all()).results;
    expect(events.some(e => e.kind === 'password_reset')).toBe(true);
    expect(JSON.stringify(events, (_, v) => typeof v === 'bigint' ? v.toString() : v)).not.toContain('replacement password');
  });
  it('fences credential changes that occur during actual asynchronous password verification', async () => {
    const underlying = createPasswordHasher(); let resolveStarted!: () => void, resolveRelease!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; }), release = new Promise<void>(resolve => { resolveRelease = resolve; });
    let held = false;
    const hasher: PasswordHasher = { limits: underlying.limits, hash: p => underlying.hash(p), async verify(p, v) { const result = await underlying.verify(p,v); if (held) { resolveStarted(); await release; } return result; } };
    const f = await fixture({ hasher }); held = true;
    const pending = login(f.service); await started;
    await f.offline.resetPassword(f.actor!.id, 'fresh password', 210); resolveRelease();
    await expect(pending).rejects.toMatchObject({ code: 'login_denied' });
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_sessions').first())?.n).toBe(0n);
  });
  it('allows only one simultaneous offline bootstrap across two independent Node processes', async () => {
    const f = await fixture({ bootstrap: false });
    const results = await raceChildren(f.path, f.dir, 'bootstrap');
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.filter(r => r.code === 'bootstrap_unavailable')).toHaveLength(1);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_accounts').first())?.n).toBe(1n);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_admin_grants').first())?.n).toBe(1n);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_auth_events WHERE kind=\'bootstrap\'').first())?.n).toBe(1n);
  }, 15000);
  it('permits one rotation winner across independent processes and authenticates its committed token from a fresh read', async () => {
    const f = await fixture(), s = await login(f.service);
    const results = await raceChildren(f.path, f.dir, 'rotate', s.token);
    const winners = results.filter(r => r.ok); expect(winners).toHaveLength(1);
    expect(await f.service.authenticate(s.token, 450)).toBeNull();
    expect(await f.service.authenticate(winners[0]?.token, 450)).toEqual(f.actor);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_sessions').first())?.n).toBe(1n);
  }, 15000);
  it('bounds live session count and audit history without arbitrary user-controlled entries', async () => {
    const f = await fixture({ policy: { ...POLICY, loginAttempts: 20 } });
    const sessions = [];
    for (let i = 0; i < 16; i++) sessions.push(await login(f.service, 200 + i));
    await expect(login(f.service, 220)).rejects.toMatchObject({ code: 'login_denied' });
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_sessions').first())?.n).toBe(16n);
    for (let i = 0; i < 1010; i++) await f.service.offline({ assertHeld() {} }).revokeAdministrator(f.actor!.id, 250 + i);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_auth_events').first())?.n).toBe(1000n);
    expect(await f.service.authenticate(sessions[0]?.token, 1200)).toBeNull();
  }, 15000);
  it('keeps restored identity inert until a fenced operator selects an exact existing principal and fresh password', async () => {
    const f = await fixture(), original = f.actor!;
    const oldSession = await login(f.service);
    const account = await f.db.prepare('SELECT password_verifier FROM local_accounts').first();
    await f.db.prepare('INSERT INTO local_accounts VALUES(?,?,?,?,?,?)').bind('local_11111111-1111-4111-8111-111111111111', 'other', account!.password_verifier, 1, 0, 100).run();
    f.native.exec('DELETE FROM local_sessions; DELETE FROM local_admin_grants; DELETE FROM local_identity_installation; DELETE FROM local_login_throttle; UPDATE local_accounts SET enabled=0');
    expect(await f.service.authenticate(oldSession.token, 250)).toBeNull();
    await expect(login(f.service, 260)).rejects.toMatchObject({ code: 'login_denied' });
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_login_throttle').first())?.n).toBe(0n);
    const restored = await f.offline.restoreAdministrator({ principalId: original.id, password: 'new destination password', now: 300 });
    expect(restored).toEqual(original);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_accounts').first())?.n).toBe(2n);
    expect((await f.db.prepare("SELECT enabled FROM local_accounts WHERE username='other'").first())?.enabled).toBe(0n);
    expect((await f.db.prepare('SELECT credential_revision FROM local_accounts WHERE principal_id=?').bind(original.id).first())?.credential_revision).toBe(2n);
    await expect(login(f.service, 400)).rejects.toMatchObject({ code: 'login_denied' });
    const session = await login(f.service, 500, 'new destination password');
    expect(await f.service.authenticate(session.token, 550)).toEqual(original);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM local_auth_events WHERE kind='destination_bootstrap'").first())?.n).toBe(1n);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM local_auth_events WHERE kind='bootstrap'").first())?.n).toBe(1n);
  });
  it('never partially changes an account or audit when destination bootstrap encounters existing authority', async () => {
    const f = await fixture(), id = f.actor!.id;
    // A preexisting sentinel for this same principal must not let later batch
    // statements mutate the account after its first insertion returns zero.
    await f.db.prepare('UPDATE local_accounts SET enabled=0 WHERE principal_id=?').bind(id).run();
    const before = await f.db.prepare('SELECT * FROM local_accounts').first();
    await expect(f.offline.restoreAdministrator({ principalId: id, password: 'must not install', now: 300 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    expect(await f.db.prepare('SELECT * FROM local_accounts').first()).toEqual(before);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM local_auth_events WHERE kind='destination_bootstrap'").first())?.n).toBe(0n);
  });
  it('refuses destination bootstrap with unknown principal, max revision or remaining bearer/grant/throttle authority', async () => {
    const f = await fixture(), id = f.actor!.id;
    f.native.exec('DELETE FROM local_admin_grants; DELETE FROM local_identity_installation; UPDATE local_accounts SET enabled=0');
    await expect(f.offline.restoreAdministrator({ principalId: 'local_11111111-1111-4111-8111-111111111111', password: 'password', now: 300 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    await f.db.prepare('UPDATE local_accounts SET credential_revision=9007199254740991').run();
    await expect(f.offline.restoreAdministrator({ principalId: id, password: 'password', now: 300 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    await f.db.prepare('UPDATE local_accounts SET credential_revision=1').run();
    await f.db.prepare('INSERT INTO local_login_throttle VALUES(?,?,?)').bind('a'.repeat(64), 200, 1).run();
    await expect(f.offline.restoreAdministrator({ principalId: id, password: 'password', now: 300 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    await f.db.prepare('DELETE FROM local_login_throttle').run();
    await f.db.prepare('INSERT INTO local_admin_grants VALUES(?,?)').bind(id,100).run();
    await expect(f.offline.restoreAdministrator({ principalId: id, password: 'password', now: 300 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    await f.db.prepare('DELETE FROM local_admin_grants').run();
    const residual = createSessionToken();
    await f.db.prepare('INSERT INTO local_sessions VALUES(?,?,?,?,?,?,?)').bind(residual.tokenHash, id, 1, 200, 1200, 200, null).run();
    await expect(f.offline.restoreAdministrator({ principalId: id, password: 'password', now: 300 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_identity_installation').first())?.n).toBe(0n);
    expect((await f.db.prepare('SELECT credential_revision FROM local_accounts').first())?.credential_revision).toBe(1n);
  });
  it('allows one destination authority winner across two actual independent processes without a losing partial update', async () => {
    const f = await fixture(), id = f.actor!.id;
    f.native.exec('DELETE FROM local_admin_grants; DELETE FROM local_identity_installation; UPDATE local_accounts SET enabled=0');
    const results = await raceChildren(f.path, f.dir, 'restore', undefined, id);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.code === 'bootstrap_unavailable')).toHaveLength(1);
    expect((await f.db.prepare('SELECT credential_revision FROM local_accounts').first())?.credential_revision).toBe(2n);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_admin_grants').first())?.n).toBe(1n);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM local_auth_events WHERE kind='destination_bootstrap'").first())?.n).toBe(1n);
    const session = await login(f.service, 500, 'destination child password');
    expect(session.principal).toEqual(f.actor);
  }, 15000);
  it('validates bounded policy, canonical usernames and trusted source buckets before writes', async () => {
    const f = await fixture();
    await expect(login(f.service, 200, 'pw', 'Operator')).rejects.toBeInstanceOf(IdentityError);
    await expect(login(f.service, 200, 'pw', 'operator', 'untrusted forward header')).rejects.toBeInstanceOf(IdentityError);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM local_login_throttle').first())?.n).toBe(0n);
    await expect(createPrototypeLocalIdentity({ database: f.db, admission: await inspectPrototypeIdentityCatalog(f.db), hasher: f.hasher, policy: { ...POLICY, loginAttempts: 21 } })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

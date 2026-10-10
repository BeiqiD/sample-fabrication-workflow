import { createHash, randomUUID, randomBytes } from 'node:crypto';
import type { SqliteCapability, SqliteRow, SqliteStatement } from '../sqlite';
import { checkedSafeInteger, assertSqliteConnectionOwner } from '../sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from '../migrations';
import type { PasswordHasher } from './passwords';
import { createSessionToken, hashSessionToken, SessionTokenError } from './tokens';
import { assertExactLocalIdentityObjects, assertPrototypeIdentityAdmission, inspectPrototypeIdentityCatalog, type PrototypeIdentityCatalogAdmission } from './identity-catalog';

export interface LocalPrincipal {
  readonly id: string;
  readonly actor: string;
  readonly capabilities: Readonly<{ systemAdministrator: boolean; fileEvidenceOperator: false }>;
}
export interface LocalSessionDelivery { readonly token: string; readonly principal: LocalPrincipal; readonly absoluteExpiresAt: number }
export interface IdentityPolicy { absoluteLifetimeMs: number; idleLifetimeMs: number; loginWindowMs: number; loginAttempts: number; throttleBuckets: number }
export interface OfflineWriterFence { assertHeld(): void }
export class IdentityError extends Error {
  readonly code: 'invalid_input' | 'login_denied' | 'bootstrap_unavailable' | 'account_unavailable';
  constructor(code: IdentityError['code']) {
    super(code === 'invalid_input' ? 'Local identity input is invalid' : 'Local identity operation is unavailable'); this.name = 'IdentityError'; this.code = code;
  }
}
const ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function principal(row: SqliteRow): LocalPrincipal {
  const id = row.principal_id;
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Stored local principal is invalid');
  return Object.freeze({ id, actor: `local-account:${id}`, capabilities: Object.freeze({ systemAdministrator: row.is_administrator === 1n || row.is_administrator === 1, fileEvidenceOperator: false as const }) });
}
function time(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 31 * 86400_000) throw new IdentityError('invalid_input');
  return value;
}
function username(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new IdentityError('invalid_input');
  return value;
}
function identity(value: string): string { if (!ID.test(value)) throw new IdentityError('invalid_input'); return value; }
function source(value: string): string {
  // Deployment-owned opaque rate bucket, never arbitrary forwarded headers.
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new IdentityError('invalid_input'); return value;
}
function policy(input: IdentityPolicy): Readonly<IdentityPolicy> {
  const allowed = ['absoluteLifetimeMs', 'idleLifetimeMs', 'loginWindowMs', 'loginAttempts', 'throttleBuckets'];
  if (!input || Object.keys(input).length !== allowed.length || Object.keys(input).some(key => !allowed.includes(key))
    || Object.values(input).some(value => !Number.isSafeInteger(value) || value < 1)
    || input.absoluteLifetimeMs > 30 * 86400_000 || input.idleLifetimeMs > 86400_000 || input.idleLifetimeMs > input.absoluteLifetimeMs
    || input.loginWindowMs > 3600_000 || input.loginAttempts > 20 || input.throttleBuckets > 1000) throw new IdentityError('invalid_input');
  return Object.freeze({ ...input });
}
const hashBucket = (domain: string, value: string) => createHash('sha256').update(`sample-workflow:login-throttle:v1:${domain}\0`).update(value).digest('hex');
const catalogGuard = "EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1')";
const currentAccount = 'EXISTS(SELECT 1 FROM local_accounts a WHERE a.principal_id=local_sessions.principal_id AND a.enabled=1 AND a.credential_revision=local_sessions.credential_revision)';
const validSession = `revoked_at IS NULL AND ? >= last_seen_at AND ? < absolute_expires_at AND ? < last_seen_at + ? AND ${currentAccount} AND ${catalogGuard}`;

/** Genuine persistence prototype, not an installed login route. The sole
 * composition-owned hasher bounds KDF concurrency; no SQL transaction spans it.
 * Admission is bound to this connection; catalog edits during host ownership are
 * unsupported, and production table admission remains a separate paired change.
 * `now`, sourceKey and offline fencing are deployment-owned inputs, never request
 * body values or arbitrary proxy headers. A real stopped-writer fence, cookies,
 * CSRF and HTTP route composition are not supplied by this prototype. */
interface PersistenceOptions { database: SqliteCapability; hasher: PasswordHasher; policy: IdentityPolicy }
export async function createPrototypeLocalIdentity(options: PersistenceOptions & { admission: PrototypeIdentityCatalogAdmission }) {
  const { database, admission, hasher } = options, limits = policy(options.policy);
  assertPrototypeIdentityAdmission(admission);
  const validate = async () => { await inspectPrototypeIdentityCatalog(database); };
  await validate(); return createIdentityPersistence({ database, hasher, policy: limits }, validate);
}

/** Full-application library constructor, deliberately not installed by a product
 * route/composer. Admission is minted by the actual reviewed installation
 * inspector, bound to the native connection; exact fixed identity DDL is checked
 * in addition to the complete current checkpoint/ledger. A code-owned paired
 * current catalog is still required; arbitrary archive DDL is never an input.
 * Installation admission is inspected at construction, not on every operation.
 * The trusted composer must keep schema/ledger/installation identity immutable
 * for this service lifetime and fence/discard it before migration or recovery;
 * account/session/grant changes through the fixed schema remain independently
 * current. Closing the owned connection invalidates all old service operations. */
export async function createInstalledLocalIdentity(options: PersistenceOptions & {
  nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
}) {
  // Capture one tuple before any await; a mutable caller options object cannot
  // switch the validated owner while persistence keeps an earlier database.
  const { database, nativeDatabase, admission, hasher } = options, limits = policy(options.policy);
  const validate = async () => {
    assertSqliteConnectionOwner(database, nativeDatabase);
    assertInstallationAdmission(nativeDatabase, admission);
    await assertExactLocalIdentityObjects(database);
  };
  await validate(); return createIdentityPersistence({ database, hasher, policy: limits }, validate);
}

async function createIdentityPersistence(options: PersistenceOptions, validate: () => Promise<void>) {
  const db = options.database, limits = policy(options.policy), hasher = options.hasher;
  const dummyVerifier = await hasher.hash(randomBytes(32).toString('base64url'));
  // The bounded KDF awaits outside transactions. A changed installation/catalog
  // during constructor work must fail before an identity writer is returned.
  await validate();
  const statement = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  const audit = (kind: string, id: string | null, now: number, condition = '1', bindings: unknown[] = []): SqliteStatement =>
    statement(`INSERT INTO local_auth_events(principal_id,kind,happened_at) SELECT ?,?,? WHERE ${condition}`, id, kind, now, ...bindings);
  const trimAudit = () => statement('DELETE FROM local_auth_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM local_auth_events)');
  const readPrincipal = (id: string) => statement('SELECT principal_id,EXISTS(SELECT 1 FROM local_admin_grants g WHERE g.principal_id=a.principal_id) AS is_administrator FROM local_accounts a WHERE principal_id=? AND enabled=1', id);
  const delivery = (token: string, row: SqliteRow, expires: number): LocalSessionDelivery => Object.freeze({ token, principal: principal(row), absoluteExpiresAt: expires });
  function tokenHash(token: unknown): string | null {
    try { return hashSessionToken(token); } catch (error) { if (error instanceof SessionTokenError && error.code === 'invalid_token') return null; throw error; }
  }
  async function deny(now: number): Promise<never> {
    await db.batch([audit('login_denied', null, now), trimAudit()]); throw new IdentityError('login_denied');
  }
  async function reserve(name: string, sourceKey: string, now: number): Promise<boolean> {
    const keys = [hashBucket('username', name), hashBucket('source', sourceKey)];
    const result = await db.batch([
      statement('DELETE FROM local_login_throttle WHERE window_started_at <= ?', now - limits.loginWindowMs),
      ...keys.map(key => statement(`INSERT INTO local_login_throttle(bucket_hash,window_started_at,attempts)
        SELECT ?,?,1 WHERE EXISTS(SELECT 1 FROM local_login_throttle WHERE bucket_hash=?) OR (SELECT COUNT(*) FROM local_login_throttle) < ?
        ON CONFLICT(bucket_hash) DO UPDATE SET attempts=attempts+1
        WHERE ? >= window_started_at AND attempts < ? RETURNING bucket_hash`, key, now, key, limits.throttleBuckets, now, limits.loginAttempts)),
    ]);
    return result[1]!.results.length === 1 && result[2]!.results.length === 1;
  }
  const api = {
    async login(input: { username: string; password: string; sourceKey: string; now: number }): Promise<LocalSessionDelivery> {
      const name = username(input.username), now = time(input.now), sourceKey = source(input.sourceKey);
      // No anonymous pre-bootstrap attempt may create throttle/audit state that
      // would poison the one offline initialization. Missing installation state
      // stays closed and is never re-created by login.
      if (!await statement(`SELECT singleton FROM local_identity_installation WHERE singleton=1 AND ${catalogGuard}`).first()) throw new IdentityError('login_denied');
      if (!await reserve(name, sourceKey, now)) return deny(now);
      const account = await statement(`SELECT principal_id,password_verifier,credential_revision,enabled FROM local_accounts WHERE username=? AND ${catalogGuard}`, name).first();
      const candidate = account?.enabled === 1n || account?.enabled === 1 ? account : null;
      let verified = false;
      try { verified = await hasher.verify(input.password, candidate?.password_verifier ?? dummyVerifier); }
      catch (error) {
        // Input errors are ordinary generic denial; KDF capacity/config/provider
        // failure retains its bounded explicit error and creates no session.
        if (!(error instanceof Error && 'code' in error && error.code === 'invalid_password')) throw error;
      }
      if (!candidate || !verified) return deny(now);
      const id = identity(candidate.principal_id as string), revision = candidate.credential_revision;
      const token = createSessionToken(), expires = now + limits.absoluteLifetimeMs;
      const result = await db.batch([
        statement('DELETE FROM local_sessions WHERE revoked_at IS NOT NULL OR absolute_expires_at <= ? OR last_seen_at + ? <= ?', now, limits.idleLifetimeMs, now),
        statement(`INSERT INTO local_sessions(token_hash,principal_id,credential_revision,created_at,absolute_expires_at,last_seen_at)
          SELECT ?,principal_id,credential_revision,?,?,? FROM local_accounts
          WHERE principal_id=? AND password_verifier=? AND credential_revision=? AND enabled=1 AND ${catalogGuard}
          AND (SELECT COUNT(*) FROM local_sessions WHERE principal_id=?) < 16 RETURNING principal_id`,
          token.tokenHash, now, expires, now, id, candidate.password_verifier, revision, id),
        readPrincipal(id), audit('login', id, now, 'EXISTS(SELECT 1 FROM local_sessions WHERE token_hash=?)', [token.tokenHash]), trimAudit(),
      ]);
      if (result[1]!.results.length !== 1 || result[2]!.results.length !== 1) return deny(now);
      return delivery(token.token, result[2]!.results[0]!, expires);
    },
    async authenticate(token: unknown, at: number): Promise<LocalPrincipal | null> {
      const now = time(at), hash = tokenHash(token); if (!hash) return null;
      const results = await db.batch([
        statement(`UPDATE local_sessions SET last_seen_at=? WHERE token_hash=? AND ${validSession} RETURNING principal_id`, now, hash, now, now, now, limits.idleLifetimeMs),
        statement(`SELECT a.principal_id,EXISTS(SELECT 1 FROM local_admin_grants g WHERE g.principal_id=a.principal_id) AS is_administrator
          FROM local_accounts a JOIN local_sessions s ON s.principal_id=a.principal_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND a.enabled=1 AND s.credential_revision=a.credential_revision`, hash),
      ]);
      return results[0]!.results.length === 1 && results[1]!.results.length === 1 ? principal(results[1]!.results[0]!) : null;
    },
    async rotate(token: unknown, at: number): Promise<LocalSessionDelivery | null> {
      const now = time(at), hash = tokenHash(token); if (!hash) return null;
      const next = createSessionToken();
      const results = await db.batch([
        statement(`INSERT INTO local_sessions(token_hash,principal_id,credential_revision,created_at,absolute_expires_at,last_seen_at)
          SELECT ?,principal_id,credential_revision,?,absolute_expires_at,? FROM local_sessions
          WHERE token_hash=? AND ${validSession} RETURNING principal_id,absolute_expires_at`, next.tokenHash, now, now, hash, now, now, now, limits.idleLifetimeMs),
        statement('UPDATE local_sessions SET revoked_at=? WHERE token_hash=? AND EXISTS(SELECT 1 FROM local_sessions WHERE token_hash=?)', now, hash, next.tokenHash),
        statement(`SELECT a.principal_id,EXISTS(SELECT 1 FROM local_admin_grants g WHERE g.principal_id=a.principal_id) AS is_administrator
          FROM local_accounts a JOIN local_sessions s ON s.principal_id=a.principal_id WHERE s.token_hash=?`, next.tokenHash),
        statement("INSERT INTO local_auth_events(principal_id,kind,happened_at) SELECT principal_id,'session_rotated',? FROM local_sessions WHERE token_hash=?", now, next.tokenHash),
        statement('DELETE FROM local_sessions WHERE revoked_at IS NOT NULL'), trimAudit(),
      ]);
      const row = results[0]!.results[0];
      return row && results[2]!.results[0] ? delivery(next.token, results[2]!.results[0], checkedSafeInteger(row.absolute_expires_at as number | bigint)) : null;
    },
    async revoke(token: unknown, at: number): Promise<void> {
      const now = time(at), hash = tokenHash(token); if (hash) await db.batch([
        statement('UPDATE local_sessions SET revoked_at=MAX(?,created_at) WHERE token_hash=? AND revoked_at IS NULL', now, hash),
        statement('DELETE FROM local_sessions WHERE revoked_at IS NOT NULL'),
      ]);
    },
    offline(fence: OfflineWriterFence) {
      if (!fence || typeof fence.assertHeld !== 'function') throw new IdentityError('invalid_input');
      return Object.freeze({
        async bootstrap(input: { username: string; password: string; now: number }): Promise<LocalPrincipal> {
          fence.assertHeld(); const name = username(input.username), now = time(input.now), id = `local_${randomUUID()}`;
          const verifier = await hasher.hash(input.password); fence.assertHeld();
          const result = await db.batch([
            statement(`INSERT INTO local_identity_installation(singleton,bootstrap_principal_id,catalog_id,initialized_at)
              SELECT 1,?,'local-identity-v1',? WHERE NOT EXISTS(SELECT 1 FROM local_identity_installation)
              AND NOT EXISTS(SELECT 1 FROM local_accounts) AND NOT EXISTS(SELECT 1 FROM local_admin_grants)
              AND NOT EXISTS(SELECT 1 FROM local_sessions) AND NOT EXISTS(SELECT 1 FROM local_login_throttle) AND NOT EXISTS(SELECT 1 FROM local_auth_events) RETURNING singleton`, id, now),
            statement(`INSERT INTO local_accounts(principal_id,username,password_verifier,credential_revision,enabled,created_at)
              SELECT ?,?,?,1,1,? WHERE EXISTS(SELECT 1 FROM local_identity_installation WHERE bootstrap_principal_id=?)`, id, name, verifier, now, id),
            statement('INSERT INTO local_admin_grants(principal_id,granted_at) SELECT ?,? WHERE EXISTS(SELECT 1 FROM local_accounts WHERE principal_id=?)', id, now, id),
            audit('bootstrap', id, now, 'EXISTS(SELECT 1 FROM local_accounts WHERE principal_id=?)', [id]),
          ]);
          if (result[0]!.results.length !== 1) throw new IdentityError('bootstrap_unavailable');
          return principal({ principal_id: id, is_administrator: 1 });
        },
        /** Explicit destination authority, never first-web-visitor initialization.
         * Imported principals/verifiers are not grants. A fenced operator chooses
         * one exact existing principal and a fresh password; other accounts stay
         * disabled and historical audit attribution remains unchanged. */
        async restoreAdministrator(input: { principalId: string; password: string; now: number }): Promise<LocalPrincipal> {
          fence.assertHeld(); const id = identity(input.principalId), now = time(input.now);
          const verifier = await hasher.hash(input.password); fence.assertHeld();
          // Fixed DDL has no identity triggers. Native changes() fences each
          // following statement to the preceding direct write in this same
          // synchronous batch, preventing partial updates after a zero-row gate.
          const result = await db.batch([
            statement(`INSERT INTO local_identity_installation(singleton,bootstrap_principal_id,catalog_id,initialized_at)
              SELECT 1,principal_id,'local-identity-v1',? FROM local_accounts
              WHERE principal_id=? AND enabled=0 AND credential_revision < 9007199254740991
              AND NOT EXISTS(SELECT 1 FROM local_identity_installation)
              AND NOT EXISTS(SELECT 1 FROM local_admin_grants) AND NOT EXISTS(SELECT 1 FROM local_sessions)
              AND NOT EXISTS(SELECT 1 FROM local_login_throttle) RETURNING singleton`, now, id),
            statement(`UPDATE local_accounts SET password_verifier=?,credential_revision=credential_revision+1,enabled=1
              WHERE principal_id=? AND enabled=0 AND credential_revision < 9007199254740991 AND changes()=1
              AND EXISTS(SELECT 1 FROM local_identity_installation WHERE bootstrap_principal_id=?)`, verifier, id, id),
            statement(`INSERT INTO local_admin_grants(principal_id,granted_at) SELECT ?,? FROM local_accounts
              WHERE principal_id=? AND enabled=1 AND password_verifier=? AND changes()=1
              AND EXISTS(SELECT 1 FROM local_identity_installation WHERE bootstrap_principal_id=?)`, id, now, id, verifier, id),
            audit('destination_bootstrap', id, now, 'changes()=1 AND EXISTS(SELECT 1 FROM local_admin_grants WHERE principal_id=?)', [id]),
            statement('DELETE FROM local_auth_events WHERE changes()=1 AND sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM local_auth_events)'),
          ]);
          if (result[0]!.results.length !== 1) throw new IdentityError('bootstrap_unavailable');
          return principal({ principal_id: id, is_administrator: 1 });
        },
        async resetPassword(idInput: string, password: string, at: number): Promise<void> {
          fence.assertHeld(); const id = identity(idInput), now = time(at), verifier = await hasher.hash(password); fence.assertHeld();
          const results = await db.batch([
            statement('UPDATE local_accounts SET password_verifier=?,credential_revision=credential_revision+1 WHERE principal_id=? AND credential_revision < 9007199254740991 RETURNING principal_id', verifier, id),
            statement('UPDATE local_sessions SET revoked_at=MAX(?,created_at) WHERE principal_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM local_accounts WHERE principal_id=? AND password_verifier=?)', now, id, id, verifier),
            audit('password_reset', id, now, 'EXISTS(SELECT 1 FROM local_accounts WHERE principal_id=? AND password_verifier=?)', [id, verifier]), trimAudit(),
          ]);
          if (!results[0]!.results.length) throw new IdentityError('account_unavailable');
        },
        async disableAccount(idInput: string, at: number): Promise<void> {
          fence.assertHeld(); const id = identity(idInput), now = time(at);
          await db.batch([statement('UPDATE local_accounts SET enabled=0 WHERE principal_id=?', id),
            statement('UPDATE local_sessions SET revoked_at=MAX(?,created_at) WHERE principal_id=? AND revoked_at IS NULL', now, id),
            audit('account_disabled', id, now, 'EXISTS(SELECT 1 FROM local_accounts WHERE principal_id=?)', [id]), trimAudit()]);
        },
        async revokeAdministrator(idInput: string, at: number): Promise<void> {
          fence.assertHeld(); const id = identity(idInput), now = time(at);
          await db.batch([statement('DELETE FROM local_admin_grants WHERE principal_id=?', id),
            audit('administrator_revoked', id, now, 'EXISTS(SELECT 1 FROM local_accounts WHERE principal_id=?)', [id]), trimAudit()]);
        },
      });
    },
  };
  return Object.freeze(api);
}

import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createSqliteCapability } from '../sqlite';
import { admitInstallationRecoverySource, installReviewedSqliteCatalog, installationSchemaDigest, installationSqlDigest, NODE_PLATFORM_OBJECTS,
  type InstallationSchemaObject, type ReviewedInstallationAdmission, type ReviewedInstallationCatalog, type ReviewedInstallationCheckpoint } from '../migrations';
import { createPasswordHasher, type PasswordHasher } from './passwords';
import { createInstalledLocalIdentity, createPrototypeLocalIdentity } from './identity';
import { PROTOTYPE_IDENTITY_STATEMENTS, inspectPrototypeIdentityCatalog } from './identity-catalog';

const POLICY = { absoluteLifetimeMs: 10000, idleLifetimeMs: 1000, loginWindowMs: 5000, loginAttempts: 5, throttleBuckets: 100 };
const paths: string[] = [], cores: ReturnType<typeof createSqliteCapability>[] = [];
afterEach(async () => { for (const core of cores.splice(0)) core.close(); for (const path of paths.splice(0)) await rm(path, { force: true, recursive: true }); });
const SAMPLE_DDL = 'CREATE TABLE samples(id TEXT PRIMARY KEY, label TEXT NOT NULL)';
function object(sql: string): InstallationSchemaObject {
  const table = /^CREATE TABLE (\w+)/.exec(sql), index = /^CREATE INDEX (\w+) ON (\w+)/.exec(sql);
  if (table) return { type: 'table', name: table[1]!, tableName: table[1]!, sql };
  if (index) return { type: 'index', name: index[1]!, tableName: index[2]!, sql };
  throw new Error('Fixture statement is not code-owned table/index DDL');
}
function checkpoint(id: string, applicationObjects: InstallationSchemaObject[]): ReviewedInstallationCheckpoint {
  const schemaSha256 = installationSchemaDigest([...applicationObjects, ...NODE_PLATFORM_OBJECTS]);
  return { id, applicationObjects, schemaSha256, recoveryAdmission: { kind: 'node-installation-recovery-admission/1', checkpointId: id, schemaSha256, platformObjects: NODE_PLATFORM_OBJECTS } };
}
async function fixture(ddl: readonly string[] = PROTOTYPE_IDENTITY_STATEMENTS) {
  const dir = await mkdtemp(join(process.cwd(), '.installed-identity-fixture-')); paths.push(dir);
  const path = join(dir, 'application.sqlite'), native = new DatabaseSync(path, { allowExtension: false }), core = createSqliteCapability(native); cores.push(core);
  const sql = [SAMPLE_DDL, ...ddl].join(';');
  const catalog: ReviewedInstallationCatalog = { id: 'identity-integration-reviewed-fixture/1', emptyCheckpoint: checkpoint('empty', []),
    migrations: [{ name: 'fixture_identity.sql', sql, rawSha256: installationSqlDigest(sql), checkpoint: checkpoint('fixture-identity-current', [SAMPLE_DDL,...ddl].map(object)) }] };
  const receipt = installReviewedSqliteCatalog(native, catalog), admission = admitInstallationRecoverySource(native, catalog);
  return { path, native, core, catalog, receipt, admission, hasher: createPasswordHasher() };
}

describe('explicit installed identity catalog admission', () => {
  it('accepts genuine complete checkpoint alongside business tables while isolated prototype admission still refuses it', async () => {
    const f = await fixture();
    await expect(inspectPrototypeIdentityCatalog(f.core)).rejects.toThrow('catalog');
    const service = await createInstalledLocalIdentity({ database: f.core, nativeDatabase: f.native, admission: f.admission, hasher: f.hasher, policy: POLICY });
    const actor = await service.offline({ assertHeld() {} }).bootstrap({ username: 'operator', password: 'installation test password', now: 100 });
    const session = await service.login({ username: 'operator', password: 'installation test password', sourceKey: 'trusted:loopback', now: 200 });
    expect(await service.authenticate(session.token, 300)).toEqual(actor);
    expect((await f.core.prepare('SELECT installation_id FROM node_installation').first())?.installation_id).toBe(f.receipt.installationId);
    expect((await f.core.prepare('SELECT COUNT(*) n FROM samples').first())?.n).toBe(0n);
  });
  it('rejects forged inspection token, wrong native connection and wrong SQL capability before KDF work', async () => {
    const a = await fixture(), b = await fixture(); let hashes = 0;
    const hasher: PasswordHasher = { limits: a.hasher.limits, async hash(p) { hashes++; return a.hasher.hash(p); }, verify: (p,v) => a.hasher.verify(p,v) };
    const options = { database: a.core, nativeDatabase: a.native, admission: a.admission, hasher, policy: POLICY };
    await expect(createInstalledLocalIdentity({ ...options, admission: { ...a.admission } as ReviewedInstallationAdmission })).rejects.toThrow('admission_not_issued');
    await expect(createInstalledLocalIdentity({ ...options, nativeDatabase: b.native })).rejects.toThrow('owner mismatch');
    await expect(createInstalledLocalIdentity({ ...options, database: b.core })).rejects.toThrow('owner mismatch');
    expect(hashes).toBe(0);
    await expect(createPrototypeLocalIdentity({ database: a.core, admission: { scope: 'isolated-prototype-only' }, hasher, policy: POLICY })).rejects.toThrow('inspected');
  });
  it('requires exact fixed authentication DDL even when a different full schema is internally reviewed', async () => {
    const ddl = PROTOTYPE_IDENTITY_STATEMENTS.map(sql => sql.startsWith('CREATE TABLE local_accounts') ? sql.replace('created_at INTEGER', 'unreviewed_auth_field TEXT, created_at INTEGER') : sql);
    const f = await fixture(ddl);
    await expect(createInstalledLocalIdentity({ database: f.core, nativeDatabase: f.native, admission: f.admission, hasher: f.hasher, policy: POLICY })).rejects.toThrow('identity catalog');
    expect((await f.core.prepare('SELECT COUNT(*) n FROM local_accounts').first())?.n).toBe(0n);
  });
  it('refuses stale schema, changed ledger and changed physical installation identity after token issuance', async () => {
    const f = await fixture(); const options = { database: f.core, nativeDatabase: f.native, admission: f.admission, hasher: f.hasher, policy: POLICY };
    f.native.exec('CREATE TABLE sqliteX_extra(id TEXT)');
    await expect(createInstalledLocalIdentity(options)).rejects.toThrow('schema_checkpoint');
    f.native.exec('DROP TABLE sqliteX_extra');
    const prior = f.native.prepare('SELECT raw_sha256 FROM node_migrations').get()?.raw_sha256;
    f.native.prepare('UPDATE node_migrations SET raw_sha256=?').run('0'.repeat(64));
    await expect(createInstalledLocalIdentity(options)).rejects.toThrow('ledger_mismatch');
    f.native.prepare('UPDATE node_migrations SET raw_sha256=?').run(prior as string);
    f.native.prepare('UPDATE node_installation SET installation_id=?').run('11111111-1111-4111-8111-111111111111');
    await expect(createInstalledLocalIdentity(options)).rejects.toThrow('identity_or_checkpoint_changed');
  });
  it('checks ownership again after the asynchronous constructor KDF before exposing any identity writer', async () => {
    const f = await fixture(); let started!: () => void, release!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; }), allowReturn = new Promise<void>(resolve => { release = resolve; });
    const hasher: PasswordHasher = { limits: f.hasher.limits, async hash(p) { const result = await f.hasher.hash(p); started(); await allowReturn; return result; }, verify: (p,v) => f.hasher.verify(p,v) };
    const pending = createInstalledLocalIdentity({ database: f.core, nativeDatabase: f.native, admission: f.admission, hasher, policy: POLICY });
    await didStart; f.native.prepare('UPDATE node_installation SET installation_id=?').run('11111111-1111-4111-8111-111111111111'); release();
    await expect(pending).rejects.toThrow('identity_or_checkpoint_changed');
    expect((await f.core.prepare('SELECT COUNT(*) n FROM local_accounts').first())?.n).toBe(0n);
    expect((await f.core.prepare('SELECT COUNT(*) n FROM local_auth_events').first())?.n).toBe(0n);
  });
  it('captures one immutable database/native/admission tuple across constructor KDF despite caller options mutation', async () => {
    const a = await fixture(), b = await fixture(); let started!: () => void, release!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; }), allowReturn = new Promise<void>(resolve => { release = resolve; });
    const hasher: PasswordHasher = { limits: a.hasher.limits, async hash(p) { const result = await a.hasher.hash(p); started(); await allowReturn; return result; }, verify: (p,v) => a.hasher.verify(p,v) };
    const options = { database: a.core, nativeDatabase: a.native, admission: a.admission, hasher, policy: POLICY };
    const pending = createInstalledLocalIdentity(options); await didStart;
    a.native.prepare('UPDATE node_installation SET installation_id=?').run('11111111-1111-4111-8111-111111111111');
    Object.assign(options, { database: b.core, nativeDatabase: b.native, admission: b.admission }); release();
    await expect(pending).rejects.toThrow('identity_or_checkpoint_changed');
    expect((await a.core.prepare('SELECT COUNT(*) n FROM local_accounts').first())?.n).toBe(0n);
    expect((await b.core.prepare('SELECT COUNT(*) n FROM local_accounts').first())?.n).toBe(0n);
  });
  it('reopens a populated identified installation and obtains a new genuine admission without resetting principal or sessions', async () => {
    const f = await fixture();
    const service = await createInstalledLocalIdentity({ database: f.core, nativeDatabase: f.native, admission: f.admission, hasher: f.hasher, policy: POLICY });
    const actor = await service.offline({ assertHeld() {} }).bootstrap({ username: 'operator', password: 'persisted password', now: 100 });
    const session = await service.login({ username: 'operator', password: 'persisted password', sourceKey: 'trusted:loopback', now: 200 });
    f.core.close(); cores.splice(cores.indexOf(f.core),1);
    const native = new DatabaseSync(f.path, { allowExtension: false }), core = createSqliteCapability(native); cores.push(core);
    const receipt = installReviewedSqliteCatalog(native, f.catalog), admission = admitInstallationRecoverySource(native,f.catalog);
    const reopened = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission, hasher: f.hasher, policy: POLICY });
    expect(receipt.installationId).toBe(f.receipt.installationId); expect(await reopened.authenticate(session.token, 300)).toEqual(actor);
    await expect(reopened.offline({ assertHeld() {} }).bootstrap({ username: 'other', password: 'password', now: 400 })).rejects.toMatchObject({ code: 'bootstrap_unavailable' });
  });
});

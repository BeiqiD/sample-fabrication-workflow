import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrivateStorageKeyringLoader, MAX_PRIVATE_KEYRING_BYTES } from './storage-keyring-file';
import { decryptStorageCredential, encryptStorageCredential, StorageCredentialUnavailableError } from '../../worker/storage/credential-envelope';
const closeFault = vi.hoisted(() => ({ enabled: false, closed: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (closeFault.enabled) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closeFault.closed = true; throw new Error('Synthetic private path close failure'); };
    }
    return handle;
  } };
});
const paths: string[] = [];
afterEach(async () => { closeFault.enabled = false; closeFault.closed = false; vi.restoreAllMocks(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
const identity = { profileId: 'fixture-profile', configurationRevision: 1, credentialRef: 'fixture-credential', namespaceSha256: 'a'.repeat(64) };
// The test composer explicitly configures this actual fixture filesystem root;
// production does not discover or automatically trust an observed owner UID.
const fixtureFilesystemRootOwnerUid = Number((await lstat('/', { bigint: true })).uid);
const fixtureLoader = (path: string) => createPrivateStorageKeyringLoader(path, { filesystemRootOwnerUid: fixtureFilesystemRootOwnerUid });
async function fixture() {
  const dir = await mkdtemp(join(process.cwd(), '.keyring-fixture-')); paths.push(dir);
  const path = join(dir, 'keys.json'), material = randomBytes(32).toString('base64');
  const raw = JSON.stringify({ version: 1, currentKeyId: 'old-key', keys: { 'old-key': material } });
  await writeFile(path, raw, { flag: 'wx', mode: 0o600 });
  return { dir, path, material, raw, loader: fixtureLoader(path) };
}
async function unavailable(loader: () => Promise<unknown>, forbidden: string[] = []) {
  try { await loader(); throw new Error('Expected unavailable keyring'); }
  catch (error) {
    expect(error).toBeInstanceOf(StorageCredentialUnavailableError);
    expect((error as Error).message).toBe('Storage credential encryption is unavailable.');
    for (const value of forbidden) expect((error as Error).message).not.toContain(value);
    expect((error as Error).cause).toBeUndefined();
  }
}

describe('private Node keyring file capability', () => {
  it('loads an actual private owned file into non-extractable existing AES-GCM keys without rewriting bytes', async () => {
    const f = await fixture(), before = await readFile(f.path), keyring = await f.loader();
    expect(keyring.currentKeyId).toBe('old-key'); expect(keyring.keys.get('old-key')?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', keyring.keys.get('old-key')!)).rejects.toThrow();
    const sealed = await encryptStorageCredential(keyring, identity, 'synthetic provider material');
    expect(await decryptStorageCredential(keyring, identity, sealed)).toEqual({ outcome: 'available', plaintext: 'synthetic provider material' });
    expect(await readFile(f.path)).toEqual(before); expect((await lstat(f.path)).nlink).toBe(1);
  });
  it('supports a provisioned read-only0400 secret file and rejects permissive/executable/special modes', async () => {
    const f = await fixture(); await chmod(f.path, 0o400); expect((await f.loader()).currentKeyId).toBe('old-key');
    for (const mode of [0o640, 0o644, 0o700, 0o4600]) { await chmod(f.path,mode); await unavailable(f.loader, [f.path,f.material]); }
  });
  it('pins only the exact filesystem root owner with default UID0 and captures bounded deployment options', async () => {
    const f = await fixture();
    const options = { filesystemRootOwnerUid: fixtureFilesystemRootOwnerUid };
    const pinned = createPrivateStorageKeyringLoader(f.path, options);
    options.filesystemRootOwnerUid = fixtureFilesystemRootOwnerUid === 0 ? 1 : 0;
    expect((await pinned()).currentKeyId).toBe('old-key');
    await unavailable(createPrivateStorageKeyringLoader(f.path, options));
    if (fixtureFilesystemRootOwnerUid === 0) expect((await createPrivateStorageKeyringLoader(f.path)()).currentKeyId).toBe('old-key');
    else await unavailable(createPrivateStorageKeyringLoader(f.path));
    for (const filesystemRootOwnerUid of [-1, 0x1_0000_0000, Number.NaN, Number.POSITIVE_INFINITY, 0.5, null as unknown as number]) {
      expect(() => createPrivateStorageKeyringLoader(f.path, { filesystemRootOwnerUid })).toThrow(StorageCredentialUnavailableError);
    }
  });
  it('refuses relative, noncanonical, symlink and multi-link names while preserving the original file', async () => {
    const f = await fixture();
    await unavailable(fixtureLoader('keys.json'));
    await unavailable(fixtureLoader(join(f.dir,'nested') + '/../keys.json'));
    const alias = join(f.dir,'alias.json'); await symlink(f.path, alias);
    await unavailable(fixtureLoader(alias), [alias,f.material]);
    const duplicate = join(f.dir,'linked.json'); await link(f.path, duplicate);
    await unavailable(f.loader); await unavailable(fixtureLoader(duplicate));
    await unlink(duplicate); expect((await f.loader()).currentKeyId).toBe('old-key');
    expect(await readFile(f.path,'utf8')).toBe(f.raw);
  });
  it('requires canonical non-writable ancestors and rejects a symlinked ancestor', async () => {
    const f = await fixture(); await chmod(f.dir, 0o777); await unavailable(f.loader);
    await chmod(f.dir, 0o700); expect((await f.loader()).currentKeyId).toBe('old-key');
    const alias = join(process.cwd(), `.keyring-alias-${randomBytes(8).toString('hex')}`); paths.push(alias);
    await symlink(f.dir,alias); await unavailable(fixtureLoader(join(alias,'keys.json')));
  });
  it('fails missing, non-regular, oversized and malformed UTF-8/JSON secrets closed with no generated replacement', async () => {
    const f = await fixture(), missing = join(f.dir,'absent.json');
    await unavailable(fixtureLoader(missing)); await expect(lstat(missing)).rejects.toThrow();
    const directory = join(f.dir,'directory'); await mkdir(directory,{mode:0o700}); await unavailable(fixtureLoader(directory));
    for (const raw of [Buffer.alloc(MAX_PRIVATE_KEYRING_BYTES+1,65), Buffer.from([0xff,0xfe]), Buffer.from('{broken'), Buffer.alloc(0)]) {
      await writeFile(f.path, raw); await unavailable(f.loader, [f.path]); expect(await readFile(f.path)).toEqual(raw);
    }
  });
  it('does not reuse a cached successful ring after its file becomes missing or invalid', async () => {
    const f = await fixture(); const old = await f.loader(); expect(old.keys.size).toBe(1);
    await writeFile(f.path,'{invalid'); await unavailable(f.loader); await unlink(f.path); await unavailable(f.loader);
    await writeFile(f.path,f.raw,{mode:0o600}); expect((await f.loader()).currentKeyId).toBe('old-key');
  });
  it('reopens provisioned rotation retaining old keys, decrypts historical envelopes and enforces existing AAD', async () => {
    const f = await fixture(), old = await f.loader(), historical = await encryptStorageCredential(old,identity,'old synthetic value');
    const nextMaterial = randomBytes(32).toString('base64'), temporary = join(f.dir,'next.json');
    await writeFile(temporary, JSON.stringify({ version:1,currentKeyId:'new-key',keys:{'old-key':f.material,'new-key':nextMaterial} }), { mode:0o600,flag:'wx' });
    await rename(temporary,f.path);
    const restarted = await fixtureLoader(f.path)();
    expect(restarted.currentKeyId).toBe('new-key'); expect(restarted.keys.size).toBe(2);
    expect(await decryptStorageCredential(restarted,identity,historical)).toEqual({ outcome:'available',plaintext:'old synthetic value' });
    const newEnvelope = await encryptStorageCredential(restarted,identity,'new synthetic value'); expect(newEnvelope.keyId).toBe('new-key');
    expect(await decryptStorageCredential(restarted,{...identity,namespaceSha256:'b'.repeat(64)},historical)).toEqual({outcome:'unavailable'});
    expect(await decryptStorageCredential(restarted,identity,newEnvelope)).toEqual({outcome:'available',plaintext:'new synthetic value'});
  });
  it('keeps ciphertext unchanged when provisioned material is wrong or an old retained key is absent', async () => {
    const f = await fixture(), ring = await f.loader(), stored = await encryptStorageCredential(ring,identity,'synthetic secret'), before = JSON.stringify(stored);
    await writeFile(f.path,JSON.stringify({version:1,currentKeyId:'old-key',keys:{'old-key':randomBytes(32).toString('base64')}}));
    expect(await decryptStorageCredential(await f.loader(),identity,stored)).toEqual({outcome:'unavailable'});
    await writeFile(f.path,JSON.stringify({version:1,currentKeyId:'new-key',keys:{'new-key':randomBytes(32).toString('base64')}}));
    expect(await decryptStorageCredential(await f.loader(),identity,stored)).toEqual({outcome:'unavailable'});
    expect(JSON.stringify(stored)).toBe(before);
  });
  it('rejects an actual file mutation while the real asynchronous key import is completing', async () => {
    const f = await fixture(), realImport = crypto.subtle.importKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle,'importKey').mockImplementation(async (...args) => {
      const key = await realImport(...args);
      await writeFile(f.path,JSON.stringify({version:1,currentKeyId:'changed-key',keys:{'changed-key':randomBytes(32).toString('base64')}}));
      return key;
    });
    await unavailable(f.loader,[f.path,f.material]);
  });
  it('does not return imported keys when an actual file handle reports a redacted close failure', async () => {
    const f = await fixture(); closeFault.enabled = true;
    await unavailable(f.loader, [f.path, f.material, 'Synthetic private path close failure']);
    expect(closeFault.closed).toBe(true);
    closeFault.enabled = false;
    expect((await f.loader()).currentKeyId).toBe('old-key');
  });
});

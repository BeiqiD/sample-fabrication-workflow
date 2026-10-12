import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalLocalVolumeNamespace, checkedLocalVolumeNamespace, type LocalVolumeNamespace } from '../shared/contracts/local-volume-profile.ts';
import { createLoopbackLocalAuthTransport } from './auth/local-auth-transport.ts';

export class NodeRuntimeConfigurationError extends Error {
  constructor() { super('Local runtime configuration is unavailable.'); this.name = 'NodeRuntimeConfigurationError'; }
}
export interface LoadedNodeRuntimeConfiguration {
  readonly kind: 'loaded-node-loopback-development/1';
}
/** Deployment-owned metadata only. Physical marker/inode capture, installation
 * binding and File authority belong to the genuine local volume owner. */
export interface NodeConfiguredLocalVolumeDescriptor {
  readonly id: string;
  readonly root: string;
  readonly rootBindingId: string;
  readonly namespace: Readonly<LocalVolumeNamespace>;
}
export interface NodeRuntimeConfiguration {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly expectedInstallationId: string;
  readonly publicOrigin: string;
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
  readonly clientDirectory: string;
  readonly storageKeyringPath?: string;
  readonly localVolumes: readonly Readonly<NodeConfiguredLocalVolumeDescriptor>[];
  /** Explicit host opt-in only; existing current profile/role/File authority is still required. */
  readonly enableLocalFile: boolean;
  /** Explicit independent Job host opt-in; never enables or resumes persisted work. */
  readonly enableLocalJobs: boolean;
  readonly filesystemRootOwnerUid: number;
}
interface Identity { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: bigint }
interface FileIdentity extends Identity { nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
interface DirectoryPin { path: string; identity: Identity; private: boolean }
const MAX_CONFIGURATION_BYTES = 16 * 1024;
const MAX_LOCAL_VOLUMES = 32;
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const issued = new WeakMap<LoadedNodeRuntimeConfiguration, {
  value: Readonly<NodeRuntimeConfiguration>; path: string; owner: bigint; file: FileIdentity; directories: DirectoryPin[];
}>();
function unavailable(): never { throw new NodeRuntimeConfigurationError(); }
function identity(stat: BigIntStats): Identity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode };
}
function fileIdentity(stat: BigIntStats): FileIdentity {
  return { ...identity(stat), nlink: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}
function same(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return same(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function canonical(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || path.length > 4000 || path.includes('\0')
    || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) unavailable();
}
function privateConfiguration(stat: BigIntStats, owner: bigint): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== owner || stat.nlink !== 1n
    || ![0o400n, 0o600n].includes(stat.mode & 0o7777n)
    || stat.size < 1n || stat.size > BigInt(MAX_CONFIGURATION_BYTES)) unavailable();
}
function directory(path: string, owner: bigint, rootOwner: bigint, isPrivate: boolean): Identity {
  canonical(path); const stat = lstatSync(path, { bigint: true });
  const atRoot = dirname(path) === path;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n
    || (atRoot ? stat.uid !== rootOwner : stat.uid !== owner && stat.uid !== 0n)
    || isPrivate && (stat.uid !== owner || (stat.mode & 0o7777n) !== 0o700n)) unavailable();
  return identity(stat);
}
function ancestors(path: string, owner: bigint, rootOwner: bigint): DirectoryPin[] {
  const pins: DirectoryPin[] = []; let current = dirname(path);
  while (true) {
    pins.push({ path: current, identity: directory(current, owner, rootOwner, false), private: false });
    const parent = dirname(current); if (parent === current) return pins; current = parent;
  }
}
function exactKeys(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = ['format', 'dataDirectory', 'expectedInstallationId', 'publicOrigin', 'clientDirectory'];
  const names = Object.keys(value);
  return fields.every(name => names.includes(name)) && names.every(name => fields.includes(name)
    || name === 'storageKeyringPath' || name === 'localVolumes' || name === 'enableLocalFile' || name === 'enableLocalJobs');
}

function overlaps(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');
  return inside(a, b) || inside(b, a);
}
function exactVolumeDescriptor(value: unknown): value is Record<string, unknown> {
  const fields = ['id', 'root', 'rootBindingId', 'namespace'];
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)));
}
function configuredLocalVolumes(raw: unknown, owner: bigint, rootOwner: bigint,
  protectedPaths: readonly string[], directories: DirectoryPin[]): readonly Readonly<NodeConfiguredLocalVolumeDescriptor>[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.length > MAX_LOCAL_VOLUMES) unavailable();
  const ids = new Set<string>(), bindings = new Set<string>(), namespaces = new Set<string>(), roots: string[] = [];
  const descriptors = raw.map((item: unknown) => {
    if (!exactVolumeDescriptor(item)) unavailable();
    const id = item.id, rootBindingId = item.rootBindingId, root = item.root;
    if (typeof id !== 'string' || !INSTALLATION_ID.test(id)
      || typeof rootBindingId !== 'string' || !INSTALLATION_ID.test(rootBindingId)) unavailable();
    canonical(root);
    const namespace = checkedLocalVolumeNamespace(item.namespace), identity = canonicalLocalVolumeNamespace(namespace);
    if (ids.has(id) || bindings.has(rootBindingId) || namespaces.has(identity)
      || roots.some(other => overlaps(root, other)) || protectedPaths.some(path => overlaps(root, path))) unavailable();
    const pin = { path: root, identity: directory(root, owner, rootOwner, true), private: true };
    directories.push(pin, ...ancestors(root, owner, rootOwner));
    ids.add(id); bindings.add(rootBindingId); namespaces.add(identity); roots.push(root);
    return Object.freeze({ id, root, rootBindingId, namespace });
  });
  return Object.freeze(descriptors);
}

/** An explicit deployment pin is captured before private config I/O. The file
 * contains only nonsecret binding metadata; no credential or bootstrap fields
 * are admitted. The config does not provision or repair either volume. */
export function loadNodeRuntimeConfiguration(path: string, options: { filesystemRootOwnerUid?: number } = {}): LoadedNodeRuntimeConfiguration {
  let descriptor: number | undefined;
  const bytes = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1);
  try {
    const suppliedRoot = options?.filesystemRootOwnerUid;
    const configuredRoot = suppliedRoot === undefined ? 0 : suppliedRoot;
    if (process.platform !== 'linux' || typeof process.geteuid !== 'function' || !options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'filesystemRootOwnerUid')
      || !Number.isSafeInteger(configuredRoot) || configuredRoot < 0 || configuredRoot > 0xffff_ffff) unavailable();
    const owner = BigInt(process.geteuid()), rootOwner = BigInt(configuredRoot);
    canonical(path); const before = lstatSync(path, { bigint: true }); privateConfiguration(before, owner);
    const directories = ancestors(path, owner, rootOwner);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true }); privateConfiguration(opened, owner);
    if (!sameFile(fileIdentity(before), fileIdentity(opened))) unavailable();
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (!count) break; length += count;
    }
    if (length < 1 || length > MAX_CONFIGURATION_BYTES || BigInt(length) !== opened.size) unavailable();
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
    if (!exactKeys(raw) || raw.format !== 'node-loopback-development-v1' || typeof raw.expectedInstallationId !== 'string'
      || !INSTALLATION_ID.test(raw.expectedInstallationId) || typeof raw.publicOrigin !== 'string') unavailable();
    canonical(raw.dataDirectory); canonical(raw.clientDirectory);
    if (raw.storageKeyringPath !== undefined && (typeof raw.storageKeyringPath !== 'string' || !raw.storageKeyringPath
      || raw.storageKeyringPath.length > 4000 || raw.storageKeyringPath.includes('\0')
      || !isAbsolute(raw.storageKeyringPath) || resolve(raw.storageKeyringPath) !== raw.storageKeyringPath)) unavailable();
    const origin = new URL(raw.publicOrigin);
    createLoopbackLocalAuthTransport({ publicOrigin: raw.publicOrigin });
    const port = Number(origin.port || '80');
    if (origin.origin !== raw.publicOrigin || !Number.isInteger(port) || port < 1024 || port > 65535) unavailable();
    const data = { path: raw.dataDirectory, identity: directory(raw.dataDirectory, owner, rootOwner, true), private: true };
    const client = { path: raw.clientDirectory, identity: directory(raw.clientDirectory, owner, rootOwner, false), private: false };
    directories.push(data, ...ancestors(raw.dataDirectory, owner, rootOwner), client, ...ancestors(raw.clientDirectory, owner, rootOwner));
    const localVolumes = configuredLocalVolumes(raw.localVolumes, owner, rootOwner,
      [path, raw.dataDirectory, raw.clientDirectory, ...(raw.storageKeyringPath === undefined ? [] : [raw.storageKeyringPath])], directories);
    if (raw.enableLocalFile !== undefined && typeof raw.enableLocalFile !== 'boolean'
      || raw.enableLocalFile === true && localVolumes.length === 0) unavailable();
    if (raw.enableLocalJobs !== undefined && typeof raw.enableLocalJobs !== 'boolean'
      || raw.enableLocalJobs === true && raw.enableLocalFile !== true) unavailable();
    const after = fstatSync(descriptor, { bigint: true }), afterPath = lstatSync(path, { bigint: true });
    privateConfiguration(after, owner); privateConfiguration(afterPath, owner);
    if (!sameFile(fileIdentity(opened), fileIdentity(after)) || !sameFile(fileIdentity(opened), fileIdentity(afterPath))) unavailable();
    const value = Object.freeze({ dataDirectory: raw.dataDirectory, databasePath: join(raw.dataDirectory, 'application.sqlite'),
      expectedInstallationId: raw.expectedInstallationId, publicOrigin: raw.publicOrigin,
      host: origin.hostname === '[::1]' ? '::1' as const : '127.0.0.1' as const, port,
      clientDirectory: raw.clientDirectory, ...(raw.storageKeyringPath === undefined ? {} : { storageKeyringPath: raw.storageKeyringPath }),
      localVolumes, enableLocalFile: raw.enableLocalFile === true, enableLocalJobs: raw.enableLocalJobs === true,
      filesystemRootOwnerUid: configuredRoot });
    const token = Object.freeze({ kind: 'loaded-node-loopback-development/1' as const });
    issued.set(token, { value, path, owner, file: fileIdentity(opened), directories });
    assertNodeRuntimeConfiguration(token); return token;
  } catch { return unavailable(); }
  finally { bytes.fill(0); if (descriptor !== undefined) { try { closeSync(descriptor); } catch { unavailable(); } } }
}

/** Only a factory-issued immutable config is accepted, with actual path/inode/
 * owner/mode rechecks during startup. Updating config requires a new load and
 * new runtime; it cannot mutate a running captured policy. */
export function assertNodeRuntimeConfiguration(token: LoadedNodeRuntimeConfiguration): Readonly<NodeRuntimeConfiguration> {
  try {
    const current = issued.get(token); if (!current) unavailable();
    canonical(current.path); const file = lstatSync(current.path, { bigint: true }); privateConfiguration(file, current.owner);
    if (!sameFile(current.file, fileIdentity(file))) unavailable();
    const rootOwner = BigInt(current.value.filesystemRootOwnerUid);
    for (const pin of current.directories) if (!same(pin.identity, directory(pin.path, current.owner, rootOwner, pin.private))) unavailable();
    return current.value;
  } catch { return unavailable(); }
}

import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalLocalVolumeNamespace, checkedLocalVolumeNamespace, type LocalVolumeNamespace } from "../../shared/contracts/local-volume-profile.ts";
import type { LocalByteBinding } from "./local-byte-storage";

/** Installation configuration only. A descriptor is not a binding/admission. */
export interface TrustedLocalVolumeDescriptor {
  readonly id: string;
  readonly root: string;
  readonly rootBindingId: string;
  readonly namespace: Readonly<LocalVolumeNamespace>;
}
export interface CapturedLocalVolumeDescriptor extends TrustedLocalVolumeDescriptor {
  readonly profileId: string;
  readonly namespaceIdentity: string;
  readonly namespaceSha256: string;
  readonly bindingFingerprintSha256: string;
  readonly bytes: Readonly<LocalByteBinding>;
  assertCurrent(): void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function unavailable(): never { throw new Error("Local volume descriptor is unavailable"); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function identity(stat: BigIntStats) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), uid: stat.uid.toString(), gid: stat.gid.toString(), mode: stat.mode.toString() };
}
function privateDirectory(path: string, uid: bigint): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n
    || realpathSync(path) !== path) unavailable();
  return stat;
}
/** Pin real filesystem observations, including marker identity/content and every
 * traversed ancestor. No caller-supplied digest or JSON binding is authority. */
export function captureLocalVolumeDescriptor(raw: unknown, filesystemRootOwnerUid: number): Readonly<CapturedLocalVolumeDescriptor> {
  if (!exact(raw, ["id", "root", "rootBindingId", "namespace"]) || typeof process.geteuid !== "function"
    || !Number.isSafeInteger(filesystemRootOwnerUid) || filesystemRootOwnerUid < 0 || filesystemRootOwnerUid > 0xffff_ffff) unavailable();
  const id = raw.id, rawRoot = raw.root, rootBindingId = raw.rootBindingId, namespace = checkedLocalVolumeNamespace(raw.namespace);
  if (typeof id !== "string" || !UUID.test(id) || typeof rootBindingId !== "string" || !UUID.test(rootBindingId)
    || typeof rawRoot !== "string" || !rawRoot || rawRoot.includes("\0") || rawRoot.length > 4000 || !isAbsolute(rawRoot)
    || resolve(rawRoot) !== rawRoot || realpathSync(rawRoot) !== rawRoot) unavailable();
  const root = rawRoot;
  const namespaceIdentity = canonicalLocalVolumeNamespace(namespace), namespaceSha256 = digest(namespaceIdentity);
  const profileId = `storage-profile:local:${namespaceSha256}`, uid = BigInt(process.geteuid());
  const bytes = Object.freeze({ root, namespace: Object.freeze({ volumeId: namespace.volumeId, rootId: namespace.rootId,
    profileId, namespaceRevision: 1 }) });
  function observe(): Readonly<{ bindingFingerprintSha256: string; lifetimeFingerprintSha256: string }> {
    const directories = [root, join(root, "objects"), join(root, "staging")].map(path => ({ path, ...identity(privateDirectory(path, uid)) }));
    const ancestors: unknown[] = [];
    for (let path = dirname(root);;) {
      const stat = lstatSync(path, { bigint: true }), parent = dirname(path), atRoot = path === parent;
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n || realpathSync(path) !== path
        || (atRoot ? stat.uid !== BigInt(filesystemRootOwnerUid) : stat.uid !== uid && stat.uid !== 0n)) unavailable();
      ancestors.push({ path, ...identity(stat) });
      if (atRoot) break;
      path = parent;
    }
    const path = join(root, "namespace.json"), before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1n
      || (before.mode & 0o7777n) !== 0o600n || before.size > 16_384n || realpathSync(path) !== path) unavailable();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(fd, { bigint: true });
      if (JSON.stringify(identity(current)) !== JSON.stringify(identity(before)) || current.nlink !== 1n || current.size !== before.size) unavailable();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
      if (Buffer.byteLength(text, "utf8") !== Number(before.size)) unavailable();
      const marker: unknown = JSON.parse(text);
      if (!exact(marker, ["format", "namespace"]) || marker.format !== "local-byte-namespace-v1"
        || !exact(marker.namespace, ["volumeId", "rootId", "profileId", "namespaceRevision"])
        || marker.namespace.volumeId !== namespace.volumeId || marker.namespace.rootId !== namespace.rootId
        || marker.namespace.profileId !== profileId || marker.namespace.namespaceRevision !== 1) unavailable();
      // Persist only the actual configured provider namespace/root/marker.
      // Container ancestors can change between genuine openings of the same
      // bind-mounted volume; they are safety-checked and pinned for THIS
      // opening below, never substituted for provider identity in SQL history.
      const bindingFingerprintSha256 = digest(JSON.stringify({ format: "local-volume-binding/2", descriptorId: id, rootBindingId,
        namespaceIdentity, directories, marker: { path, ...identity(current) } }));
      const lifetimeFingerprintSha256 = digest(JSON.stringify({ format: "local-volume-opening/1",
        bindingFingerprintSha256, ancestors }));
      return Object.freeze({ bindingFingerprintSha256, lifetimeFingerprintSha256 });
    } finally { closeSync(fd); }
  }
  const captured = observe();
  return Object.freeze({ id, root, rootBindingId, namespace, profileId, namespaceIdentity, namespaceSha256,
    bindingFingerprintSha256: captured.bindingFingerprintSha256, bytes, assertCurrent() {
      const current = observe();
      if (current.bindingFingerprintSha256 !== captured.bindingFingerprintSha256
        || current.lifetimeFingerprintSha256 !== captured.lifetimeFingerprintSha256) unavailable();
    } });
}

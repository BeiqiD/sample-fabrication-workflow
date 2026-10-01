/** Administrator-only candidate metadata. Saving never tests or activates a
 * provider, changes a role default, or returns stored credential material. */
export const MAX_STORAGE_CANDIDATES = 100;
export const MAX_STORAGE_CONFIGURATION_INPUT_BYTES = 48 * 1024;
export interface S3StorageNamespace {
  kind: "s3";
  endpoint: string;
  bucket: string;
  region: string;
  root: string;
  forcePathStyle: boolean;
}
export interface WebDavStorageNamespace { kind: "webdav" | "switchdrive"; endpoint: string; root: string }
export type ExternalStorageNamespace = S3StorageNamespace | WebDavStorageNamespace;
export interface S3StorageCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface WebDavStorageCredentials { username: string; password: string }
export interface SaveStorageCandidateInput {
  profileId?: string;
  expectedRevision: number | null;
  label: string;
  namespace: ExternalStorageNamespace;
  credentials: { mode: "replace"; value: S3StorageCredentials | WebDavStorageCredentials } | { mode: "retain" };
}
export interface StorageCandidate {
  profileId: string;
  revision: number;
  label: string;
  namespace: ExternalStorageNamespace;
  credentials: { status: "configured" | "unavailable"; ref: string };
  createdAt: string;
  createdBy: string;
}
export interface StorageConfigurationStatus {
  scope: "system";
  credentialEditingAvailable: boolean;
  candidates: { items: StorageCandidate[]; hasMore: boolean };
}
export class StorageConfigurationInputError extends Error {
  constructor() { super("Invalid storage configuration."); this.name = "StorageConfigurationInputError"; }
}
function invalid(): never { throw new StorageConfigurationInputError(); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !keys.includes(key) && !optional.includes(key))) invalid();
  return result;
}
function text(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || !allowEmpty && !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)
    || new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) !== value) invalid();
  return value;
}
function endpoint(value: unknown): string {
  const raw = text(value, 2048);
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  // Private-network destinations need an explicit later adapter policy. This
  // slice records metadata and performs no DNS lookup or provider request.
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.hostname.includes(".") || url.hostname.endsWith(".") || url.hostname.endsWith(".local")
    || url.hostname.endsWith(".localhost") || url.hostname.includes(":") || /^[\d.]+$/.test(url.hostname)) invalid();
  try { if (decodeURIComponent(url.pathname).split("/").some(part => part === "." || part === "..")) invalid(); }
  catch { return invalid(); }
  return url.href.replace(/\/+$/, "");
}
function root(value: unknown): string {
  const result = text(value, 1024, true);
  if (result.startsWith("/") || result.endsWith("/") || result.includes("\\")
    || result.split("/").some(part => part === "." || part === ".." || !part && result.length > 0)) invalid();
  return result;
}
export function checkedExternalStorageNamespace(value: unknown): ExternalStorageNamespace {
  const base = record(value, ["kind", "endpoint", "root"], ["bucket", "region", "forcePathStyle"]);
  if (base.kind === "s3") {
    const input = record(value, ["kind", "endpoint", "root", "bucket", "region", "forcePathStyle"]);
    const bucket = text(input.bucket, 63), region = text(input.region, 128);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[A-Za-z0-9_-]+$/.test(region) || typeof input.forcePathStyle !== "boolean") invalid();
    return { kind: "s3", endpoint: endpoint(input.endpoint), bucket, region, root: root(input.root), forcePathStyle: input.forcePathStyle };
  }
  if (base.kind !== "webdav" && base.kind !== "switchdrive") invalid();
  const input = record(value, ["kind", "endpoint", "root"]);
  return { kind: base.kind, endpoint: endpoint(input.endpoint), root: root(input.root) };
}
function checkedCredentials(value: unknown, kind: ExternalStorageNamespace["kind"]): S3StorageCredentials | WebDavStorageCredentials {
  if (kind === "s3") {
    const input = record(value, ["accessKeyId", "secretAccessKey"], ["sessionToken"]);
    const result: S3StorageCredentials = { accessKeyId: text(input.accessKeyId, 512), secretAccessKey: text(input.secretAccessKey, 8192) };
    if (Object.hasOwn(input, "sessionToken")) result.sessionToken = text(input.sessionToken, 8192);
    return result;
  }
  const input = record(value, ["username", "password"]);
  return { username: text(input.username, 512), password: text(input.password, 8192) };
}
export function checkedSaveStorageCandidateInput(value: unknown): SaveStorageCandidateInput {
  const input = record(value, ["expectedRevision", "label", "namespace", "credentials"], ["profileId"]);
  const namespace = checkedExternalStorageNamespace(input.namespace), label = text(input.label, 160).trim();
  if (!label || input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1)) invalid();
  const profileId = Object.hasOwn(input, "profileId") ? text(input.profileId, 256) : undefined;
  if (input.expectedRevision === null ? profileId !== undefined : profileId === undefined) invalid();
  const credentials = record(input.credentials, ["mode"], ["value"]);
  let checked: SaveStorageCandidateInput["credentials"];
  if (credentials.mode === "replace") checked = { mode: "replace", value: checkedCredentials(record(input.credentials, ["mode", "value"]).value, namespace.kind) };
  else if (credentials.mode === "retain" && input.expectedRevision !== null) { record(input.credentials, ["mode"]); checked = { mode: "retain" }; }
  else return invalid();
  const result: SaveStorageCandidateInput = { ...(profileId ? { profileId } : {}), expectedRevision: input.expectedRevision as number | null, label, namespace, credentials: checked };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_STORAGE_CONFIGURATION_INPUT_BYTES) invalid();
  return result;
}
export function checkedStorageConfigurationStatus(value: unknown): StorageConfigurationStatus {
  const input = record(value, ["scope", "credentialEditingAvailable", "candidates"]), candidates = record(input.candidates, ["items", "hasMore"]);
  if (input.scope !== "system" || typeof input.credentialEditingAvailable !== "boolean" || !Array.isArray(candidates.items)
    || candidates.items.length > MAX_STORAGE_CANDIDATES || typeof candidates.hasMore !== "boolean") invalid();
  const items = candidates.items.map((value): StorageCandidate => {
    const item = record(value, ["profileId", "revision", "label", "namespace", "credentials", "createdAt", "createdBy"]), credential = record(item.credentials, ["status", "ref"]);
    if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || !["configured", "unavailable"].includes(credential.status as string)) invalid();
    return { profileId: text(item.profileId, 256), revision: item.revision as number, label: text(item.label, 160), namespace: checkedExternalStorageNamespace(item.namespace),
      credentials: { status: credential.status as "configured" | "unavailable", ref: text(credential.ref, 256) }, createdAt: text(item.createdAt, 64), createdBy: text(item.createdBy, 254) };
  });
  if (new Set(items.map(item => item.profileId)).size !== items.length) invalid();
  return { scope: "system", credentialEditingAvailable: input.credentialEditingAvailable, candidates: { items, hasMore: candidates.hasMore } };
}

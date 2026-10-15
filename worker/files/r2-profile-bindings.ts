import type { Env } from "../types";

type BindingEnvironment = Pick<Env, "R2_BOOTSTRAP_NAMESPACE" | "R2_PROFILE_BINDINGS"> & Partial<Pick<Env, "ASSETS">>;
interface DeclaredBinding { namespaceIdentity: string; bindingName: string }
interface RegisteredProfile { id: string; configurationRevision: 1; namespaceIdentity: string }
export interface ResolvedR2ProfileBinding extends RegisteredProfile {
  bucket: R2Bucket;
  bindingName: string;
  rawMappings: string | undefined;
  bootstrapNamespace: string | undefined;
  allowLegacyBootstrap: boolean;
}

export class R2ProfileBindingUnavailableError extends Error {
  constructor() { super("R2 storage profile is unavailable"); this.name = "R2ProfileBindingUnavailableError"; }
}
const unavailable = (): never => { throw new R2ProfileBindingUnavailableError(); };
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const profileId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");

/** Physical deployment metadata, never a URL or an inferred binding identity. */
export function canonicalR2ProfileNamespace(raw: unknown): string {
  try {
    if (typeof raw !== "string" || raw.length > 2048) return unavailable();
    const value = JSON.parse(raw);
    if (typeof value?.bucketName !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value.bucketName)) return unavailable();
    let canonical: string;
    if (value.kind === "cloudflare-r2" && typeof value.accountId === "string" && /^[0-9a-f]{32}$/.test(value.accountId)) {
      canonical = JSON.stringify({ kind: value.kind, accountId: value.accountId, bucketName: value.bucketName });
    } else if (value.kind === "local-r2" && typeof value.installationId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.installationId)) {
      canonical = JSON.stringify({ kind: value.kind, installationId: value.installationId, bucketName: value.bucketName });
    } else return unavailable();
    if (canonical !== raw) return unavailable();
    return canonical;
  } catch { return unavailable(); }
}

function declarations(env: BindingEnvironment): Map<string, DeclaredBinding> {
  const result = new Map<string, DeclaredBinding>(), names = new Map<string, string>();
  const raw = env.R2_PROFILE_BINDINGS;
  if (raw === undefined) return result;
  try {
    if (typeof raw !== "string" || raw.length > 262144 || new TextEncoder().encode(raw).byteLength > 262144) return unavailable();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unavailable();
    const entries = Object.entries(parsed);
    if (entries.length > 100) return unavailable();
    for (const [id, value] of entries) {
      if (!profileId(id) || !value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "bindingName,namespaceIdentity"
        || typeof value.bindingName !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.bindingName)) return unavailable();
      const namespaceIdentity = canonicalR2ProfileNamespace(value.namespaceIdentity);
      if (value.bindingName === "ASSETS" && namespaceIdentity !== canonicalR2ProfileNamespace(env.R2_BOOTSTRAP_NAMESPACE)) return unavailable();
      if (names.has(value.bindingName) && names.get(value.bindingName) !== namespaceIdentity) return unavailable();
      names.set(value.bindingName, namespaceIdentity);
      result.set(id, { bindingName: value.bindingName, namespaceIdentity });
    }
    return result;
  } catch { return unavailable(); }
}

/** Metadata-only resolution keeps historical assertions independent of bucket
 * availability. An explicit declaration never falls back to bootstrap. */
export function r2ProfileNamespace(env: BindingEnvironment, id: string): string {
  if (!profileId(id)) return unavailable();
  return declarations(env).get(id)?.namespaceIdentity ?? canonicalR2ProfileNamespace(env.R2_BOOTSTRAP_NAMESPACE);
}

const bucketLike = (value: unknown): value is R2Bucket => Boolean(value && typeof value === "object"
  && ["get", "head", "put", "delete"].every(method => typeof (value as Record<string, unknown>)[method] === "function"));
const lookup = (env: BindingEnvironment, name: string): unknown => own(env, name) ? (env as unknown as Record<string, unknown>)[name] : undefined;

/** Resolve deployment-owned capabilities for an already registered identity.
 * The declaration is not proof of provider health or a bucket's cloud owner. */
export function resolveR2ProfileBinding(env: BindingEnvironment, profile: RegisteredProfile,
  options: { allowLegacyBootstrap?: boolean } = {}): ResolvedR2ProfileBinding {
  try {
    if (!profileId(profile?.id) || profile.configurationRevision !== 1) return unavailable();
    const declared = declarations(env), selected = declared.get(profile.id);
    const namespaceIdentity = selected?.namespaceIdentity ?? canonicalR2ProfileNamespace(env.R2_BOOTSTRAP_NAMESPACE);
    if (namespaceIdentity !== profile.namespaceIdentity) return unavailable();
    const bindingName = selected?.bindingName ?? "ASSETS", bucket = lookup(env, bindingName);
    // Existing ASSETS call sites admit the deployment binding before invoking
    // the particular reader/deleter method. Explicit mapped profiles and role
    // selections require the complete R2 capability surface instead.
    if (!bucketLike(bucket) && !(options.allowLegacyBootstrap && !selected && bucket && typeof bucket === "object")) return unavailable();
    const capabilities = new Map<object, string>();
    const bootstrap = lookup(env, "ASSETS");
    if (bootstrap && typeof bootstrap === "object") {
      let namespace: string | undefined;
      try { namespace = canonicalR2ProfileNamespace(env.R2_BOOTSTRAP_NAMESPACE); } catch { /* Independent mapped bindings may still be available. */ }
      if (namespace !== undefined) capabilities.set(bootstrap, namespace);
      else if (bootstrap === bucket) return unavailable();
    }
    for (const entry of declared.values()) {
      const object = lookup(env, entry.bindingName);
      if (!object || typeof object !== "object") continue;
      const prior = capabilities.get(object);
      if (prior !== undefined && prior !== entry.namespaceIdentity) return unavailable();
      capabilities.set(object, entry.namespaceIdentity);
    }
    return Object.freeze({ ...profile, namespaceIdentity, bindingName, bucket: bucket as R2Bucket,
      rawMappings: env.R2_PROFILE_BINDINGS, bootstrapNamespace: env.R2_BOOTSTRAP_NAMESPACE,
      allowLegacyBootstrap: Boolean(options.allowLegacyBootstrap) });
  } catch { return unavailable(); }
}

/** Re-resolve after the caller's fence; compare both the raw declaration and
 * exact capability object so edits cannot retarget a captured operation. */
export function r2ProfileBindingStillCurrent(env: BindingEnvironment, captured: ResolvedR2ProfileBinding): boolean {
  try {
    if (env.R2_PROFILE_BINDINGS !== captured.rawMappings || env.R2_BOOTSTRAP_NAMESPACE !== captured.bootstrapNamespace) return false;
    const current = resolveR2ProfileBinding(env, captured, { allowLegacyBootstrap: captured.allowLegacyBootstrap });
    return current.bucket === captured.bucket && current.bindingName === captured.bindingName;
  } catch { return false; }
}

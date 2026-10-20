/** Stable identity facts emitted only by the runtime's private, request-owned
 * authentication issuer. This structural value is NOT authentication, membership,
 * an administrator grant, a resource capability, or a mutation admission token. */
export interface RequestSubjectFacts {
  readonly provider: "access" | "local";
  readonly issuer: string;
  readonly subject: string;
}

/** Reject malformed/bounded identities rather than normalizing an opaque subject.
 * Existing login behavior is separate; unusable stable subjects emit no facts. */
export function canonicalIdentityText(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || !value.length || value.length > maximumBytes
    || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= maximumBytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value;
}

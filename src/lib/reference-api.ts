import type {
  ReferenceResolution,
  ReferenceTarget,
  ResolveReferencesResponse,
} from "../../shared/reference-types";

export async function resolveReference(
  target: ReferenceTarget,
  signal?: AbortSignal,
): Promise<ReferenceResolution> {
  const response = await fetch("/api/references/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targets: [target] }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(payload.error || `Reference resolution failed (${response.status})`);
  }

  const payload = await response.json() as ResolveReferencesResponse;
  const resolution = payload.results[0];
  if (!resolution) throw new Error("Reference resolution returned no result");
  return resolution;
}

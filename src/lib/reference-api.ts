import type {
  ListReferenceChildrenInput,
  ListReferenceChildrenResponse,
} from "../../shared/reference-children";
import type {
  SearchReferencesInput,
  SearchReferencesResponse,
} from "../../shared/reference-search";
import type {
  ReferenceResolution,
  ReferenceTarget,
  ResolveReferencesResponse,
} from "../../shared/reference-types";

async function parseReferenceResponse<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(payload.error || `${operation} failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

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
  const payload = await parseReferenceResponse<ResolveReferencesResponse>(
    response,
    "Reference resolution",
  );
  const resolution = payload.results[0];
  if (!resolution) throw new Error("Reference resolution returned no result");
  return resolution;
}

export async function searchReferences(
  input: SearchReferencesInput,
  signal?: AbortSignal,
): Promise<SearchReferencesResponse> {
  const response = await fetch("/api/references/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  return parseReferenceResponse<SearchReferencesResponse>(response, "Reference search");
}

export async function listReferenceChildren(
  input: ListReferenceChildrenInput,
  signal?: AbortSignal,
): Promise<ListReferenceChildrenResponse> {
  const response = await fetch("/api/references/children", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  return parseReferenceResponse<ListReferenceChildrenResponse>(
    response,
    "Reference child listing",
  );
}

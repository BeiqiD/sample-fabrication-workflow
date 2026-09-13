import type {
  ReferenceResolution,
  ReferenceTarget,
  ReferenceTargetType,
} from "./reference-types";

export const DEFAULT_REFERENCE_SEARCH_LIMIT = 30;
export const MAX_REFERENCE_SEARCH_LIMIT = 50;
export const MAX_REFERENCE_SEARCH_QUERY_LENGTH = 200;
export const MAX_REFERENCE_SEARCH_TOKENS = 8;
export const MAX_REFERENCE_SEARCH_RESOLUTION_CANDIDATES = 200;

export const REFERENCE_SEARCH_MATCH_TIERS = [
  "exact_id",
  "exact_primary",
  "prefix_primary",
  "content",
  "metadata",
] as const;

export type ReferenceSearchMatchTier = typeof REFERENCE_SEARCH_MATCH_TIERS[number];

export interface SearchReferencesInput {
  query: string;
  types?: ReferenceTargetType[];
  sampleId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
}

export interface NormalizedReferenceSearchInput {
  query: string;
  normalizedQuery: string;
  tokens: string[];
  types: ReferenceTargetType[];
  sampleId: string | null;
  from: string | null;
  to: string | null;
  limit: number;
}

export interface ReferenceSearchMatch {
  tier: ReferenceSearchMatchTier;
  matchedAt: string | null;
}

export interface ReferenceSearchResult {
  target: ReferenceTarget;
  match: ReferenceSearchMatch;
  resolution: ReferenceResolution;
}

export interface SearchReferencesResponse {
  query: string;
  results: ReferenceSearchResult[];
  truncated: boolean;
}

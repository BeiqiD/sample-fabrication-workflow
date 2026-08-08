import {
  DEFAULT_REFERENCE_SEARCH_LIMIT,
  MAX_REFERENCE_SEARCH_LIMIT,
  MAX_REFERENCE_SEARCH_QUERY_LENGTH,
  MAX_REFERENCE_SEARCH_RESOLUTION_CANDIDATES,
  type NormalizedReferenceSearchInput,
  type ReferenceSearchMatchTier,
  type ReferenceSearchResult,
  type SearchReferencesResponse,
} from "../../shared/reference-search";
import {
  REFERENCE_TARGET_TYPES,
  isReferenceTarget,
  isReferenceTargetType,
  type ReferenceResolution,
  type ReferenceTarget,
  type ReferenceTargetType,
} from "../../shared/reference-types";
import { searchTokens } from "../directory-query";
import { escapedLikePattern } from "../request-guards";
import { referenceTargetKey, resolveReferences } from "./resolver";

const SEARCH_CANDIDATE_FLOOR = 60;
const SEARCH_CANDIDATE_CEILING = 150;

const MATCH_TIER_BY_NUMBER: Record<number, ReferenceSearchMatchTier> = {
  0: "exact_id",
  1: "exact_primary",
  2: "prefix_primary",
  3: "content",
  4: "metadata",
};

const MATCH_TIER_ORDER: Record<ReferenceSearchMatchTier, number> = {
  exact_id: 0,
  exact_primary: 1,
  prefix_primary: 2,
  content: 3,
  metadata: 4,
};

const TARGET_TYPE_ORDER = new Map(
  REFERENCE_TARGET_TYPES.map((type, index) => [type, index]),
);

export class ReferenceSearchInputError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_query"
      | "invalid_types"
      | "invalid_sample"
      | "invalid_time_range"
      | "invalid_limit",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceSearchInputError";
  }
}

type CandidateRow = {
  target_id: string;
  match_tier: number;
  matched_at: string | null;
};

type SearchCandidate = {
  target: ReferenceTarget;
  tier: ReferenceSearchMatchTier;
  matchedAt: string | null;
};

type CandidateBatch = {
  candidates: SearchCandidate[];
  truncated: boolean;
};

type SampleFilter = {
  sql: string;
  bindings: unknown[];
};

type SearchSourceSpec = {
  type: ReferenceTargetType;
  fromSql: string;
  idSql: string;
  primarySqls: string[];
  contentSqls: string[];
  metadataSqls: string[];
  timestampSql: string;
  visibilitySql: string;
  visibilityBindings?: (input: NormalizedReferenceSearchInput) => unknown[];
  sampleFilter?: (sampleId: string) => SampleFilter;
};

export type ReferenceSearchAdapter = (
  db: D1Database,
  input: NormalizedReferenceSearchInput,
  candidateLimit: number,
) => Promise<CandidateBatch>;

function normalizeTimestamp(value: unknown, field: "from" | "to") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ReferenceSearchInputError(
      "invalid_time_range",
      `Reference search ${field} must be an ISO timestamp`,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ReferenceSearchInputError(
      "invalid_time_range",
      `Reference search ${field} must be an ISO timestamp`,
    );
  }
  return new Date(parsed).toISOString();
}

export function normalizeReferenceSearchInput(input: unknown): NormalizedReferenceSearchInput {
  if (!input || typeof input !== "object") {
    throw new ReferenceSearchInputError("invalid_input", "Reference search input is required");
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.query !== "string") {
    throw new ReferenceSearchInputError("invalid_query", "Reference search query is required");
  }
  const query = candidate.query.trim();
  if (!query || query.length > MAX_REFERENCE_SEARCH_QUERY_LENGTH) {
    throw new ReferenceSearchInputError(
      "invalid_query",
      `Reference search query must contain 1 to ${MAX_REFERENCE_SEARCH_QUERY_LENGTH} characters`,
    );
  }
  const tokens = searchTokens(query);
  if (!tokens.length) {
    throw new ReferenceSearchInputError("invalid_query", "Reference search query is required");
  }

  const requestedTypes = candidate.types;
  let types: ReferenceTargetType[];
  if (requestedTypes === undefined
    || (Array.isArray(requestedTypes) && requestedTypes.length === 0)) {
    types = [...REFERENCE_TARGET_TYPES];
  } else {
    if (!Array.isArray(requestedTypes) || !requestedTypes.every(isReferenceTargetType)) {
      throw new ReferenceSearchInputError("invalid_types", "Reference search contains an unknown target type");
    }
    const requested = new Set(requestedTypes as ReferenceTargetType[]);
    types = REFERENCE_TARGET_TYPES.filter((type) => requested.has(type));
  }

  const rawSampleId = candidate.sampleId;
  const sampleId = rawSampleId === undefined || rawSampleId === null ? null : rawSampleId;
  if (sampleId !== null
    && (typeof sampleId !== "string"
      || !isReferenceTarget({ type: "sample", id: sampleId })
      || sampleId.trim() !== sampleId)) {
    throw new ReferenceSearchInputError("invalid_sample", "Reference search Sample filter is invalid");
  }

  const from = normalizeTimestamp(candidate.from, "from");
  const to = normalizeTimestamp(candidate.to, "to");
  if (from && to && from > to) {
    throw new ReferenceSearchInputError(
      "invalid_time_range",
      "Reference search start time must not be after its end time",
    );
  }

  const limit = candidate.limit === undefined
    ? DEFAULT_REFERENCE_SEARCH_LIMIT
    : candidate.limit;
  if (typeof limit !== "number"
    || !Number.isInteger(limit)
    || limit < 1
    || limit > MAX_REFERENCE_SEARCH_LIMIT) {
    throw new ReferenceSearchInputError(
      "invalid_limit",
      `Reference search limit must be between 1 and ${MAX_REFERENCE_SEARCH_LIMIT}`,
    );
  }

  return {
    query,
    normalizedQuery: query.toLocaleLowerCase(),
    tokens,
    types,
    sampleId,
    from,
    to,
    limit,
  };
}

function prefixLikePattern(value: string) {
  const contains = escapedLikePattern(value);
  return `${contains.slice(1, -1)}%`;
}

function textExpression(expression: string) {
  return `COALESCE(CAST(${expression} AS TEXT), '')`;
}

function concatenate(expressions: string[]) {
  if (!expressions.length) return "''";
  return expressions.map(textExpression).join(" || ' ' || ");
}

function allTokensSql(haystack: string, tokenCount: number) {
  return Array.from(
    { length: tokenCount },
    () => `LOWER(${haystack}) LIKE ? ESCAPE '\\'`,
  ).join(" AND ");
}

function primaryExactSql(expressions: string[]) {
  if (!expressions.length) return "0";
  return expressions.map((expression) => (
    `LOWER(${textExpression(expression)}) = ?`
  )).join(" OR ");
}

function primaryPrefixSql(expressions: string[]) {
  if (!expressions.length) return "0";
  return expressions.map((expression) => (
    `LOWER(${textExpression(expression)}) LIKE ? ESCAPE '\\'`
  )).join(" OR ");
}

function makeSearchAdapter(spec: SearchSourceSpec): ReferenceSearchAdapter {
  return async (db, input, candidateLimit) => {
    if (input.sampleId && !spec.sampleFilter) return { candidates: [], truncated: false };

    const contentHaystack = concatenate(spec.contentSqls);
    const fullHaystack = concatenate([
      spec.idSql,
      ...spec.primarySqls,
      ...spec.contentSqls,
      ...spec.metadataSqls,
    ]);
    const exactPrimary = primaryExactSql(spec.primarySqls);
    const prefixPrimary = primaryPrefixSql(spec.primarySqls);
    const contentMatch = spec.contentSqls.length
      ? allTokensSql(contentHaystack, input.tokens.length)
      : "0";
    const fullMatch = allTokensSql(fullHaystack, input.tokens.length);
    const sampleFilter = input.sampleId && spec.sampleFilter
      ? spec.sampleFilter(input.sampleId)
      : null;
    const timeSql = [
      input.from ? `${spec.timestampSql} >= ?` : null,
      input.to ? `${spec.timestampSql} <= ?` : null,
    ].filter((value): value is string => Boolean(value));

    const sql = `
      SELECT CAST(${spec.idSql} AS TEXT) AS target_id,
             CASE
               WHEN LOWER(${textExpression(spec.idSql)}) = ? THEN 0
               WHEN (${exactPrimary}) THEN 1
               WHEN (${prefixPrimary}) THEN 2
               WHEN (${contentMatch}) THEN 3
               ELSE 4
             END AS match_tier,
             ${spec.timestampSql} AS matched_at
      ${spec.fromSql}
      WHERE (${spec.visibilitySql})
        AND (${fullMatch})
        ${sampleFilter ? `AND (${sampleFilter.sql})` : ""}
        ${timeSql.map((condition) => `AND (${condition})`).join("\n")}
      ORDER BY match_tier ASC,
               COALESCE(${spec.timestampSql}, '') DESC,
               target_id ASC
      LIMIT ?
    `;

    const containsBindings = input.tokens.map(escapedLikePattern);
    const bindings: unknown[] = [
      input.normalizedQuery,
      ...spec.primarySqls.map(() => input.normalizedQuery),
      ...spec.primarySqls.map(() => prefixLikePattern(input.normalizedQuery)),
      ...(spec.contentSqls.length ? containsBindings : []),
      ...(spec.visibilityBindings?.(input) ?? []),
      ...containsBindings,
      ...(sampleFilter?.bindings ?? []),
      ...(input.from ? [input.from] : []),
      ...(input.to ? [input.to] : []),
      candidateLimit + 1,
    ];

    const rows = await db.prepare(sql).bind(...bindings).all<CandidateRow>();
    const truncated = rows.results.length > candidateLimit;
    const candidates = rows.results.slice(0, candidateLimit).map((row): SearchCandidate => ({
      target: { type: spec.type, id: row.target_id },
      tier: MATCH_TIER_BY_NUMBER[Number(row.match_tier)] ?? "metadata",
      matchedAt: row.matched_at,
    }));
    return { candidates, truncated };
  };
}

const commentContextSql = `
  CASE
    WHEN cs.context_kind = 'sample' THEN COALESCE((
      SELECT COALESCE(s.id, '') || ' ' || COALESCE(s.code, '') || ' ' || COALESCE(s.title, '')
      FROM samples s
      WHERE s.id = cs.sample_id AND s.deleted_at IS NULL
    ), '')
    ELSE COALESCE((
      SELECT GROUP_CONCAT(
        COALESCE(s.id, '') || ' ' || COALESCE(s.code, '') || ' ' || COALESCE(s.title, '') || ' ' ||
        COALESCE(r.id, '') || ' ' || COALESCE(r.template_name_snapshot, '') || ' v' ||
        CAST(COALESCE(r.template_version_snapshot, 0) AS TEXT) || ' ' ||
        COALESCE(rs.id, '') || ' ' || COALESCE(rs.title, sd.name, ''),
        ' '
      )
      FROM comment_submission_targets cst
      JOIN samples s ON s.id = cst.sample_id AND s.deleted_at IS NULL
      JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id AND r.deleted_at IS NULL
      JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id AND rs.deleted_at IS NULL
      LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
      WHERE cst.submission_id = cs.id
    ), '')
  END
`;

const commentVisibilitySql = `
  cs.status = 'ready'
  AND cs.deleted_at IS NULL
  AND (
    (cs.context_kind = 'sample' AND EXISTS (
      SELECT 1 FROM samples s
      WHERE s.id = cs.sample_id AND s.deleted_at IS NULL
    ))
    OR
    (cs.context_kind = 'run_steps' AND EXISTS (
      SELECT 1
      FROM comment_submission_targets cst
      JOIN samples s ON s.id = cst.sample_id AND s.deleted_at IS NULL
      JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id AND r.deleted_at IS NULL
      JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id AND rs.deleted_at IS NULL
      WHERE cst.submission_id = cs.id
    ))
  )
`;

function commentSampleFilter(sampleId: string): SampleFilter {
  return {
    sql: `
      (cs.context_kind = 'sample' AND cs.sample_id = ?)
      OR
      (cs.context_kind = 'run_steps' AND EXISTS (
        SELECT 1
        FROM comment_submission_targets cst
        JOIN samples s ON s.id = cst.sample_id AND s.deleted_at IS NULL
        JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id AND r.deleted_at IS NULL
        JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id AND rs.deleted_at IS NULL
        WHERE cst.submission_id = cs.id AND cst.sample_id = ?
      ))
    `,
    bindings: [sampleId, sampleId],
  };
}

const attachmentContextSql = commentContextSql.replaceAll("cs.", "owner.");
const attachmentVisibilitySql = commentVisibilitySql.replaceAll("cs.", "owner.");

function attachmentSampleFilter(sampleId: string): SampleFilter {
  const filter = commentSampleFilter(sampleId);
  return {
    sql: filter.sql.replaceAll("cs.", "owner."),
    bindings: filter.bindings,
  };
}

export const REFERENCE_SEARCH_ADAPTERS = {
  sample: makeSearchAdapter({
    type: "sample",
    fromSql: "FROM samples s",
    idSql: "s.id",
    primarySqls: ["s.code", "s.title"],
    contentSqls: ["s.description"],
    metadataSqls: ["s.location", "s.status"],
    timestampSql: "s.updated_at",
    visibilitySql: "s.deleted_at IS NULL",
    sampleFilter: (sampleId) => ({ sql: "s.id = ?", bindings: [sampleId] }),
  }),
  run: makeSearchAdapter({
    type: "run",
    fromSql: `
      FROM runs r
      JOIN samples s ON s.id = r.sample_id
    `,
    idSql: "r.id",
    primarySqls: [
      "r.template_name_snapshot",
      "r.template_name_snapshot || ' v' || CAST(r.template_version_snapshot AS TEXT)",
    ],
    contentSqls: [],
    metadataSqls: [
      "r.run_kind",
      "r.status",
      "CAST(r.template_version_snapshot AS TEXT)",
      "s.id",
      "s.code",
      "s.title",
    ],
    timestampSql: "COALESCE(r.completed_at, r.created_at)",
    visibilitySql: "r.deleted_at IS NULL AND s.deleted_at IS NULL",
    sampleFilter: (sampleId) => ({ sql: "s.id = ?", bindings: [sampleId] }),
  }),
  run_step: makeSearchAdapter({
    type: "run_step",
    fromSql: `
      FROM run_steps rs
      LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
      JOIN runs r ON r.id = rs.run_id
      JOIN samples s ON s.id = r.sample_id
    `,
    idSql: "rs.id",
    primarySqls: ["COALESCE(rs.title, sd.name)"],
    contentSqls: [
      "rs.notes",
      "COALESCE(rs.parameters_text, sd.parameters_text)",
      "COALESCE(rs.comments_text, sd.comments_text)",
      "rs.deviation_note",
    ],
    metadataSqls: [
      "COALESCE(rs.tool_name, sd.tool_name)",
      "rs.entry_kind",
      "rs.status",
      "r.id",
      "r.template_name_snapshot",
      "CAST(r.template_version_snapshot AS TEXT)",
      "s.id",
      "s.code",
      "s.title",
    ],
    timestampSql: "rs.updated_at",
    visibilitySql: "rs.deleted_at IS NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL",
    sampleFilter: (sampleId) => ({ sql: "s.id = ?", bindings: [sampleId] }),
  }),
  comment: makeSearchAdapter({
    type: "comment",
    fromSql: "FROM comment_submissions cs",
    idSql: "cs.id",
    primarySqls: [],
    contentSqls: ["cs.body"],
    metadataSqls: ["cs.scope", "cs.context_kind", commentContextSql],
    timestampSql: "cs.updated_at",
    visibilitySql: commentVisibilitySql,
    sampleFilter: commentSampleFilter,
  }),
  comment_occurrence: makeSearchAdapter({
    type: "comment_occurrence",
    fromSql: `
      FROM run_step_comments rsc
      LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id
      JOIN run_steps rs ON rs.id = rsc.run_step_id
      LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
      JOIN runs r ON r.id = rs.run_id
      JOIN samples s ON s.id = r.sample_id
    `,
    idSql: "rsc.id",
    primarySqls: [],
    contentSqls: ["CASE WHEN rsc.submission_id IS NULL THEN rsc.body ELSE '' END"],
    metadataSqls: [
      "CASE WHEN rsc.submission_id IS NULL THEN rsc.scope ELSE '' END",
      "CASE WHEN rsc.submission_id IS NULL THEN COALESCE(rs.title, sd.name) ELSE '' END",
      "CASE WHEN rsc.submission_id IS NULL THEN r.template_name_snapshot ELSE '' END",
      "CASE WHEN rsc.submission_id IS NULL THEN s.code ELSE '' END",
      "CASE WHEN rsc.submission_id IS NULL THEN s.title ELSE '' END",
    ],
    timestampSql: "COALESCE(rsc.updated_at, rsc.created_at)",
    visibilitySql: `
      rsc.deleted_at IS NULL
      AND rs.deleted_at IS NULL
      AND r.deleted_at IS NULL
      AND s.deleted_at IS NULL
      AND (rsc.submission_id IS NULL OR (cs.status = 'ready' AND cs.deleted_at IS NULL))
      AND (rsc.submission_id IS NULL OR LOWER(rsc.id) = ?)
    `,
    visibilityBindings: (input) => [input.normalizedQuery],
    sampleFilter: (sampleId) => ({ sql: "s.id = ?", bindings: [sampleId] }),
  }),
  comment_attachment: makeSearchAdapter({
    type: "comment_attachment",
    fromSql: `
      FROM comment_submission_items csi
      JOIN comment_submissions owner ON owner.id = csi.submission_id
    `,
    idSql: "csi.id",
    primarySqls: ["csi.title", "csi.filename", "csi.original_filename"],
    contentSqls: ["csi.description"],
    metadataSqls: [
      "csi.external_url",
      "csi.kind",
      "csi.mime_type",
      "owner.body",
      attachmentContextSql,
    ],
    timestampSql: "csi.updated_at",
    visibilitySql: `
      csi.status = 'ready'
      AND csi.deleted_at IS NULL
      AND (${attachmentVisibilitySql})
    `,
    sampleFilter: attachmentSampleFilter,
  }),
  execution_image: makeSearchAdapter({
    type: "execution_image",
    fromSql: `
      FROM run_step_assets rsa
      LEFT JOIN assets a ON a.id = rsa.asset_id
      JOIN run_steps rs ON rs.id = rsa.run_step_id
      LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
      JOIN runs r ON r.id = rs.run_id
      JOIN samples s ON s.id = r.sample_id
    `,
    idSql: "rsa.id",
    primarySqls: ["a.original_name"],
    contentSqls: [],
    metadataSqls: [
      "a.mime_type",
      "COALESCE(rs.title, sd.name)",
      "r.template_name_snapshot",
      "CAST(r.template_version_snapshot AS TEXT)",
      "s.id",
      "s.code",
      "s.title",
    ],
    timestampSql: "rsa.created_at",
    visibilitySql: `
      rsa.role = 'execution'
      AND rsa.deleted_at IS NULL
      AND rs.deleted_at IS NULL
      AND r.deleted_at IS NULL
      AND s.deleted_at IS NULL
      AND a.original_name IS NOT NULL
    `,
    sampleFilter: (sampleId) => ({ sql: "s.id = ?", bindings: [sampleId] }),
  }),
  metrology_reference: makeSearchAdapter({
    type: "metrology_reference",
    fromSql: `
      FROM metrology_template_references mtr
      LEFT JOIN assets a ON a.id = mtr.asset_id
      JOIN template_versions tv ON tv.id = mtr.template_version_id
    `,
    idSql: "mtr.id",
    primarySqls: ["mtr.display_name", "a.original_name"],
    contentSqls: [],
    metadataSqls: [
      "a.mime_type",
      "tv.id",
      "tv.name",
      "CAST(tv.version AS TEXT)",
      "tv.template_kind",
      "tv.template_type",
    ],
    timestampSql: "mtr.created_at",
    visibilitySql: `
      mtr.deleted_at IS NULL
      AND tv.deleted_at IS NULL
      AND a.original_name IS NOT NULL
    `,
  }),
  recipe_revision: makeSearchAdapter({
    type: "recipe_revision",
    fromSql: "FROM template_versions tv",
    idSql: "tv.id",
    primarySqls: [
      "tv.name",
      "tv.name || ' v' || CAST(tv.version AS TEXT)",
      "tv.source_filename",
    ],
    contentSqls: [],
    metadataSqls: [
      "CAST(tv.version AS TEXT)",
      "tv.template_kind",
      "tv.template_type",
      "CASE WHEN tv.archived_at IS NULL THEN 'active' ELSE 'archived' END",
    ],
    timestampSql: "tv.created_at",
    visibilitySql: "tv.deleted_at IS NULL",
  }),
} as const satisfies Record<ReferenceTargetType, ReferenceSearchAdapter>;

function candidateLimit(resultLimit: number) {
  return Math.min(
    SEARCH_CANDIDATE_CEILING,
    Math.max(SEARCH_CANDIDATE_FLOOR, resultLimit * 3),
  );
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate) {
  const leftTier = MATCH_TIER_ORDER[left.tier];
  const rightTier = MATCH_TIER_ORDER[right.tier];
  if (leftTier !== rightTier) return leftTier - rightTier;

  const leftTime = left.matchedAt ?? "";
  const rightTime = right.matchedAt ?? "";
  if (leftTime !== rightTime) return rightTime.localeCompare(leftTime);

  const typeOrder = (TARGET_TYPE_ORDER.get(left.target.type) ?? 0)
    - (TARGET_TYPE_ORDER.get(right.target.type) ?? 0);
  if (typeOrder) return typeOrder;
  return left.target.id.localeCompare(right.target.id);
}

function hasActiveContext(resolution: ReferenceResolution) {
  return resolution.contexts.some((context) => (
    context.segments.every((segment) => segment.deletedAt === null)
  ));
}

function remainsSearchable(resolution: ReferenceResolution) {
  return resolution.resolution === "resolved"
    && resolution.source !== null
    && resolution.source.deletedAt === null
    && hasActiveContext(resolution);
}

export async function searchReferences(
  db: D1Database,
  rawInput: unknown,
): Promise<SearchReferencesResponse> {
  const input = normalizeReferenceSearchInput(rawInput);
  const perTypeLimit = candidateLimit(input.limit);
  const batches = await Promise.all(input.types.map(async (type) => (
    REFERENCE_SEARCH_ADAPTERS[type](db, input, perTypeLimit)
  )));
  const adapterTruncated = batches.some((batch) => batch.truncated);
  const candidates = batches.flatMap((batch) => batch.candidates).sort(compareCandidates);
  const resolutionPool = candidates.slice(0, Math.min(
    MAX_REFERENCE_SEARCH_RESOLUTION_CANDIDATES,
    Math.max(input.limit * 3, input.limit),
  ));
  const resolutions = await resolveReferences(
    db,
    resolutionPool.map((candidate) => candidate.target),
  );
  const resolutionByTarget = new Map(
    resolutions.map((resolution) => [referenceTargetKey(resolution.target), resolution]),
  );

  const results: ReferenceSearchResult[] = [];
  for (const candidate of resolutionPool) {
    const resolution = resolutionByTarget.get(referenceTargetKey(candidate.target));
    if (!resolution || !remainsSearchable(resolution)) continue;
    results.push({
      target: candidate.target,
      match: { tier: candidate.tier, matchedAt: candidate.matchedAt },
      resolution,
    });
    if (results.length === input.limit) break;
  }

  return {
    query: input.query,
    results,
    truncated: adapterTruncated || candidates.length > results.length,
  };
}

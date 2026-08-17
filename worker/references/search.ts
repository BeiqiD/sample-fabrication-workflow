import {
  DEFAULT_REFERENCE_SEARCH_LIMIT,
  MAX_REFERENCE_SEARCH_LIMIT,
  MAX_REFERENCE_SEARCH_QUERY_LENGTH,
  MAX_REFERENCE_SEARCH_RESOLUTION_CANDIDATES,
  MAX_REFERENCE_SEARCH_TOKENS,
  type NormalizedReferenceSearchInput,
  type ReferenceSearchMatchTier,
  type ReferenceSearchResult,
  type SearchReferencesResponse,
} from "../../shared/reference-search";
import {
  REFERENCE_TARGET_TYPES,
  isReferenceTarget,
  isReferenceTargetType,
  type ReferenceTarget,
  type ReferenceTargetType,
} from "../../shared/reference-types";
import { referenceResolutionIsEligible } from "./eligibility";
import { referenceTargetKey, resolveReferences } from "./resolver";
import { publishedAssetSql, publishedTemplateVersionSql } from "../template-publication";

const SEARCH_CANDIDATE_FLOOR = 60;
const SEARCH_CANDIDATE_CEILING = 150;

export const REFERENCE_SEARCH_MATCH_SPECIFICITY = {
  byte_exact_id: 0,
  ascii_folded_exact_id: 1,
  byte_exact_primary: 2,
  ascii_folded_exact_primary: 3,
  prefix_primary: 4,
  content: 5,
  metadata: 6,
} as const;

export type ReferenceSearchMatchSpecificity =
  typeof REFERENCE_SEARCH_MATCH_SPECIFICITY[keyof typeof REFERENCE_SEARCH_MATCH_SPECIFICITY];

const MATCH_TIER_BY_SPECIFICITY: Record<
  ReferenceSearchMatchSpecificity,
  ReferenceSearchMatchTier
> = {
  [REFERENCE_SEARCH_MATCH_SPECIFICITY.byte_exact_id]: "exact_id",
  [REFERENCE_SEARCH_MATCH_SPECIFICITY.ascii_folded_exact_id]: "exact_id",
  [REFERENCE_SEARCH_MATCH_SPECIFICITY.byte_exact_primary]: "exact_primary",
  [REFERENCE_SEARCH_MATCH_SPECIFICITY.ascii_folded_exact_primary]: "exact_primary",
  [REFERENCE_SEARCH_MATCH_SPECIFICITY.prefix_primary]: "prefix_primary",
  [REFERENCE_SEARCH_MATCH_SPECIFICITY.content]: "content",
  [REFERENCE_SEARCH_MATCH_SPECIFICITY.metadata]: "metadata",
};

function normalizeMatchSpecificity(value: number): ReferenceSearchMatchSpecificity {
  if (Number.isInteger(value)
    && value >= REFERENCE_SEARCH_MATCH_SPECIFICITY.byte_exact_id
    && value <= REFERENCE_SEARCH_MATCH_SPECIFICITY.metadata) {
    return value as ReferenceSearchMatchSpecificity;
  }
  return REFERENCE_SEARCH_MATCH_SPECIFICITY.metadata;
}

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
  match_specificity: number;
  matched_at: string | null;
};

export type ReferenceSearchCandidate = {
  target: ReferenceTarget;
  specificity: ReferenceSearchMatchSpecificity;
  matchedAt: string | null;
};

export type ReferenceSearchCandidateBatch = {
  candidates: ReferenceSearchCandidate[];
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

export interface ReferenceSearchSqlDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

export type ReferenceSearchAdapter = (
  db: ReferenceSearchSqlDatabase,
  input: NormalizedReferenceSearchInput,
  candidateLimit: number,
) => Promise<ReferenceSearchCandidateBatch>;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function asciiFoldReferenceSearchText(value: string) {
  return value.replace(/[A-Z]/g, (character) => (
    String.fromCharCode(character.charCodeAt(0) + 32)
  ));
}

function referenceSearchTokens(value: string) {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const rawToken of value.split(/\s+/)) {
    if (!rawToken) continue;
    const token = asciiFoldReferenceSearchText(rawToken);
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length === MAX_REFERENCE_SEARCH_TOKENS) break;
  }
  return tokens;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidCalendarDate(year: number, month: number, day: number) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number.isInteger(day) && day >= 1 && day <= days[month - 1];
}

function invalidTimestamp(field: "from" | "to"): never {
  throw new ReferenceSearchInputError(
    "invalid_time_range",
    `Reference search ${field} must be YYYY-MM-DD or an RFC 3339 timestamp with an explicit timezone`,
  );
}

function normalizeTimestamp(value: unknown, field: "from" | "to") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return invalidTimestamp(field);

  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!isValidCalendarDate(year, month, day)) return invalidTimestamp(field);
    return `${value}T00:00:00.000Z`;
  }

  const timestamp = RFC3339_PATTERN.exec(value);
  if (!timestamp) return invalidTimestamp(field);
  const year = Number(timestamp[1]);
  const month = Number(timestamp[2]);
  const day = Number(timestamp[3]);
  const hour = Number(timestamp[4]);
  const minute = Number(timestamp[5]);
  const second = Number(timestamp[6]);
  const offsetHour = Number(timestamp[10] ?? 0);
  const offsetMinute = Number(timestamp[11] ?? 0);
  if (!isValidCalendarDate(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59) {
    return invalidTimestamp(field);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return invalidTimestamp(field);
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
  if (!query || Array.from(query).length > MAX_REFERENCE_SEARCH_QUERY_LENGTH) {
    throw new ReferenceSearchInputError(
      "invalid_query",
      `Reference search query must contain 1 to ${MAX_REFERENCE_SEARCH_QUERY_LENGTH} Unicode code points`,
    );
  }
  const tokens = referenceSearchTokens(query);
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
    normalizedQuery: asciiFoldReferenceSearchText(query),
    tokens,
    types,
    sampleId,
    from,
    to,
    limit,
  };
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
    () => `INSTR(LOWER(${haystack}), ?) > 0`,
  ).join(" AND ");
}

function primaryExactSql(
  expressions: string[],
  mode: "byte_exact" | "ascii_folded",
) {
  if (!expressions.length) return "0";
  return expressions.map((expression) => {
    const text = textExpression(expression);
    return mode === "byte_exact"
      ? `${text} = ? COLLATE BINARY`
      : `LOWER(${text}) = ?`;
  }).join(" OR ");
}

function primaryPrefixSql(expressions: string[]) {
  if (!expressions.length) return "0";
  return expressions.map((expression) => {
    const text = textExpression(expression);
    return `(INSTR(${text}, ?) = 1 OR INSTR(LOWER(${text}), ?) = 1)`;
  }).join(" OR ");
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
    const byteExactPrimary = primaryExactSql(spec.primarySqls, "byte_exact");
    const asciiFoldedExactPrimary = primaryExactSql(spec.primarySqls, "ascii_folded");
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
               WHEN ${textExpression(spec.idSql)} = ? COLLATE BINARY
                 THEN ${REFERENCE_SEARCH_MATCH_SPECIFICITY.byte_exact_id}
               WHEN LOWER(${textExpression(spec.idSql)}) = ?
                 THEN ${REFERENCE_SEARCH_MATCH_SPECIFICITY.ascii_folded_exact_id}
               WHEN (${byteExactPrimary})
                 THEN ${REFERENCE_SEARCH_MATCH_SPECIFICITY.byte_exact_primary}
               WHEN (${asciiFoldedExactPrimary})
                 THEN ${REFERENCE_SEARCH_MATCH_SPECIFICITY.ascii_folded_exact_primary}
               WHEN (${prefixPrimary})
                 THEN ${REFERENCE_SEARCH_MATCH_SPECIFICITY.prefix_primary}
               WHEN (${contentMatch})
                 THEN ${REFERENCE_SEARCH_MATCH_SPECIFICITY.content}
               ELSE ${REFERENCE_SEARCH_MATCH_SPECIFICITY.metadata}
             END AS match_specificity,
             ${spec.timestampSql} AS matched_at
      ${spec.fromSql}
      WHERE (${spec.visibilitySql})
        AND (${fullMatch})
        ${sampleFilter ? `AND (${sampleFilter.sql})` : ""}
        ${timeSql.map((condition) => `AND (${condition})`).join("\n")}
      ORDER BY match_specificity ASC,
               COALESCE(${spec.timestampSql}, '') DESC,
               target_id ASC
      LIMIT ?
    `;

    const bindings: unknown[] = [
      input.query,
      input.normalizedQuery,
      ...spec.primarySqls.map(() => input.query),
      ...spec.primarySqls.map(() => input.normalizedQuery),
      ...spec.primarySqls.flatMap(() => [input.query, input.normalizedQuery]),
      ...(spec.contentSqls.length ? input.tokens : []),
      ...(spec.visibilityBindings?.(input) ?? []),
      ...input.tokens,
      ...(sampleFilter?.bindings ?? []),
      ...(input.from ? [input.from] : []),
      ...(input.to ? [input.to] : []),
      candidateLimit + 1,
    ];

    const rows = await db.prepare(sql).bind(...bindings).all<CandidateRow>();
    const truncated = rows.results.length > candidateLimit;
    const candidates = rows.results.slice(0, candidateLimit).map((row): ReferenceSearchCandidate => ({
      target: { type: spec.type, id: row.target_id },
      specificity: normalizeMatchSpecificity(Number(row.match_specificity)),
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
      AND (rsc.submission_id IS NULL
        OR rsc.id = ? COLLATE BINARY
        OR LOWER(rsc.id) = ?)
    `,
    visibilityBindings: (input) => [input.query, input.normalizedQuery],
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
      AND a.status = 'ready'
      AND ${publishedAssetSql("a")}
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
      AND ${publishedTemplateVersionSql("tv")}
      AND a.status = 'ready'
      AND ${publishedAssetSql("a")}
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
    visibilitySql: `tv.deleted_at IS NULL AND ${publishedTemplateVersionSql("tv")}`,
  }),
} as const satisfies Record<ReferenceTargetType, ReferenceSearchAdapter>;

export interface ReferenceSearchCandidateBackend {
  readonly kind: string;
  searchType(
    type: ReferenceTargetType,
    input: NormalizedReferenceSearchInput,
    candidateLimit: number,
  ): Promise<ReferenceSearchCandidateBatch>;
}

export interface SearchReferencesOptions {
  candidateBackend?: ReferenceSearchCandidateBackend;
}

export function createSqliteSourceReferenceSearchBackend(
  db: ReferenceSearchSqlDatabase,
): ReferenceSearchCandidateBackend {
  return {
    kind: "sqlite-source-scan",
    searchType: (type, input, limit) => REFERENCE_SEARCH_ADAPTERS[type](db, input, limit),
  };
}

function candidateLimit(resultLimit: number) {
  return Math.min(
    SEARCH_CANDIDATE_CEILING,
    Math.max(SEARCH_CANDIDATE_FLOOR, resultLimit * 3),
  );
}

function compareCandidates(left: ReferenceSearchCandidate, right: ReferenceSearchCandidate) {
  if (left.specificity !== right.specificity) {
    return left.specificity - right.specificity;
  }

  const leftTime = left.matchedAt ?? "";
  const rightTime = right.matchedAt ?? "";
  if (leftTime !== rightTime) return rightTime.localeCompare(leftTime);

  const typeOrder = (TARGET_TYPE_ORDER.get(left.target.type) ?? 0)
    - (TARGET_TYPE_ORDER.get(right.target.type) ?? 0);
  if (typeOrder) return typeOrder;
  return left.target.id.localeCompare(right.target.id);
}

export async function searchReferences(
  db: D1Database,
  rawInput: unknown,
  options: SearchReferencesOptions = {},
): Promise<SearchReferencesResponse> {
  const input = normalizeReferenceSearchInput(rawInput);
  const perTypeLimit = candidateLimit(input.limit);
  const backend = options.candidateBackend
    ?? createSqliteSourceReferenceSearchBackend(db as ReferenceSearchSqlDatabase);
  const batches = await Promise.all(input.types.map(async (type) => (
    backend.searchType(type, input, perTypeLimit)
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
    if (!resolution || !referenceResolutionIsEligible(resolution)) continue;
    results.push({
      target: candidate.target,
      match: {
        tier: MATCH_TIER_BY_SPECIFICITY[candidate.specificity],
        matchedAt: candidate.matchedAt,
      },
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

import {
  DEFAULT_REFERENCE_CHILD_LIMIT,
  MAX_REFERENCE_CHILD_LIMIT,
  isListReferenceChildrenInput,
  type ListReferenceChildrenInput,
  type ListReferenceChildrenResponse,
} from "../../shared/reference-children";
import {
  isReferenceTarget,
  MAX_REFERENCE_RESOLUTION_TARGETS,
  type ReferenceTarget,
} from "../../shared/reference-types";
import { referenceResolutionIsEligible } from "./eligibility";
import {
  referenceTargetKey,
  resolveReferences,
} from "./resolver";

type CandidateRow = {
  target_type: string;
  target_id: string;
};

export interface NormalizedReferenceChildrenInput {
  parent: ReferenceTarget;
  limit: number;
}

export class ReferenceChildrenInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceChildrenInputError";
  }
}

export function normalizeReferenceChildrenInput(
  value: unknown,
): NormalizedReferenceChildrenInput {
  if (!isListReferenceChildrenInput(value)) {
    throw new ReferenceChildrenInputError(
      `A valid parent target and an optional limit between 1 and ${MAX_REFERENCE_CHILD_LIMIT} are required`,
    );
  }
  return {
    parent: value.parent,
    limit: value.limit ?? DEFAULT_REFERENCE_CHILD_LIMIT,
  };
}

async function rows(
  db: D1Database,
  sql: string,
  bindings: unknown[],
) {
  const result = await db.prepare(sql).bind(...bindings).all<CandidateRow>();
  return result.results;
}

async function directChildRows(
  db: D1Database,
  parent: ReferenceTarget,
): Promise<CandidateRow[]> {
  const candidateLimit = MAX_REFERENCE_RESOLUTION_TARGETS + 1;
  switch (parent.type) {
    case "sample":
      return rows(db, `
        SELECT target_type, target_id
        FROM (
          SELECT 'run' AS target_type, r.id AS target_id,
                 0 AS group_order, r.sequence_no AS numeric_order,
                 r.created_at AS time_order, r.id AS tie_order
          FROM runs r
          WHERE r.sample_id = ? AND r.deleted_at IS NULL
          UNION ALL
          SELECT 'comment' AS target_type, cs.id AS target_id,
                 1 AS group_order, 0 AS numeric_order,
                 cs.created_at AS time_order, cs.id AS tie_order
          FROM comment_submissions cs
          WHERE cs.context_kind = 'sample'
            AND cs.sample_id = ?
            AND cs.status = 'ready'
            AND cs.deleted_at IS NULL
        )
        ORDER BY group_order, numeric_order, time_order, tie_order
        LIMIT ?
      `, [parent.id, parent.id, candidateLimit]);

    case "run":
      return rows(db, `
        SELECT 'run_step' AS target_type, rs.id AS target_id
        FROM run_steps rs
        WHERE rs.run_id = ? AND rs.deleted_at IS NULL
        ORDER BY rs.position, rs.created_at, rs.id
        LIMIT ?
      `, [parent.id, candidateLimit]);

    case "run_step":
      return rows(db, `
        SELECT target_type, target_id
        FROM (
          SELECT DISTINCT
                 CASE WHEN rsc.submission_id IS NULL
                   THEN 'comment_occurrence' ELSE 'comment' END AS target_type,
                 COALESCE(rsc.submission_id, rsc.id) AS target_id,
                 0 AS group_order, 0 AS numeric_order,
                 COALESCE(rsc.created_at, rsc.updated_at) AS time_order,
                 rsc.id AS tie_order
          FROM run_step_comments rsc
          LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id
          WHERE rsc.run_step_id = ?
            AND rsc.deleted_at IS NULL
            AND (
              rsc.submission_id IS NULL
              OR (cs.status = 'ready' AND cs.deleted_at IS NULL)
            )
          UNION ALL
          SELECT 'execution_image' AS target_type, rsa.id AS target_id,
                 1 AS group_order, rsa.position AS numeric_order,
                 rsa.created_at AS time_order, rsa.id AS tie_order
          FROM run_step_assets rsa
          WHERE rsa.run_step_id = ?
            AND rsa.role = 'execution'
            AND rsa.deleted_at IS NULL
            AND rsa.superseded_by_occurrence_id IS NULL
        )
        ORDER BY group_order, numeric_order, time_order, tie_order
        LIMIT ?
      `, [parent.id, parent.id, candidateLimit]);

    case "comment":
      return rows(db, `
        SELECT target_type, target_id
        FROM (
          SELECT 'comment_occurrence' AS target_type, rsc.id AS target_id,
                 0 AS group_order, rs.position AS numeric_order,
                 COALESCE(rsc.created_at, rsc.updated_at) AS time_order,
                 s.code || ':' || r.sequence_no || ':' || rs.position || ':' || rsc.id AS tie_order
          FROM run_step_comments rsc
          JOIN run_steps rs ON rs.id = rsc.run_step_id
          JOIN runs r ON r.id = rs.run_id
          JOIN samples s ON s.id = r.sample_id
          WHERE rsc.submission_id = ? AND rsc.deleted_at IS NULL
          UNION ALL
          SELECT 'comment_attachment' AS target_type, csi.id AS target_id,
                 1 AS group_order, csi.position AS numeric_order,
                 csi.created_at AS time_order, csi.id AS tie_order
          FROM comment_submission_items csi
          WHERE csi.submission_id = ?
            AND csi.status = 'ready'
            AND csi.deleted_at IS NULL
        )
        ORDER BY group_order, numeric_order, time_order, tie_order
        LIMIT ?
      `, [parent.id, parent.id, candidateLimit]);

    case "comment_occurrence":
      return rows(db, `
        SELECT 'comment_attachment' AS target_type, csi.id AS target_id
        FROM run_step_comments rsc
        JOIN comment_submissions cs
          ON cs.id = rsc.submission_id
         AND cs.status = 'ready'
         AND cs.deleted_at IS NULL
        JOIN comment_submission_items csi
          ON csi.submission_id = cs.id
        WHERE rsc.id = ?
          AND rsc.deleted_at IS NULL
          AND csi.status = 'ready'
          AND csi.deleted_at IS NULL
        ORDER BY csi.position, csi.created_at, csi.id
        LIMIT ?
      `, [parent.id, candidateLimit]);

    case "recipe_revision":
      return rows(db, `
        SELECT 'metrology_reference' AS target_type, mtr.id AS target_id
        FROM metrology_template_references mtr
        WHERE mtr.template_version_id = ?
          AND mtr.deleted_at IS NULL
          AND mtr.superseded_by_occurrence_id IS NULL
        ORDER BY mtr.position, mtr.created_at, mtr.id
        LIMIT ?
      `, [parent.id, candidateLimit]);

    case "comment_attachment":
    case "execution_image":
    case "metrology_reference":
      return [];
  }
}

function uniqueTargets(candidateRows: CandidateRow[]) {
  const targets: ReferenceTarget[] = [];
  const seen = new Set<string>();
  for (const row of candidateRows) {
    const target = { type: row.target_type, id: row.target_id };
    if (!isReferenceTarget(target)) continue;
    const key = referenceTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
    if (targets.length === MAX_REFERENCE_RESOLUTION_TARGETS) break;
  }
  return targets;
}

export async function listReferenceChildren(
  db: D1Database,
  rawInput: unknown,
): Promise<ListReferenceChildrenResponse> {
  const input = normalizeReferenceChildrenInput(rawInput);
  const [parent] = await resolveReferences(db, [input.parent]);
  if (!parent) {
    throw new ReferenceChildrenInputError("Reference resolution returned no parent result");
  }

  const parentEligible = referenceResolutionIsEligible(parent);
  if (!parentEligible) {
    return { parent, parentEligible, children: [], truncated: false };
  }

  const candidateRows = await directChildRows(db, input.parent);
  const rawTruncated = candidateRows.length > MAX_REFERENCE_RESOLUTION_TARGETS;
  const targets = uniqueTargets(candidateRows);
  const resolutions = targets.length ? await resolveReferences(db, targets) : [];
  const eligible = resolutions.filter(referenceResolutionIsEligible);

  return {
    parent,
    parentEligible,
    children: eligible.slice(0, input.limit),
    truncated: rawTruncated || eligible.length > input.limit,
  };
}

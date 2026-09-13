import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_SAMPLE_STATUS, isSampleStatus, MAX_SPLIT_PIECES, type CreateRecordInput, type DeleteSampleInput, type SampleDirectorySort, type SampleStatus, type SplitSampleInput } from "../../shared/types";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { prepareSplitInheritedState } from "../sample-split-state";
import { sampleDetail, sampleEvent, sampleSummary } from "../serializers";
import { escapedLikePattern } from "../request-guards";
import { titleChangeAudit } from "../sample-update";
import { validateCreateSampleInput, validateUpdateSampleInput } from "../sample-input";
import { directoryFilterValue, likeBindings, paginationMeta, processingDirectoryFilter, readPagination, repeatedLikeSql, sampleDirectorySort, searchTokens } from "../directory-query";
import { serializeCommentSubmissions, type CommentSubmissionItemRow, type CommentSubmissionRow } from "../comment-submission-serialization";
import type { Env } from "../types";
import { loadCurrentSampleStructure } from "../application/sample-structure";
import { requireVisibleCommentOperationGroup } from "../evidence/comment-operation-group";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

const sampleOverviewSelect = `
  SELECT s.*,
         COALESCE(ptv.name, r.template_name_snapshot) AS latest_workflow_name,
         COALESCE(ptv.version, r.template_version_snapshot) AS latest_workflow_version,
         r.status AS latest_run_status,
         (
           SELECT COALESCE(rs.title, sd.name)
           FROM run_steps rs
           LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
           WHERE rs.run_id = r.id AND rs.plan_status = 'current' AND rs.deleted_at IS NULL
             AND rs.entry_kind = 'fabrication'
             AND rs.status NOT IN ('done', 'skipped')
           ORDER BY rs.position
           LIMIT 1
         ) AS current_step_title,
         (
           SELECT state_step_title FROM (
             SELECT COALESCE(rs.title, sd.name) AS state_step_title, 1 AS priority
             FROM run_steps rs
             LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
             WHERE rs.run_id = r.id AND rs.entry_kind = 'fabrication' AND rs.status = 'done'
               AND rs.deleted_at IS NULL
               AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
               AND (rs.expected_state_hash IS NOT NULL OR EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.run_step_id = rs.id AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
               ))
             ORDER BY rs.position DESC LIMIT 1
           )
         ) AS current_state_step_title,
         (
           COALESCE(
             (
               SELECT a.r2_key
               FROM run_steps rs
               JOIN run_step_assets rsa ON rsa.run_step_id = rs.id AND rsa.role = 'execution'
                 AND rsa.deleted_at IS NULL
               JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
               WHERE rs.run_id = r.id AND rs.entry_kind = 'fabrication' AND rs.status = 'done'
                 AND rs.deleted_at IS NULL
                 AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
               ORDER BY rs.position DESC, rsa.position, a.id LIMIT 1
             ),
             (
               SELECT a.r2_key
               FROM state_representation_assets sra
               JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
               WHERE sra.state_hash = COALESCE(
                 (
                   SELECT rs.expected_state_hash
                   FROM run_steps rs
                   WHERE rs.run_id = r.id AND rs.entry_kind = 'fabrication' AND rs.deleted_at IS NULL
                     AND rs.status = 'done' AND rs.expected_state_hash IS NOT NULL
                     AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
                   ORDER BY rs.position DESC LIMIT 1
                 ),
                 r.initial_state_hash,
                 (
                   SELECT rs.expected_state_hash
                   FROM run_steps rs JOIN runs earlier ON earlier.id = rs.run_id
                   WHERE earlier.sample_id = s.id AND earlier.run_kind = 'process'
                     AND earlier.deleted_at IS NULL AND rs.deleted_at IS NULL
                     AND earlier.sequence_no < r.sequence_no
                     AND rs.entry_kind = 'fabrication'
                     AND rs.status = 'done' AND rs.expected_state_hash IS NOT NULL
                     AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
                   ORDER BY earlier.sequence_no DESC, rs.position DESC LIMIT 1
                 ),
                 s.inherited_state_hash
               )
               ORDER BY sra.position, a.id LIMIT 1
             )
           )
         ) AS current_state_thumbnail_key
  FROM samples s
  LEFT JOIN runs r ON r.sample_id = s.id AND r.deleted_at IS NULL
    AND r.sequence_no = (
      SELECT MAX(latest.sequence_no)
      FROM runs latest
      WHERE latest.sample_id = s.id AND latest.run_kind = 'process' AND latest.deleted_at IS NULL
    )
  LEFT JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id
  LEFT JOIN template_versions ptv ON ptv.id = rpr.template_version_id
  WHERE s.deleted_at IS NULL`;

const sampleDirectoryBaseSelect = `
  SELECT s.id, s.code, s.title, s.status, s.location, s.parent_id, s.pinned,
         s.created_at, s.updated_at, s.inherited_state_hash,
         r.id AS latest_run_id,
         r.sequence_no AS latest_run_sequence,
         r.initial_state_hash AS latest_run_initial_state_hash,
         COALESCE(ptv.name, r.template_name_snapshot) AS latest_workflow_name,
         COALESCE(ptv.version, r.template_version_snapshot) AS latest_workflow_version,
         r.status AS latest_run_status
  FROM samples s
  LEFT JOIN runs r ON r.id = (
    SELECT latest.id
    FROM runs latest
    WHERE latest.sample_id = s.id AND latest.run_kind = 'process' AND latest.deleted_at IS NULL
    ORDER BY latest.sequence_no DESC
    LIMIT 1
  )
  LEFT JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id
  LEFT JOIN template_versions ptv ON ptv.id = rpr.template_version_id
  WHERE s.deleted_at IS NULL`;

function sampleDirectorySearch(query: string) {
  const tokens = searchTokens(query);
  if (!tokens.length) return { sql: "1 = 1", bindings: [] as string[] };
  const haystack = `LOWER(
    COALESCE(code, '') || ' ' ||
    COALESCE(title, '') || ' ' ||
    COALESCE(location, '') || ' ' ||
    COALESCE(latest_workflow_name, '')
  )`;
  return { sql: repeatedLikeSql(haystack, tokens), bindings: likeBindings(tokens) };
}

function processingDirectoryWhere(filter: ReturnType<typeof processingDirectoryFilter>) {
  if (filter === "complete") return "latest_run_status = 'complete'";
  if (filter === "cancelled") return "latest_run_status = 'cancelled'";
  if (filter === "all") return "1 = 1";
  return "status = 'active' AND (latest_run_status = 'active' OR latest_run_status IS NULL)";
}

function sampleDirectoryFilters(input: {
  status: string;
  location: string;
  parent: string;
  workflow: string;
}) {
  const sql: string[] = [];
  const bindings: string[] = [];
  if (isSampleStatus(input.status)) {
    sql.push("status = ?");
    bindings.push(input.status);
  }
  if (input.location) {
    sql.push("LOWER(COALESCE(location, '')) LIKE ? ESCAPE '\\'");
    bindings.push(escapedLikePattern(input.location.toLocaleLowerCase()));
  }
  if (input.parent) {
    sql.push(`EXISTS (
      SELECT 1 FROM samples parent
      WHERE parent.id = sample_base.parent_id
        AND parent.deleted_at IS NULL
        AND LOWER(COALESCE(parent.code, '') || ' ' || COALESCE(parent.title, '')) LIKE ? ESCAPE '\\'
    )`);
    bindings.push(escapedLikePattern(input.parent.toLocaleLowerCase()));
  }
  if (input.workflow) {
    sql.push("LOWER(COALESCE(latest_workflow_name, '')) LIKE ? ESCAPE '\\'");
    bindings.push(escapedLikePattern(input.workflow.toLocaleLowerCase()));
  }
  return { sql: sql.length ? sql.join(" AND ") : "1 = 1", bindings };
}

function sampleDirectoryOrder(sort: SampleDirectorySort, tokens: string[]) {
  if (sort === "relevance" && tokens.length) {
    const fields = [
      ["code", 8],
      ["title", 4],
      ["latest_workflow_name", 2],
      ["location", 1],
    ] as const;
    const scoreTerms: string[] = [];
    const bindings: string[] = [];
    for (const token of tokens) {
      const pattern = escapedLikePattern(token);
      for (const [field, weight] of fields) {
        scoreTerms.push(`CASE WHEN LOWER(COALESCE(${field}, '')) LIKE ? ESCAPE '\\' THEN ${weight} ELSE 0 END`);
        bindings.push(pattern);
      }
    }
    return {
      sql: `pinned DESC, (${scoreTerms.join(" + ")}) DESC, updated_at DESC, id`,
      bindings,
    };
  }
  const orderBy: Record<Exclude<SampleDirectorySort, "relevance">, string> = {
    "active-updated-desc": "CASE WHEN status = 'active' THEN 0 ELSE 1 END, pinned DESC, updated_at DESC, id",
    "updated-desc": "updated_at DESC, id",
    "updated-asc": "updated_at ASC, id",
    "created-desc": "created_at DESC, id",
    "created-asc": "created_at ASC, id",
    "code-asc": "code COLLATE NOCASE ASC, id",
    "code-desc": "code COLLATE NOCASE DESC, id",
  };
  const selected = sort === "relevance" ? "active-updated-desc" : sort;
  return {
    sql: selected === "active-updated-desc" ? orderBy[selected] : `pinned DESC, ${orderBy[selected]}`,
    bindings: [] as string[],
  };
}

routes.get("/sample-directory-options", async (c) => {
  const d1Started = performance.now();
  const [locations, parents, workflows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT DISTINCT location
       FROM samples
       WHERE deleted_at IS NULL AND location IS NOT NULL AND TRIM(location) <> ''
       ORDER BY location COLLATE NOCASE`,
    ).all<{ location: string }>(),
    c.env.DB.prepare(
      `SELECT DISTINCT parent.id, parent.code, parent.title
       FROM samples child
       JOIN samples parent ON parent.id = child.parent_id
       WHERE child.deleted_at IS NULL AND parent.deleted_at IS NULL
       ORDER BY parent.code COLLATE NOCASE, parent.id`,
    ).all<{ id: string; code: string; title: string }>(),
    c.env.DB.prepare(
      `WITH sample_base AS (${sampleDirectoryBaseSelect})
       SELECT DISTINCT latest_workflow_name AS name
       FROM sample_base
       WHERE latest_workflow_name IS NOT NULL AND TRIM(latest_workflow_name) <> ''
       ORDER BY latest_workflow_name COLLATE NOCASE`,
    ).all<{ name: string }>(),
  ]);
  const d1Duration = performance.now() - d1Started;
  const response = c.json({
    locations: locations.results.map((row) => row.location),
    parents: parents.results,
    workflows: workflows.results.map((row) => row.name),
  });
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}`);
  return response;
});

routes.get("/samples", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const matchingRunFamilyId = c.req.query("runFamily")?.trim() ?? "";
  const matchingRunKind = c.req.query("runKind")?.trim() ?? "";
  const matchingRunStatus = c.req.query("runStatus")?.trim() ?? "";
  const hasMatchingRunFilter = Boolean(matchingRunFamilyId || matchingRunKind || matchingRunStatus);
  if (
    matchingRunFamilyId.length > 200
    || (hasMatchingRunFilter && !matchingRunFamilyId)
    || (hasMatchingRunFilter && !["process", "metrology"].includes(matchingRunKind))
    || (hasMatchingRunFilter && !["active", "complete", "cancelled", "superseded"].includes(matchingRunStatus))
  ) {
    throw new HTTPException(400, { message: "Invalid matching-run filter" });
  }
  const processingView = c.req.query("view") === "processing";
  const filter = processingDirectoryFilter(c.req.query("status"));
  const { page, pageSize, offset } = readPagination(c.req.query("page"), c.req.query("pageSize"));
  const search = sampleDirectorySearch(query);
  const sampleFilters = sampleDirectoryFilters({
    status: processingView ? "" : directoryFilterValue(c.req.query("status")),
    location: processingView ? "" : directoryFilterValue(c.req.query("location")),
    parent: processingView ? "" : directoryFilterValue(c.req.query("parent")),
    workflow: processingView ? "" : directoryFilterValue(c.req.query("process")),
  });
  const baseFilterSql = processingView ? processingDirectoryWhere(filter) : sampleFilters.sql;
  const matchingRunFilterSql = matchingRunFamilyId
    ? ` AND EXISTS (
          SELECT 1 FROM runs matching_run
          WHERE matching_run.sample_id = sample_base.id
            AND matching_run.recipe_family_id = ?
            AND matching_run.run_kind = ?
            AND matching_run.status = ?
            AND matching_run.deleted_at IS NULL
        )`
    : "";
  const filterSql = `(${baseFilterSql})${matchingRunFilterSql}`;
  const matchingRunBindings = matchingRunFamilyId
    ? [matchingRunFamilyId, matchingRunKind, matchingRunStatus]
    : [];
  const searchTerms = searchTokens(query);
  const sort = sampleDirectorySort(c.req.query("sort"), searchTerms.length > 0);
  const ordering = processingView
    ? { sql: "pinned DESC, updated_at DESC, id", bindings: [] as string[] }
    : sampleDirectoryOrder(sort, searchTerms);
  const stateFields = processingView ? `,
         (
           SELECT COALESCE(rs.title, sd.name)
           FROM run_steps rs
           LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
           WHERE rs.run_id = filtered_samples.latest_run_id AND rs.deleted_at IS NULL
             AND rs.entry_kind = 'fabrication' AND rs.status = 'done'
             AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
             AND (rs.expected_state_hash IS NOT NULL OR EXISTS (
               SELECT 1 FROM run_step_assets rsa
               WHERE rsa.run_step_id = rs.id AND rsa.role = 'execution'
                 AND rsa.deleted_at IS NULL
             ))
           ORDER BY rs.position DESC LIMIT 1
         ) AS current_state_step_title,
         COALESCE(
           (
             SELECT a.r2_key
             FROM run_steps rs
             JOIN run_step_assets rsa ON rsa.run_step_id = rs.id AND rsa.role = 'execution'
               AND rsa.deleted_at IS NULL
             JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
             WHERE rs.run_id = filtered_samples.latest_run_id AND rs.deleted_at IS NULL
               AND rs.entry_kind = 'fabrication' AND rs.status = 'done'
               AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
             ORDER BY rs.position DESC, rsa.position, a.id LIMIT 1
           ),
           (
             SELECT a.r2_key
             FROM state_representation_assets sra
             JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
             WHERE sra.state_hash = COALESCE(
               (
                 SELECT rs.expected_state_hash
                 FROM run_steps rs
                 WHERE rs.run_id = filtered_samples.latest_run_id AND rs.deleted_at IS NULL
                   AND rs.entry_kind = 'fabrication' AND rs.status = 'done'
                   AND rs.expected_state_hash IS NOT NULL
                   AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
                 ORDER BY rs.position DESC LIMIT 1
               ),
               filtered_samples.latest_run_initial_state_hash,
               (
                 SELECT rs.expected_state_hash
                 FROM run_steps rs
                 JOIN runs earlier ON earlier.id = rs.run_id
                 WHERE earlier.sample_id = filtered_samples.id
                   AND earlier.run_kind = 'process' AND earlier.deleted_at IS NULL
                   AND rs.deleted_at IS NULL
                   AND (
                     filtered_samples.latest_run_sequence IS NULL
                     OR earlier.sequence_no < filtered_samples.latest_run_sequence
                   )
                   AND rs.entry_kind = 'fabrication' AND rs.status = 'done'
                   AND rs.expected_state_hash IS NOT NULL
                   AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
                 ORDER BY earlier.sequence_no DESC, rs.position DESC LIMIT 1
               ),
               filtered_samples.inherited_state_hash
             )
             ORDER BY sra.position, a.id LIMIT 1
           )
         ) AS current_state_thumbnail_key` : `,
         NULL AS current_state_step_title,
         NULL AS current_state_thumbnail_key`;
  const pageSql = `
    WITH sample_base AS (${sampleDirectoryBaseSelect}),
    filtered_samples AS (
      SELECT *
      FROM sample_base
      WHERE ${search.sql} AND ${filterSql}
      ORDER BY ${ordering.sql}
      LIMIT ? OFFSET ?
    )
    SELECT filtered_samples.*,
           (
             SELECT COALESCE(rs.title, sd.name)
             FROM run_steps rs
             LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
             WHERE rs.run_id = filtered_samples.latest_run_id AND rs.deleted_at IS NULL
               AND rs.plan_status = 'current'
               AND rs.entry_kind = 'fabrication'
               AND rs.status NOT IN ('done', 'skipped')
             ORDER BY rs.position
             LIMIT 1
           ) AS current_step_title
           ${stateFields}
    FROM filtered_samples
    ORDER BY ${ordering.sql}`;
  const countSql = processingView
    ? `WITH sample_base AS (${sampleDirectoryBaseSelect})
       SELECT COUNT(*) AS all_count,
              COALESCE(SUM(CASE WHEN status = 'active' AND (latest_run_status = 'active' OR latest_run_status IS NULL) THEN 1 ELSE 0 END), 0) AS active_count,
              COALESCE(SUM(CASE WHEN latest_run_status = 'complete' THEN 1 ELSE 0 END), 0) AS complete_count,
              COALESCE(SUM(CASE WHEN latest_run_status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count
       FROM sample_base WHERE ${search.sql}`
    : `WITH sample_base AS (${sampleDirectoryBaseSelect})
       SELECT COUNT(*) AS all_count FROM sample_base WHERE ${search.sql} AND ${filterSql}`;
  const d1Started = performance.now();
  const [result, countRow] = await Promise.all([
    c.env.DB.prepare(pageSql).bind(...search.bindings, ...sampleFilters.bindings, ...matchingRunBindings, ...ordering.bindings, pageSize, offset, ...ordering.bindings).all(),
    c.env.DB.prepare(countSql).bind(...search.bindings, ...sampleFilters.bindings, ...matchingRunBindings).first<{
      all_count: number;
      active_count?: number;
      complete_count?: number;
      cancelled_count?: number;
    }>(),
  ]);
  const d1Duration = performance.now() - d1Started;
  const facets = processingView ? {
    active: Number(countRow?.active_count ?? 0),
    complete: Number(countRow?.complete_count ?? 0),
    cancelled: Number(countRow?.cancelled_count ?? 0),
    all: Number(countRow?.all_count ?? 0),
  } : undefined;
  const total = facets ? facets[filter] : Number(countRow?.all_count ?? 0);
  const serializeStarted = performance.now();
  const payload = {
    samples: result.results.map((row) => sampleSummary(row as never)),
    pagination: paginationMeta(total, page, pageSize),
    ...(facets ? { facets } : {}),
  };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

routes.post("/samples", async (c) => {
  const validation = validateCreateSampleInput(await c.req.json<unknown>().catch(() => null));
  if (!validation.ok) throw new HTTPException(400, { message: validation.error });
  const input = validation.input;
  const code = input.code.trim();
  const title = input.title.trim();

  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const status = input.status ?? DEFAULT_SAMPLE_STATUS;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO samples (id, code, title, description, status, location, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, code, title, input.description?.trim() || null, status, input.location?.trim() || null, userEmail, userEmail, now, now),
      c.env.DB.prepare(
        "INSERT INTO events (id, sample_id, kind, body, actor_email, created_at) VALUES (?, ?, 'created', ?, ?, ?)",
      ).bind(eventId, id, `Sample ${code} created`, userEmail, now),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: `Sample code ${code} already exists` });
    throw error;
  }
  return c.json({ id }, 201);
});

routes.post("/samples/:id/split", async (c) => {
  const parentId = c.req.param("id");
  const input = await c.req.json<SplitSampleInput>();
  if (!input || typeof input.expectedUpdatedAt !== "string"
    || (input.parentStatusAfter !== "active" && input.parentStatusAfter !== "consumed")
    || !Array.isArray(input.pieces) || input.pieces.length < 1 || input.pieces.length > MAX_SPLIT_PIECES) {
    throw new HTTPException(400, { message: `A split requires 1–${MAX_SPLIT_PIECES} valid pieces and a parent status` });
  }

  const pieces = input.pieces.map((piece) => {
    if (!piece || typeof piece !== "object" || typeof piece.code !== "string" || typeof piece.title !== "string"
      || typeof piece.location !== "string" || !isSampleStatus(piece.status)
      || (piece.description !== undefined && typeof piece.description !== "string")) {
      throw new HTTPException(400, { message: "Every split piece needs valid sample fields" });
    }
    const normalized = {
      code: piece.code.trim(),
      title: piece.title.trim(),
      description: piece.description?.trim() || null,
      location: piece.location.trim(),
      status: piece.status,
    };
    if (!normalized.code || !normalized.title || !normalized.location) {
      throw new HTTPException(400, { message: "Every split piece needs a code, sample name, and location" });
    }
    if (normalized.code.length > 100 || normalized.title.length > 200 || (normalized.description?.length ?? 0) > 10_000 || normalized.location.length > 500) {
      throw new HTTPException(400, { message: "One or more split-piece fields are too long" });
    }
    return normalized;
  });
  const normalizedCodes = pieces.map((piece) => piece.code.toLocaleLowerCase());
  if (new Set(normalizedCodes).size !== normalizedCodes.length) {
    throw new HTTPException(409, { message: "Every new piece must have a unique sample code" });
  }

  const [parent, parentStructure] = await Promise.all([
    c.env.DB.prepare(
      "SELECT code, updated_at FROM samples WHERE id = ? AND deleted_at IS NULL",
    ).bind(parentId).first<{ code: string; updated_at: string }>(),
    loadCurrentSampleStructure(c.env.DB, parentId),
  ]);
  if (!parent) throw new HTTPException(404, { message: "Parent sample not found" });
  if (parent.updated_at !== input.expectedUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before splitting." });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const children = pieces.map((piece) => ({ ...piece, id: crypto.randomUUID() }));
  const inherited = await prepareSplitInheritedState(c.env.DB, parentId, input.expectedUpdatedAt, parentStructure, now);
  const statements: D1PreparedStatement[] = [...inherited.statements];
  for (const child of children) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO samples
          (id, code, title, description, status, location, parent_id, inherited_state_hash,
           created_by, updated_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, id, ?, ?, ?, ?, ?
         FROM samples WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
           AND ${inherited.guardSql}`,
      ).bind(child.id, child.code, child.title, child.description, child.status, child.location,
        inherited.stateHash, userEmail, userEmail, now, now, parentId, input.expectedUpdatedAt, ...inherited.guardBindings),
      c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, id, 'created', ?, ?, ?, ? FROM samples
         WHERE id = ? AND parent_id = ? AND deleted_at IS NULL`,
      ).bind(
        crypto.randomUUID(), `Created by splitting parent ${parent.code}`,
        JSON.stringify({
          action: "created_by_split",
          parentId,
          parentCode: parent.code,
          inheritedStateHash: inherited.stateHash,
        }), userEmail, now, child.id, parentId,
      ),
    );
  }
  const childCodes = children.map((child) => child.code);
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, id, 'status', ?, ?, ?, ? FROM samples
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
         AND ${inherited.guardSql}`,
    ).bind(
      crypto.randomUUID(), `Split into ${children.length} child samples: ${childCodes.join(", ")}`,
      JSON.stringify({ action: "sample_split", childIds: children.map((child) => child.id), childCodes, parentStatusAfter: input.parentStatusAfter }),
      userEmail, now, parentId, input.expectedUpdatedAt, ...inherited.guardBindings,
    ),
    c.env.DB.prepare(
      `UPDATE samples SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
         AND ${inherited.guardSql}`,
    ).bind(input.parentStatusAfter, userEmail, mutationId, now, parentId, input.expectedUpdatedAt, ...inherited.guardBindings),
  );

  try {
    const results = await c.env.DB.batch(statements);
    if (!results.at(-1)?.meta.changes) {
      throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before splitting." });
    }
    if (results.slice(inherited.statements.length).some((result) => !result.meta.changes)) throw new Error("The complete split audit trail was not created");
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: "One or more generated sample codes already exist" });
    throw error;
  }
  return c.json({ children: children.map(({ id, code }) => ({ id, code })), updatedAt: now }, 201);
});

routes.get("/samples/:id", async (c) => {
  const id = c.req.param("id");
  const processingView = c.req.query("view") === "processing";
  const [
    sample,
    children,
    events,
    runRows,
    runAssetRows,
    runInitialAssetRows,
    runCommentRows,
    verificationRows,
    verificationStepRows,
    commentSubmissionRows,
    commentSubmissionItemRows,
    commentSubmissionTargetRows,
  ] = await Promise.all([
    c.env.DB.prepare(
      `WITH sample_overview AS (${sampleOverviewSelect})
       SELECT s.*, p.id AS p_id, p.code AS p_code, p.title AS p_title
       FROM sample_overview s
       LEFT JOIN samples p ON p.id = s.parent_id AND p.deleted_at IS NULL
       WHERE s.id = ?`,
    ).bind(id).first<Record<string, unknown>>(),
    processingView
      ? Promise.resolve({ results: [] })
      : c.env.DB.prepare(
        "SELECT id, code, title FROM samples WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at",
      ).bind(id).all(),
    processingView
      ? Promise.resolve({ results: [] })
      : c.env.DB.prepare("SELECT * FROM events WHERE sample_id = ? ORDER BY created_at DESC").bind(id).all(),
    c.env.DB.prepare(
      `SELECT r.id AS run_id, r.recipe_family_id, r.template_version_id, r.run_kind,
              r.status AS run_status,
              r.created_at AS run_created_at, r.completed_at,
              r.current_plan_revision_id, COALESCE(rpr.revision_no, 1) AS plan_revision_no,
              r.predecessor_run_id, r.anchor_step_id, r.sequence_no, r.run_group_id,
              r.initial_state_hash,
              CASE WHEN r.run_kind = 'metrology' THEN r.template_name_snapshot
                   ELSE COALESCE(ptv.name, r.template_name_snapshot) END AS template_name,
              COALESCE(ptv.template_type, r.template_type_snapshot) AS template_type,
              COALESCE(ptv.version, r.template_version_snapshot) AS template_version,
              COALESCE(ptv.id, r.template_version_id) AS current_template_version_id,
              rs.id AS step_id, rs.template_step_id, rs.logical_step_key, rs.definition_hash,
              rs.expected_state_hash, rs.position, current_ts.position AS plan_position,
              COALESCE(rs.title, sd.name) AS step_title,
              rs.status AS step_status, rs.notes, rs.updated_at AS step_updated_at,
              rs.origin, rs.entry_kind, rs.plan_status,
              COALESCE(rs.tool_name, sd.tool_name) AS tool_name,
              COALESCE(rs.parameters_text, sd.parameters_text) AS parameters_text,
              COALESCE(rs.comments_text, sd.comments_text) AS comments_text,
              rs.deviation_note, rs.actualized_at,
              CASE WHEN current_link.run_step_id IS NOT NULL
                   THEN current_ts.section_name
                   ELSE original_ts.section_name END AS planned_section_name,
              CASE WHEN current_ts.id IS NOT NULL THEN current_sd.name ELSE sd.name END AS planned_title,
              CASE WHEN current_ts.id IS NOT NULL THEN current_sd.tool_name ELSE sd.tool_name END AS planned_tool_name,
              CASE WHEN current_ts.id IS NOT NULL THEN current_sd.parameters_text ELSE sd.parameters_text END AS planned_parameters_text,
              CASE WHEN current_ts.id IS NOT NULL THEN current_sd.comments_text ELSE sd.comments_text END AS planned_comments_text,
              rs.created_at AS step_created_at
       FROM runs r
       LEFT JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id
       LEFT JOIN template_versions ptv ON ptv.id = rpr.template_version_id
       LEFT JOIN run_steps rs ON rs.run_id = r.id AND rs.deleted_at IS NULL
       LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
       LEFT JOIN template_steps original_ts ON original_ts.id = rs.template_step_id
       LEFT JOIN run_step_plan_links current_link
         ON current_link.run_plan_revision_id = r.current_plan_revision_id
        AND current_link.run_step_id = rs.id
       LEFT JOIN template_steps current_ts ON current_ts.id = current_link.template_step_id
       LEFT JOIN step_definitions current_sd ON current_sd.hash = current_ts.definition_hash
       WHERE r.sample_id = ? AND r.deleted_at IS NULL
       ORDER BY r.sequence_no DESC, rs.position ASC`,
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT run_step_id, role, r2_key FROM (
         SELECT rs.id AS run_step_id, 'planned' AS role, a.r2_key, sra.position, a.created_at
         FROM run_steps rs
         JOIN runs r ON r.id = rs.run_id
         LEFT JOIN run_step_plan_links current_link
           ON current_link.run_plan_revision_id = r.current_plan_revision_id
          AND current_link.run_step_id = rs.id
         LEFT JOIN template_steps current_ts ON current_ts.id = current_link.template_step_id
         JOIN state_representation_assets sra ON sra.state_hash =
           CASE WHEN current_ts.id IS NOT NULL THEN current_ts.expected_state_hash ELSE rs.expected_state_hash END
         JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
         WHERE r.sample_id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         UNION ALL
         SELECT rsa.run_step_id, 'execution' AS role, a.r2_key, rsa.position, rsa.created_at
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         WHERE r.sample_id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
       ) ORDER BY run_step_id, role, position, created_at`,
    ).bind(id, id).all<{ run_step_id: string; role: "planned" | "execution"; r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT r.id AS run_id, a.r2_key
       FROM runs r
       JOIN state_representation_assets sra ON sra.state_hash = r.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE r.sample_id = ? AND r.deleted_at IS NULL
       ORDER BY r.sequence_no DESC, sra.position, a.id`,
    ).bind(id).all<{ run_id: string; r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, rsc.scope, rsc.operation_group_id,
              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body ELSE cs.body END AS body,
              ca.r2_key AS asset_key, rsc.submission_id, rsc.actor_email, rsc.created_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id
       LEFT JOIN assets ca ON ca.id = rsc.asset_id AND ca.status = 'ready'
         AND rsc.asset_deleted_at IS NULL
       WHERE r.sample_id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND rsc.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR (cs.status = 'ready' AND cs.deleted_at IS NULL)
         )
       ORDER BY rsc.created_at, rsc.id`,
    ).bind(id).all<{
      id: string; run_step_id: string; scope: "common" | "individual";
      operation_group_id: string | null; body: string; asset_key: string | null;
      submission_id: string | null; actor_email: string | null; created_at: string;
    }>(),
    c.env.DB.prepare(
      `SELECT sv.* FROM state_verifications sv
       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
       JOIN runs endpoint_run ON endpoint_run.id = endpoint.run_id
       WHERE sv.sample_id = ? AND endpoint_run.deleted_at IS NULL
         AND endpoint.deleted_at IS NULL
       ORDER BY sv.created_at, sv.id`,
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT svs.verification_id, svs.run_step_id, svs.ordinal
       FROM state_verification_steps svs
       JOIN state_verifications sv ON sv.id = svs.verification_id
       JOIN run_steps covered_step ON covered_step.id = svs.run_step_id
       JOIN runs covered_run ON covered_run.id = covered_step.run_id
       WHERE sv.sample_id = ? AND covered_run.deleted_at IS NULL
         AND covered_step.deleted_at IS NULL
       ORDER BY sv.created_at, svs.ordinal`,
    ).bind(id).all<{ verification_id: string; run_step_id: string; ordinal: number }>(),
    c.env.DB.prepare(
      `SELECT DISTINCT cs.*
       FROM comment_submissions cs
       LEFT JOIN comment_submission_targets cst ON cst.submission_id = cs.id
       WHERE cs.deleted_at IS NULL AND (cs.sample_id = ? OR cst.sample_id = ?)
       ORDER BY cs.created_at, cs.id`,
    ).bind(id, id).all<CommentSubmissionRow>(),
    c.env.DB.prepare(
      `SELECT DISTINCT csi.*, a.r2_key AS asset_key
       FROM comment_submission_items csi
       JOIN comment_submissions cs ON cs.id = csi.submission_id
       LEFT JOIN comment_submission_targets cst ON cst.submission_id = cs.id
       LEFT JOIN assets a ON a.id = csi.asset_id AND a.status = 'ready'
       WHERE cs.deleted_at IS NULL AND csi.deleted_at IS NULL
         AND (cs.sample_id = ? OR cst.sample_id = ?)
       ORDER BY csi.submission_id, csi.position`,
    ).bind(id, id).all<CommentSubmissionItemRow>(),
    c.env.DB.prepare(
      `SELECT cst.submission_id, cst.run_step_id
       FROM comment_submission_targets cst
       JOIN comment_submissions cs ON cs.id = cst.submission_id
       JOIN run_steps rs ON rs.id = cst.run_step_id
       JOIN runs r ON r.id = rs.run_id
       WHERE cst.sample_id = ? AND cs.status <> 'cancelled'
         AND cs.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       ORDER BY cs.created_at, cst.run_step_id`,
    ).bind(id).all<{ submission_id: string; run_step_id: string }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const parent = sample.p_id
    ? { id: String(sample.p_id), code: String(sample.p_code), title: String(sample.p_title) }
    : null;
  const coverageByVerification = new Map<string, string[]>();
  const verificationIdsByStep = new Map<string, string[]>();
  for (const row of verificationStepRows.results) {
    coverageByVerification.set(row.verification_id, [...(coverageByVerification.get(row.verification_id) ?? []), row.run_step_id]);
    verificationIdsByStep.set(row.run_step_id, [...(verificationIdsByStep.get(row.run_step_id) ?? []), row.verification_id]);
  }
  const stateVerifications = verificationRows.results.map((row) => ({
    id: String(row.id), sampleId: String(row.sample_id), afterRunStepId: String(row.after_run_step_id),
    previousVerificationId: row.previous_verification_id ? String(row.previous_verification_id) : null,
    runPlanRevisionId: row.run_plan_revision_id ? String(row.run_plan_revision_id) : null,
    expectedStateHash: row.expected_state_hash ? String(row.expected_state_hash) : null,
    result: String(row.result), note: row.note ? String(row.note) : null,
    status: String(row.status), actorEmail: row.actor_email ? String(row.actor_email) : null,
    createdAt: String(row.created_at), coveredRunStepIds: coverageByVerification.get(String(row.id)) ?? [],
  }));
  const verificationByEndpoint = new Map(stateVerifications.map((verification) => [verification.afterRunStepId, verification]));
  const runs = new Map<string, Record<string, unknown> & { steps: unknown[] }>();
  const stepAssets = new Map<string, { planned: string[]; execution: string[] }>();
  const initialAssetsByRun = new Map<string, string[]>();
  const stepComments = new Map<string, Array<{
    id: string; scope: "common" | "individual"; operationGroupId: string | null;
    body: string; assetKey: string | null; submissionId: string | null;
    status: "draft" | "uploading" | "ready" | "failed" | "cancelled";
    images: import("../../shared/types").CommentImage[];
    attachments: import("../../shared/types").CommentAttachment[];
    actorEmail: string | null; createdAt: string;
  }>>();
  const submissions = serializeCommentSubmissions(commentSubmissionRows.results, commentSubmissionItemRows.results);
  const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));
  for (const row of runAssetRows.results) {
    const entry = stepAssets.get(row.run_step_id) ?? { planned: [], execution: [] };
    entry[row.role].push(row.r2_key);
    stepAssets.set(row.run_step_id, entry);
  }
  for (const row of runInitialAssetRows.results) {
    initialAssetsByRun.set(row.run_id, [...(initialAssetsByRun.get(row.run_id) ?? []), row.r2_key]);
  }
  for (const row of runCommentRows.results) {
    const entry = stepComments.get(row.run_step_id) ?? [];
    const submission = row.submission_id ? submissionById.get(row.submission_id) : null;
    entry.push({
      id: row.id,
      scope: row.scope,
      operationGroupId: row.operation_group_id,
      body: row.body,
      assetKey: row.asset_key,
      submissionId: row.submission_id,
      status: submission?.status ?? "ready",
      images: submission?.images ?? (row.asset_key ? [{
        id: `legacy:${row.id}`,
        filename: "Comment image",
        mimeType: "image/*",
        byteSize: 0,
        originalFilename: "Comment image",
        originalMimeType: "image/*",
        originalByteSize: 0,
        assetKey: row.asset_key,
        status: "ready",
        error: null,
        relatedAttachmentId: null,
      }] : []),
      attachments: submission?.attachments ?? [],
      actorEmail: row.actor_email,
      createdAt: row.created_at,
    });
    stepComments.set(row.run_step_id, entry);
  }
  for (const target of commentSubmissionTargetRows.results) {
    const submission = submissionById.get(target.submission_id);
    if (!submission || submission.status === "ready" || submission.status === "cancelled") continue;
    const entry = stepComments.get(target.run_step_id) ?? [];
    entry.push({
      id: `submission:${submission.id}:${target.run_step_id}`,
      scope: submission.scope || "individual",
      operationGroupId: submission.scope === "common" ? submission.id : null,
      body: submission.body,
      assetKey: submission.images[0]?.assetKey ?? null,
      submissionId: submission.id,
      status: submission.status,
      images: submission.images,
      attachments: submission.attachments,
      actorEmail: submission.actorEmail,
      createdAt: submission.createdAt,
    });
    stepComments.set(target.run_step_id, entry);
  }
  for (const row of runRows.results) {
    const runId = String(row.run_id);
    if (!runs.has(runId)) runs.set(runId, {
      id: runId, recipeFamilyId: String(row.recipe_family_id),
      templateVersionId: String(row.current_template_version_id),
      templateName: String(row.template_name),
      templateType: String(row.template_type),
      templateVersion: Number(row.template_version),
      runKind: String(row.run_kind),
      status: String(row.run_status),
      currentPlanRevisionId: row.current_plan_revision_id ? String(row.current_plan_revision_id) : null,
      planRevisionNumber: Number(row.plan_revision_no),
      predecessorRunId: row.predecessor_run_id ? String(row.predecessor_run_id) : null,
      anchorStepId: row.anchor_step_id ? String(row.anchor_step_id) : null,
      sequenceNo: Number(row.sequence_no), runGroupId: String(row.run_group_id),
      initialStateHash: row.initial_state_hash ? String(row.initial_state_hash) : null,
      initialStateImageKeys: initialAssetsByRun.get(runId) ?? [],
      createdAt: String(row.run_created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      steps: [],
    });
    if (row.step_id) {
      const stepId = String(row.step_id);
      const images = stepAssets.get(stepId) ?? { planned: [], execution: [] };
      runs.get(runId)!.steps.push({
      id: stepId, templateStepId: row.template_step_id ? String(row.template_step_id) : null,
      logicalStepKey: row.logical_step_key ? String(row.logical_step_key) : null,
      sectionName: row.planned_section_name ? String(row.planned_section_name) : null,
      definitionHash: row.definition_hash ? String(row.definition_hash) : null,
      expectedStateHash: row.expected_state_hash ? String(row.expected_state_hash) : null,
      position: Number(row.position),
      planPosition: row.plan_position === null || row.plan_position === undefined ? null : Number(row.plan_position),
      origin: String(row.origin), entryKind: String(row.entry_kind),
      planStatus: String(row.plan_status), title: String(row.step_title),
      status: String(row.step_status), notes: row.notes ? String(row.notes) : null,
      toolName: row.tool_name ? String(row.tool_name) : null,
      parametersText: row.parameters_text ? String(row.parameters_text) : null,
      commentsText: row.comments_text ? String(row.comments_text) : null,
      deviationNote: row.deviation_note ? String(row.deviation_note) : null,
      plannedTitle: row.planned_title ? String(row.planned_title) : null,
      plannedToolName: row.planned_tool_name ? String(row.planned_tool_name) : null,
      plannedParametersText: row.planned_parameters_text ? String(row.planned_parameters_text) : null,
      plannedCommentsText: row.planned_comments_text ? String(row.planned_comments_text) : null,
      plannedImageKeys: images.planned,
      executionImageKeys: images.execution,
      comments: stepComments.get(stepId) ?? [],
      actualizedAt: row.actualized_at ? String(row.actualized_at) : null,
      verificationIds: verificationIdsByStep.get(stepId) ?? [],
      stateVerification: verificationByEndpoint.get(stepId) ?? null,
      createdAt: String(row.step_created_at),
      updatedAt: String(row.step_updated_at),
    });
    }
  }
  const detail = {
    ...sampleDetail(sample as never),
    runs: [...runs.values()],
    stateVerifications,
    comments: submissions.filter((submission) => submission.contextKind === "sample" && submission.status !== "cancelled"),
  };
  if (processingView) return c.json(detail);
  return c.json({
    ...detail,
    parent,
    children: children.results,
    events: events.results.map((row) => sampleEvent(row as never)),
  });
});

routes.patch("/samples/:id", async (c) => {
  const id = c.req.param("id");
  const validation = validateUpdateSampleInput(await c.req.json<unknown>().catch(() => null));
  if (!validation.ok) throw new HTTPException(400, { message: validation.error });
  const input = validation.input;
  const current = await c.env.DB.prepare(
    `SELECT title, description, status, location, pinned, updated_at
     FROM samples WHERE id = ? AND deleted_at IS NULL`,
  ).bind(id).first<{ title: string; description: string | null; status: SampleStatus; location: string | null; pinned: number; updated_at: string }>();
  if (!current) throw new HTTPException(404, { message: "Sample not found" });
  if (current.updated_at !== input.expectedUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
  }

  const nextTitle = input.title === undefined ? current.title : input.title.trim();
  const nextDescription = input.description === undefined ? current.description : input.description.trim() || null;
  const nextStatus = input.status ?? current.status;
  const nextLocation = input.location === undefined ? current.location : input.location.trim() || null;
  const nextPinned = input.pinned === undefined ? Boolean(current.pinned) : input.pinned;
  const changed = nextTitle !== current.title || nextDescription !== current.description || nextLocation !== current.location || nextStatus !== current.status || nextPinned !== Boolean(current.pinned);
  if (!changed) return c.json({ ok: true, updatedAt: current.updated_at });

  const now = new Date().toISOString();
  const mutationId = crypto.randomUUID();
  const titleAudit = titleChangeAudit(current.title, nextTitle);
  const statements = [c.env.DB.prepare(
    `UPDATE samples SET title = ?, description = ?, status = ?, location = ?, pinned = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
  ).bind(nextTitle, nextDescription, nextStatus, nextLocation, nextPinned ? 1 : 0, c.get("userEmail"), mutationId, now, id, input.expectedUpdatedAt)];
  if (titleAudit) statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, id, 'comment', ?, ?, ?, ? FROM samples
       WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(), titleAudit.body, JSON.stringify(titleAudit.metadata),
      c.get("userEmail"), now, id, mutationId,
    ));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
  }
  if (titleAudit && !results[1]?.meta.changes) throw new Error("Sample title audit event was not created");
  return c.json({ ok: true, updatedAt: now });
});

routes.delete("/samples/:id", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<DeleteSampleInput>().catch(() => null);
  if (!input || typeof input.confirmationCode !== "string" || typeof input.expectedUpdatedAt !== "string") {
    throw new HTTPException(400, { message: "The sample code and current revision are required" });
  }
  const sample = await c.env.DB.prepare(
    `SELECT s.code, s.updated_at,
            (SELECT COUNT(*) FROM runs r WHERE r.sample_id = s.id) AS run_count,
            (SELECT COUNT(*) FROM run_steps rs JOIN runs r ON r.id = rs.run_id WHERE r.sample_id = s.id) AS step_count,
            (SELECT COUNT(*) FROM events e WHERE e.sample_id = s.id) AS event_count,
            (SELECT COUNT(*) FROM state_verifications sv WHERE sv.sample_id = s.id) AS verification_count,
            (SELECT COUNT(*) FROM samples child WHERE child.parent_id = s.id) AS child_count
     FROM samples s WHERE s.id = ? AND s.deleted_at IS NULL`,
  ).bind(id).first<{
    code: string; updated_at: string; run_count: number; step_count: number;
    event_count: number; verification_count: number; child_count: number;
  }>();
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (input.confirmationCode !== sample.code) {
    throw new HTTPException(400, { message: "The confirmation code does not match the sample code" });
  }
  if (input.expectedUpdatedAt !== sample.updated_at) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before deleting." });
  }

  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE samples
     SET deleted_at = ?, deleted_by = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id = ? AND code = ? AND updated_at = ? AND deleted_at IS NULL`,
  ).bind(now, c.get("userEmail"), c.get("userEmail"), crypto.randomUUID(), now,
    id, sample.code, sample.updated_at).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before deleting." });
  }
  return c.json({
    ok: true,
    updatedAt: now,
    deleted: {
      runs: Number(sample.run_count),
      steps: Number(sample.step_count),
      events: Number(sample.event_count),
      verifications: Number(sample.verification_count),
      childrenDetached: 0,
    },
  });
});

routes.post("/samples/:id/restore", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<DeleteSampleInput>().catch(() => null);
  if (!input || typeof input.confirmationCode !== "string" || typeof input.expectedUpdatedAt !== "string") {
    throw new HTTPException(400, { message: "The sample code and current revision are required" });
  }
  const sample = await c.env.DB.prepare(
    "SELECT code, updated_at, deleted_at FROM samples WHERE id = ? AND deleted_at IS NOT NULL",
  ).bind(id).first<{ code: string; updated_at: string; deleted_at: string }>();
  if (!sample) throw new HTTPException(404, { message: "Deleted sample not found" });
  if (input.confirmationCode !== sample.code) {
    throw new HTTPException(400, { message: "The confirmation code does not match the sample code" });
  }
  if (input.expectedUpdatedAt !== sample.updated_at) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before restoring." });
  }
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE samples
     SET deleted_at = NULL, deleted_by = NULL, updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id = ? AND code = ? AND updated_at = ? AND deleted_at = ?`,
  ).bind(c.get("userEmail"), crypto.randomUUID(), now, id, sample.code,
    sample.updated_at, sample.deleted_at).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before restoring." });
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.post("/samples/:id/records", async (c) => {
  const sampleId = c.req.param("id");
  const input = await c.req.json<CreateRecordInput>();
  if (typeof input.expectedUpdatedAt !== "string" || typeof input.location !== "string" || typeof input.pinned !== "boolean" || !isSampleStatus(input.status) || (input.body !== undefined && typeof input.body !== "string") || (input.assetKey !== undefined && typeof input.assetKey !== "string") || (input.thumbnailKey !== undefined && typeof input.thumbnailKey !== "string")) {
    throw new HTTPException(400, { message: "A valid sample state and expectedUpdatedAt are required" });
  }
  const body = input.body?.trim() || null;
  if ((input.body?.length ?? 0) > 10_000 || input.location.length > 500) {
    throw new HTTPException(400, { message: "Record text or location is too long" });
  }
  const assetKey = input.assetKey || null;
  const thumbnailKey = input.thumbnailKey || null;
  if (thumbnailKey && !assetKey) throw new HTTPException(400, { message: "A thumbnail requires a primary asset" });
  const assetKeys = [assetKey, thumbnailKey].filter((key): key is string => Boolean(key));
  if (assetKeys.length) {
    const placeholders = assetKeys.map(() => "?").join(", ");
    const result = await c.env.DB.prepare(
      `SELECT r2_key FROM assets a
       WHERE status = 'ready' AND r2_key IN (${placeholders})
         AND (
           a.import_id IS NULL
           OR EXISTS (
             SELECT 1 FROM imports i
             WHERE i.id = a.import_id AND i.status = 'ready'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         )
         AND NOT EXISTS (
           SELECT 1 FROM blob_integrity_quarantine biq
           WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
             AND biq.object_key = a.r2_key
         )`,
    ).bind(...assetKeys).all<{ r2_key: string }>();
    if (new Set(result.results.map((row) => row.r2_key)).size !== new Set(assetKeys).size) {
      throw new HTTPException(400, { message: "One or more uploaded assets are unavailable" });
    }
  }

  const current = await c.env.DB.prepare(
    "SELECT status, location, pinned, updated_at FROM samples WHERE id = ? AND deleted_at IS NULL",
  ).bind(sampleId).first<{ status: SampleStatus; location: string | null; pinned: number; updated_at: string }>();
  if (!current) throw new HTTPException(404, { message: "Sample not found" });
  if (current.updated_at !== input.expectedUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Review the current state and save again." });
  }
  const location = input.location.trim() || null;
  const detailsChanged = current.status !== input.status || current.location !== location || Boolean(current.pinned) !== input.pinned;
  if (!detailsChanged && !body && !assetKey) throw new HTTPException(400, { message: "The record has no changes" });

  const mutationId = crypto.randomUUID();
  const now = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const statements = [c.env.DB.prepare(
    `UPDATE samples SET status = ?, location = ?, pinned = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
  ).bind(input.status, location, input.pinned ? 1 : 0, userEmail, mutationId, now, sampleId, input.expectedUpdatedAt)];
  if (body || assetKey) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ? FROM samples
     WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL`,
  ).bind(
    crypto.randomUUID(), assetKey ? "image" : "comment", body, assetKey,
    JSON.stringify({ action: "sample_record", ...(thumbnailKey ? { thumbnailKey } : {}) }), userEmail, now, sampleId, mutationId,
  ));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This sample changed elsewhere. Review the current state and save again." });
  if (statements.length > 1 && !results[1].meta.changes) throw new Error("Atomic record event was not created");
  return c.json({ ok: true, updatedAt: now }, 201);
});

routes.delete("/samples/:id/records/:eventId", async (c) => {
  const sampleId = c.req.param("id");
  const eventId = c.req.param("eventId");
  const event = await c.env.DB.prepare(
    "SELECT id, kind, body, asset_key, metadata_json FROM events WHERE id = ? AND sample_id = ?",
  ).bind(eventId, sampleId).first<{ id: string; kind: string; body: string | null; asset_key: string | null; metadata_json: string }>();
  if (!event) throw new HTTPException(404, { message: "Sample record not found" });
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(event.metadata_json || "{}") as Record<string, unknown>; }
  catch { throw new HTTPException(409, { message: "This record cannot be safely deleted" }); }
  if (!isSampleRecordEvent(event.kind, metadata)) throw new HTTPException(400, { message: "Execution history cannot be deleted as a sample comment" });

  const sample = await c.env.DB.prepare(
    "SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL",
  ).bind(sampleId).first<{ updated_at: string }>();
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const { thumbnailKey: _thumbnailKey, ...retainedMetadata } = metadata;
  const deletedSummary = event.body?.trim() || (event.asset_key ? "Photo attachment" : "Empty record");
  const deletionOperationId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE events
       SET asset_key = NULL, metadata_json = ?
       WHERE id = ? AND sample_id = ?
         AND json_extract(metadata_json, '$.deletedAt') IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = events.sample_id AND s.id = ?
             AND s.updated_at = ? AND s.deleted_at IS NULL
         )`,
    ).bind(
      JSON.stringify({
        ...retainedMetadata,
        deletedAt: now,
        deletedBy: userEmail,
        deletionOperationId,
        hadAsset: Boolean(event.asset_key),
      }),
      eventId,
      sampleId,
      sampleId,
      sample.updated_at,
    ),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, source.sample_id, 'comment', ?, ?, ?, ?
       FROM events source
       JOIN samples s ON s.id = source.sample_id
       WHERE source.id = ? AND source.sample_id = ?
         AND json_extract(source.metadata_json, '$.deletionOperationId') = ?
         AND s.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(),
      `Deleted sample record · ${deletedSummary}`,
      JSON.stringify({ action: "sample_record_deleted", originalEventId: eventId, hadAsset: Boolean(event.asset_key) }),
      userEmail,
      now,
      eventId,
      sampleId,
      deletionOperationId,
    ),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM events source
           WHERE source.id = ? AND source.sample_id = samples.id
             AND json_extract(source.metadata_json, '$.deletionOperationId') = ?
         )`,
    ).bind(userEmail, now, sampleId, eventId, deletionOperationId),
  ]);
  if (!results[0].meta.changes || !results[2].meta.changes) {
    throw new HTTPException(409, { message: "The sample record or its Sample changed before deletion" });
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.delete("/samples/:id/events/:eventId/asset", async (c) => {
  const sampleId = c.req.param("id");
  const eventId = c.req.param("eventId");
  const event = await c.env.DB.prepare(
    "SELECT id, kind, body, asset_key, metadata_json FROM events WHERE id = ? AND sample_id = ?",
  ).bind(eventId, sampleId).first<{ id: string; kind: string; body: string | null; asset_key: string | null; metadata_json: string }>();
  if (!event) throw new HTTPException(404, { message: "Timeline entry not found" });
  if (!event.asset_key) throw new HTTPException(409, { message: "This image attachment was already deleted" });
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(event.metadata_json || "{}") as Record<string, unknown>; }
  catch { throw new HTTPException(409, { message: "This image attachment cannot be safely deleted" }); }

  const sourceAction = typeof metadata.action === "string" ? metadata.action : null;
  const operationGroupId = typeof metadata.operationGroupId === "string" ? metadata.operationGroupId : null;
  const verificationId = typeof metadata.verificationId === "string" ? metadata.verificationId : null;
  const stepId = typeof metadata.stepId === "string" ? metadata.stepId : null;
  const runId = typeof metadata.runId === "string" ? metadata.runId : null;
  const eventRunStepAssetId = typeof metadata.runStepAssetId === "string" ? metadata.runStepAssetId : null;
  if (runId) {
    const liveRun = await c.env.DB.prepare(
      "SELECT id FROM runs WHERE id = ? AND sample_id = ? AND deleted_at IS NULL",
    ).bind(runId, sampleId).first<{ id: string }>();
    if (!liveRun) throw new HTTPException(404, { message: "Active timeline source not found" });
  }
  let executionOccurrenceId: string | null = null;
  if (stepId && runId && event.kind === "image") {
    const occurrences = eventRunStepAssetId
      ? (await c.env.DB.prepare(
        `SELECT rsa.id
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsa.id = ? AND rsa.run_step_id = ? AND rsa.role = 'execution'
           AND a.r2_key = ? AND rs.id = ? AND r.id = ? AND s.id = ?
           AND rsa.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND r.deleted_at IS NULL AND s.deleted_at IS NULL`,
      ).bind(
        eventRunStepAssetId, stepId, event.asset_key,
        stepId, runId, sampleId,
      ).all<{ id: string }>()).results
      : (await c.env.DB.prepare(
        `SELECT rsa.id
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsa.run_step_id = ? AND rsa.role = 'execution' AND a.r2_key = ?
           AND rs.id = ? AND r.id = ? AND s.id = ?
           AND rsa.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND r.deleted_at IS NULL AND s.deleted_at IS NULL`,
      ).bind(stepId, event.asset_key, stepId, runId, sampleId).all<{ id: string }>()).results;
    if (occurrences.length !== 1) {
      throw new HTTPException(409, { message: "This execution image no longer identifies one attachment occurrence" });
    }
    executionOccurrenceId = occurrences[0].id;
  }
  const affectedEvents = operationGroupId && sourceAction === "step_comment"
    ? (await c.env.DB.prepare(
      `SELECT id, sample_id FROM events
       WHERE kind = 'step' AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.action') = 'step_comment'
         AND json_extract(metadata_json, '$.operationGroupId') = ?
         AND asset_key = ?
       ORDER BY id`,
    ).bind(operationGroupId, event.asset_key).all<{ id: string; sample_id: string }>()).results
    : executionOccurrenceId && stepId && runId && event.kind === "image"
      ? (await c.env.DB.prepare(
        `SELECT id, sample_id
         FROM events
         WHERE sample_id = ? AND kind = 'image' AND asset_key = ? AND json_valid(metadata_json)
           AND (
             json_extract(metadata_json, '$.runStepAssetId') = ?
             OR (
               json_extract(metadata_json, '$.runStepAssetId') IS NULL
               AND json_extract(metadata_json, '$.runId') = ?
               AND json_extract(metadata_json, '$.stepId') = ?
             )
           )
         ORDER BY id`,
      ).bind(
        sampleId, event.asset_key, executionOccurrenceId, runId, stepId,
      ).all<{ id: string; sample_id: string }>()).results
    : [{ id: eventId, sample_id: sampleId }];
  const affectedSampleIds = [...new Set(affectedEvents.map((row) => row.sample_id))];
  if (!affectedEvents.length) {
    throw new HTTPException(409, { message: "This image attachment was already deleted" });
  }
  if (operationGroupId && sourceAction === "step_comment") {
    await requireVisibleCommentOperationGroup(c.env.DB, operationGroupId);
  }
  const sampleRows = await c.env.DB.prepare(
    `SELECT id, updated_at FROM samples
     WHERE id IN (${affectedSampleIds.map(() => "?").join(", ")}) AND deleted_at IS NULL`,
  ).bind(...affectedSampleIds).all<{ id: string; updated_at: string }>();
  if (sampleRows.results.length !== affectedSampleIds.length) {
    throw new HTTPException(404, { message: "Sample not found" });
  }
  const latestUpdate = Math.max(...sampleRows.results.map((row) => Date.parse(row.updated_at)).filter(Number.isFinite));
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const deletionOperationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  const affectedEventIds = affectedEvents.map((row) => row.id);
  const affectedEventPlaceholders = affectedEventIds.map(() => "?").join(", ");

  if (sourceAction === "step_comment" && operationGroupId) {
    statements.push(c.env.DB.prepare(
      `WITH valid_events AS MATERIALIZED (
         SELECT id FROM events
         WHERE id IN (${affectedEventPlaceholders})
           AND kind = 'step' AND asset_key = ? AND json_valid(metadata_json)
           AND json_extract(metadata_json, '$.action') = 'step_comment'
           AND json_extract(metadata_json, '$.operationGroupId') = ?
       ),
       valid_comments AS MATERIALIZED (
         SELECT rsc.id
         FROM run_step_comments rsc
         JOIN run_steps rs ON rs.id = rsc.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsc.operation_group_id = ?
           AND rsc.asset_id = (SELECT id FROM assets WHERE r2_key = ?)
           AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NULL
           AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND (
             rsc.submission_id IS NULL
             OR EXISTS (
               SELECT 1 FROM comment_submissions cs
               WHERE cs.id = rsc.submission_id
                 AND cs.status = 'ready' AND cs.deleted_at IS NULL
             )
           )
       )
       UPDATE events
       SET asset_key = NULL,
           metadata_json = json_set(
             metadata_json,
             '$.assetDeletedAt', ?,
             '$.assetDeletedBy', ?,
             '$.assetDeletionOperationId', ?
           )
       WHERE id IN (SELECT id FROM valid_events)
         AND (SELECT COUNT(*) FROM valid_events) = ?
         AND EXISTS (SELECT 1 FROM valid_comments)
         AND (
           SELECT COUNT(*) FROM valid_comments
         ) = (
           SELECT COUNT(*) FROM run_step_comments
           WHERE operation_group_id = ?
             AND asset_id = (SELECT id FROM assets WHERE r2_key = ?)
             AND deleted_at IS NULL AND asset_deleted_at IS NULL
         )`,
    ).bind(
      ...affectedEventIds,
      event.asset_key,
      operationGroupId,
      operationGroupId,
      event.asset_key,
      now,
      userEmail,
      deletionOperationId,
      affectedEventIds.length,
      operationGroupId,
      event.asset_key,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE run_step_comments
       SET asset_deleted_at = ?, asset_deleted_by = ?,
           asset_deletion_operation_id = ?, last_mutation_id = ?
       WHERE operation_group_id = ?
         AND asset_id = (SELECT id FROM assets WHERE r2_key = ?)
         AND deleted_at IS NULL AND asset_deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM events source
           WHERE source.id IN (${affectedEventPlaceholders})
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         ) = ?`,
    ).bind(
      now,
      userEmail,
      deletionOperationId,
      deletionOperationId,
      operationGroupId,
      event.asset_key,
      ...affectedEventIds,
      deletionOperationId,
      affectedEventIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (
         SELECT run_step_id FROM run_step_comments
         WHERE operation_group_id = ? AND last_mutation_id = ?
       )
         AND deleted_at IS NULL`,
    ).bind(userEmail, now, operationGroupId, deletionOperationId));
  } else if (verificationId && event.kind === "verification") {
    statements.push(c.env.DB.prepare(
      `UPDATE events SET asset_key = NULL,
         metadata_json = json_set(
           metadata_json, '$.assetDeletedAt', ?, '$.assetDeletedBy', ?,
           '$.assetDeletionOperationId', ?
         )
       WHERE id = ? AND sample_id = ? AND asset_key = ?
         AND EXISTS (
           SELECT 1
           FROM state_verifications sv
           JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
           JOIN runs r ON r.id = endpoint.run_id
           JOIN samples s ON s.id = sv.sample_id
           WHERE sv.id = ? AND sv.sample_id = ?
             AND sv.evidence_asset_id = (SELECT id FROM assets WHERE r2_key = ?)
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL
             AND endpoint.deleted_at IS NULL
         )`,
    ).bind(
      now, userEmail, deletionOperationId,
      eventId, sampleId, event.asset_key,
      verificationId, sampleId, event.asset_key,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE state_verifications SET evidence_asset_id = NULL
       WHERE id = ? AND sample_id = ?
         AND evidence_asset_id = (SELECT id FROM assets WHERE r2_key = ?)
         AND EXISTS (
           SELECT 1 FROM events source
           WHERE source.id = ? AND source.sample_id = ?
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         )`,
    ).bind(
      verificationId, sampleId, event.asset_key,
      eventId, sampleId, deletionOperationId,
    ));
  } else if (stepId && runId && event.kind === "image" && executionOccurrenceId) {
    statements.push(c.env.DB.prepare(
      `WITH candidate_events AS MATERIALIZED (
         SELECT id
         FROM events
         WHERE sample_id = ? AND kind = 'image' AND asset_key = ? AND json_valid(metadata_json)
           AND (
             json_extract(metadata_json, '$.runStepAssetId') = ?
             OR (
               json_extract(metadata_json, '$.runStepAssetId') IS NULL
               AND json_extract(metadata_json, '$.runId') = ?
               AND json_extract(metadata_json, '$.stepId') = ?
             )
           )
       ),
       valid_occurrence AS MATERIALIZED (
         SELECT rsa.id
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsa.id = ? AND rsa.run_step_id = ? AND rsa.role = 'execution'
           AND a.r2_key = ? AND rs.id = ? AND r.id = ? AND s.id = ?
           AND rsa.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND r.deleted_at IS NULL AND s.deleted_at IS NULL
       )
       UPDATE events SET asset_key = NULL,
         metadata_json = json_set(
           metadata_json, '$.runStepAssetId', ?,
           '$.assetDeletedAt', ?, '$.assetDeletedBy', ?,
           '$.assetDeletionOperationId', ?
         )
       WHERE id IN (SELECT id FROM candidate_events)
         AND (SELECT COUNT(*) FROM candidate_events) = ?
         AND EXISTS (SELECT 1 FROM valid_occurrence)`,
    ).bind(
      sampleId, event.asset_key, executionOccurrenceId, runId, stepId,
      executionOccurrenceId, stepId, event.asset_key, stepId, runId, sampleId,
      executionOccurrenceId, now, userEmail, deletionOperationId,
      affectedEventIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE run_step_assets
       SET deleted_at = ?, deleted_by = ?, last_mutation_id = ?
       WHERE id = ? AND run_step_id = ? AND deleted_at IS NULL
         AND asset_id = (SELECT id FROM assets WHERE r2_key = ?)
         AND (
           SELECT COUNT(*) FROM events source
           WHERE source.sample_id = ? AND source.kind = 'image'
             AND json_valid(source.metadata_json)
             AND json_extract(source.metadata_json, '$.runStepAssetId') = ?
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         ) = ?`,
    ).bind(
      now, userEmail, deletionOperationId,
      executionOccurrenceId, stepId, event.asset_key,
      sampleId, executionOccurrenceId, deletionOperationId, affectedEventIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.run_step_id = run_steps.id
             AND rsa.last_mutation_id = ?
         )`,
    ).bind(
      userEmail, now, stepId, runId,
      executionOccurrenceId, deletionOperationId,
    ));
  } else if (isSampleRecordEvent(event.kind, metadata)) {
    const { thumbnailKey: _thumbnailKey, ...retainedMetadata } = metadata;
    statements.push(c.env.DB.prepare(
      `UPDATE events SET asset_key = NULL, metadata_json = ?
       WHERE id = ? AND sample_id = ? AND asset_key = ?
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = events.sample_id AND s.deleted_at IS NULL
         )`,
    ).bind(
      JSON.stringify({
        ...retainedMetadata,
        assetDeletedAt: now,
        assetDeletedBy: userEmail,
        assetDeletionOperationId: deletionOperationId,
      }),
      eventId,
      sampleId,
      event.asset_key,
    ));
  } else {
    throw new HTTPException(400, { message: "This timeline image is not a removable attachment" });
  }

  for (const affectedSampleId of affectedSampleIds) {
    const sampleEventIds = affectedEvents
      .filter((row) => row.sample_id === affectedSampleId)
      .map((row) => row.id);
    if (executionOccurrenceId) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, ?, 'comment', ?, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM events source
           WHERE source.sample_id = ? AND source.kind = 'image'
             AND json_valid(source.metadata_json)
             AND json_extract(source.metadata_json, '$.runStepAssetId') = ?
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         ) = ?`,
      ).bind(
        crypto.randomUUID(), affectedSampleId, `Deleted image attachment · ${event.body?.trim() || "Image"}`,
        JSON.stringify({ action: "image_attachment_deleted", originalEventId: eventId, sourceAction, hadAsset: true }),
        userEmail, now,
        affectedSampleId, executionOccurrenceId, deletionOperationId, sampleEventIds.length,
      ));
      statements.push(c.env.DB.prepare(
        `UPDATE samples SET updated_by = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL
           AND (
             SELECT COUNT(*) FROM events source
             WHERE source.sample_id = samples.id AND source.kind = 'image'
               AND json_valid(source.metadata_json)
               AND json_extract(source.metadata_json, '$.runStepAssetId') = ?
               AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
           ) = ?`,
      ).bind(
        userEmail, now, affectedSampleId,
        executionOccurrenceId, deletionOperationId, sampleEventIds.length,
      ));
      continue;
    }
    const sampleEventPlaceholders = sampleEventIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'comment', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM events source
         WHERE source.id IN (${sampleEventPlaceholders})
           AND source.sample_id = ?
           AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
       ) = ?`,
    ).bind(
      crypto.randomUUID(), affectedSampleId, `Deleted image attachment · ${event.body?.trim() || "Image"}`,
      JSON.stringify({ action: "image_attachment_deleted", originalEventId: eventId, sourceAction, hadAsset: true }),
      userEmail, now,
      ...sampleEventIds,
      affectedSampleId,
      deletionOperationId,
      sampleEventIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM events source
           WHERE source.id IN (${sampleEventPlaceholders})
             AND source.sample_id = samples.id
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         ) = ?`,
    ).bind(
      userEmail,
      now,
      affectedSampleId,
      ...sampleEventIds,
      deletionOperationId,
      sampleEventIds.length,
    ));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].meta.changes !== affectedEventIds.length) {
    throw new HTTPException(409, { message: "The image attachment source changed before deletion" });
  }
  return c.json({ ok: true, updatedAt: now });
});

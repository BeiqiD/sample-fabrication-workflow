import { nativeAssetUrl } from "../../shared/contracts/r2-upload";
import { HTTPException } from "hono/http-exception";
import { isSampleStatus, type FileAssetMediaRef, type SampleDirectorySort } from "../../shared/types";
import { sampleDetail, sampleEvent, sampleSummary } from "../serializers";
import { escapedLikePattern } from "../request-guards";
import { directoryFilterValue, likeBindings, paginationMeta, processingDirectoryFilter, readPagination, repeatedLikeSql, sampleDirectorySort, searchTokens } from "../directory-query";
import { serializeCommentSubmissions } from "../comment-submission-serialization";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import type { ReadSqlDatabase } from "../runtime/read-sql";
import { sampleCommentSubmissionItemRow, sampleCommentSubmissionRow, sampleCommentTargetRow, sampleEventRow, sampleIdentityRow, sampleReadDecimal, sampleReadText, sampleRunAssetRow, sampleRunCommentRow, sampleRunInitialAssetRow, sampleSerializerRow, sampleVerificationStepRow } from "./read-decoding";

/** Fixed Samples SELECT projections over exact cells; write methods are not exposed. */
export type SampleReadDatabase = ReadSqlDatabase;
export interface SampleReadDependencies {
  database(): SampleReadDatabase;
  /** The trusted composer checks this request's current account/read fence.
   * Reads do not acquire a File execution/write lease. */
  admit(actor: string): Promise<void>;
}
export type SampleReadQuery = (key: string) => string | undefined;

async function sampleHasFileBindings(db: SampleReadDatabase): Promise<boolean> {
  // Retained pre-File databases do not have these columns. Inspect the actual
  // schema before preparing either query shape; partial upgrades fail closed.
  const schema = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sqlite_schema
       WHERE type = 'table' AND name = 'file_authority_control') AS authority_tables,
      (SELECT COUNT(*) FROM pragma_table_info('run_step_assets') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('state_representation_assets') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('run_step_comments') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('events') WHERE name IN ('asset_file_id', 'thumbnail_file_id')) AS file_columns
  `).first();
  try {
    const tables = configurationSqlInteger(schema?.authority_tables, "sample.authority_tables");
    const columns = configurationSqlInteger(schema?.file_columns, "sample.file_columns");
    if (tables === 0 && columns === 0) return false;
    if (tables === 1 && columns === 5) return true;
  } catch { /* Invalid/partial schema metadata fails with the existing 503. */ }
  throw new HTTPException(503, { message: "Sample File metadata is unavailable" });
}

const sampleOverviewSelect = (hasFileBindings: boolean) => `
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
               SELECT json_object('assetId',a.id,'fileId',${hasFileBindings ? "rsa.file_id" : "NULL"},'key',a.r2_key)
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
               SELECT json_object('assetId',a.id,'fileId',${hasFileBindings ? "sra.file_id" : "NULL"},'key',a.r2_key)
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
         ) AS current_state_thumbnail_json
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

/** Existing directory/detail SQL and wire projections, without provider I/O. */
export function createSampleReadService(dependencies: SampleReadDependencies) {
  return {
    async directoryOptions(actor: string) {
      await dependencies.admit(actor);
      const db = dependencies.database();
      const d1Started = performance.now();
      const [locations, parents, workflows] = await Promise.all([
        db.prepare(
          `SELECT DISTINCT location
       FROM samples
       WHERE deleted_at IS NULL AND location IS NOT NULL AND TRIM(location) <> ''
       ORDER BY location COLLATE NOCASE`,
        ).all(),
        db.prepare(
          `SELECT DISTINCT parent.id, parent.code, parent.title
       FROM samples child
       JOIN samples parent ON parent.id = child.parent_id
       WHERE child.deleted_at IS NULL AND parent.deleted_at IS NULL
       ORDER BY parent.code COLLATE NOCASE, parent.id`,
        ).all(),
        db.prepare(
          `WITH sample_base AS (${sampleDirectoryBaseSelect})
       SELECT DISTINCT latest_workflow_name AS name
       FROM sample_base
       WHERE latest_workflow_name IS NOT NULL AND TRIM(latest_workflow_name) <> ''
       ORDER BY latest_workflow_name COLLATE NOCASE`,
        ).all(),
      ]);
      const d1Duration = performance.now() - d1Started;
      const payload = {
        locations: locations.results.map((row) => sampleReadText(row.location, "location")),
        parents: parents.results.map(sampleIdentityRow),
        workflows: workflows.results.map((row) => sampleReadText(row.name, "workflow.name")),
      };
      await dependencies.admit(actor);
      return { payload, serverTiming: `d1;dur=${d1Duration.toFixed(1)}` };
    },
    async directory(queryValue: SampleReadQuery, actor: string) {
      const query = queryValue("q")?.trim() ?? "";
      const matchingRunFamilyId = queryValue("runFamily")?.trim() ?? "";
      const matchingRunKind = queryValue("runKind")?.trim() ?? "";
      const matchingRunStatus = queryValue("runStatus")?.trim() ?? "";
      const hasMatchingRunFilter = Boolean(matchingRunFamilyId || matchingRunKind || matchingRunStatus);
      if (
        matchingRunFamilyId.length > 200
        || (hasMatchingRunFilter && !matchingRunFamilyId)
        || (hasMatchingRunFilter && !["process", "metrology"].includes(matchingRunKind))
        || (hasMatchingRunFilter && !["active", "complete", "cancelled", "superseded"].includes(matchingRunStatus))
      ) {
        throw new HTTPException(400, { message: "Invalid matching-run filter" });
      }
      await dependencies.admit(actor);
      const db = dependencies.database();
      const processingView = queryValue("view") === "processing";
      const hasFileBindings = processingView ? await sampleHasFileBindings(db) : false;
      const filter = processingDirectoryFilter(queryValue("status"));
      const { page, pageSize, offset } = readPagination(queryValue("page"), queryValue("pageSize"));
      const search = sampleDirectorySearch(query);
      const sampleFilters = sampleDirectoryFilters({
        status: processingView ? "" : directoryFilterValue(queryValue("status")),
        location: processingView ? "" : directoryFilterValue(queryValue("location")),
        parent: processingView ? "" : directoryFilterValue(queryValue("parent")),
        workflow: processingView ? "" : directoryFilterValue(queryValue("process")),
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
      const sort = sampleDirectorySort(queryValue("sort"), searchTerms.length > 0);
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
             SELECT json_object('assetId',a.id,'fileId',${hasFileBindings ? "rsa.file_id" : "NULL"},'key',a.r2_key)
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
             SELECT json_object('assetId',a.id,'fileId',${hasFileBindings ? "sra.file_id" : "NULL"},'key',a.r2_key)
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
         ) AS current_state_thumbnail_json` : `,
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
       FROM sample_base WHERE ${search.sql}${matchingRunFilterSql}`
        : `WITH sample_base AS (${sampleDirectoryBaseSelect})
       SELECT COUNT(*) AS all_count FROM sample_base WHERE ${search.sql} AND ${filterSql}`;
      const d1Started = performance.now();
      const [result, countRow] = await Promise.all([
        db.prepare(pageSql).bind(...search.bindings, ...sampleFilters.bindings, ...matchingRunBindings, ...ordering.bindings, pageSize, offset, ...ordering.bindings).all(),
        db.prepare(countSql).bind(...search.bindings, ...sampleFilters.bindings, ...matchingRunBindings).first(),
      ]);
      const d1Duration = performance.now() - d1Started;
      const facets = processingView ? {
        active: configurationSqlInteger(countRow?.active_count ?? 0, "sample.active_count"),
        complete: configurationSqlInteger(countRow?.complete_count ?? 0, "sample.complete_count"),
        cancelled: configurationSqlInteger(countRow?.cancelled_count ?? 0, "sample.cancelled_count"),
        all: configurationSqlInteger(countRow?.all_count ?? 0, "sample.all_count"),
      } : undefined;
      const total = facets ? facets[filter] : configurationSqlInteger(countRow?.all_count ?? 0, "sample.all_count");
      const serializeStarted = performance.now();
      const payload = {
        samples: result.results.map((row) => sampleSummary(sampleSerializerRow(row))),
        pagination: paginationMeta(total, page, pageSize),
        ...(facets ? { facets } : {}),
      };
      const serializeDuration = performance.now() - serializeStarted;
      await dependencies.admit(actor);
      return { payload, serverTiming: `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}` };
    },
    async detail(id: string, queryValue: SampleReadQuery, actor: string) {
      await dependencies.admit(actor);
      const db = dependencies.database();
      const processingView = queryValue("view") === "processing";
      const hasFileBindings = await sampleHasFileBindings(db);
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
        db.prepare(
          `WITH sample_overview AS (${sampleOverviewSelect(hasFileBindings)})
       SELECT s.*, p.id AS p_id, p.code AS p_code, p.title AS p_title
       FROM sample_overview s
       LEFT JOIN samples p ON p.id = s.parent_id AND p.deleted_at IS NULL
       WHERE s.id = ?`,
        ).bind(id).first(),
        processingView
          ? Promise.resolve({ results: [] })
          : db.prepare(
            "SELECT id, code, title FROM samples WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at",
          ).bind(id).all(),
        processingView
          ? Promise.resolve({ results: [] })
          : db.prepare("SELECT * FROM events WHERE sample_id = ? ORDER BY created_at DESC").bind(id).all(),
        db.prepare(
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
        ).bind(id).all(),
        db.prepare(
          `SELECT run_step_id, role, r2_key, asset_id, file_id FROM (
         SELECT rs.id AS run_step_id, 'planned' AS role, a.r2_key, a.id AS asset_id, ${hasFileBindings ? "sra.file_id" : "NULL"} AS file_id, sra.position, a.created_at
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
         SELECT rsa.run_step_id, 'execution' AS role, a.r2_key, a.id AS asset_id, ${hasFileBindings ? "rsa.file_id" : "NULL"} AS file_id, rsa.position, rsa.created_at
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         WHERE r.sample_id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
       ) ORDER BY run_step_id, role, position, created_at`,
        ).bind(id, id).all(),
        db.prepare(
          `SELECT r.id AS run_id, a.r2_key, a.id AS asset_id, ${hasFileBindings ? "sra.file_id" : "NULL"} AS file_id
       FROM runs r
       JOIN state_representation_assets sra ON sra.state_hash = r.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE r.sample_id = ? AND r.deleted_at IS NULL
       ORDER BY r.sequence_no DESC, sra.position, a.id`,
        ).bind(id).all(),
        db.prepare(
          `SELECT rsc.id, rsc.run_step_id, rsc.scope, rsc.operation_group_id,
              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body ELSE cs.body END AS body,
              ca.r2_key AS asset_key, ca.id AS asset_id, ${hasFileBindings ? "rsc.file_id" : "NULL"} AS file_id, rsc.submission_id, rsc.actor_email, rsc.created_at
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
        ).bind(id).all(),
        db.prepare(
          `SELECT sv.* FROM state_verifications sv
       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
       JOIN runs endpoint_run ON endpoint_run.id = endpoint.run_id
       WHERE sv.sample_id = ? AND endpoint_run.deleted_at IS NULL
         AND endpoint.deleted_at IS NULL
       ORDER BY sv.created_at, sv.id`,
        ).bind(id).all(),
        db.prepare(
          `SELECT svs.verification_id, svs.run_step_id, svs.ordinal
       FROM state_verification_steps svs
       JOIN state_verifications sv ON sv.id = svs.verification_id
       JOIN run_steps covered_step ON covered_step.id = svs.run_step_id
       JOIN runs covered_run ON covered_run.id = covered_step.run_id
       WHERE sv.sample_id = ? AND covered_run.deleted_at IS NULL
         AND covered_step.deleted_at IS NULL
       ORDER BY sv.created_at, svs.ordinal`,
        ).bind(id).all(),
        db.prepare(
          `SELECT DISTINCT cs.*
       FROM comment_submissions cs
       LEFT JOIN comment_submission_targets cst ON cst.submission_id = cs.id
       WHERE cs.deleted_at IS NULL AND (cs.sample_id = ? OR cst.sample_id = ?)
       ORDER BY cs.created_at, cs.id`,
        ).bind(id, id).all(),
        db.prepare(
          `SELECT DISTINCT csi.*, a.r2_key AS asset_key
       FROM comment_submission_items csi
       JOIN comment_submissions cs ON cs.id = csi.submission_id
       LEFT JOIN comment_submission_targets cst ON cst.submission_id = cs.id
       LEFT JOIN assets a ON a.id = csi.asset_id AND a.status = 'ready'
       WHERE cs.deleted_at IS NULL AND csi.deleted_at IS NULL
         AND (cs.sample_id = ? OR cst.sample_id = ?)
       ORDER BY csi.submission_id, csi.position`,
        ).bind(id, id).all(),
        db.prepare(
          `SELECT cst.submission_id, cst.run_step_id
       FROM comment_submission_targets cst
       JOIN comment_submissions cs ON cs.id = cst.submission_id
       JOIN run_steps rs ON rs.id = cst.run_step_id
       JOIN runs r ON r.id = rs.run_id
       WHERE cst.sample_id = ? AND cs.status <> 'cancelled'
         AND cs.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       ORDER BY cs.created_at, cst.run_step_id`,
        ).bind(id).all(),
      ]);
      if (!sample) throw new HTTPException(404, { message: "Sample not found" });
      const parent = sample.p_id
        ? { id: String(sample.p_id), code: String(sample.p_code), title: String(sample.p_title) }
        : null;
      const coverageByVerification = new Map<string, string[]>();
      const verificationIdsByStep = new Map<string, string[]>();
      for (const row of verificationStepRows.results.map(sampleVerificationStepRow)) {
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
      const stepMedia = new Map<string, { planned: FileAssetMediaRef[]; execution: FileAssetMediaRef[]; native: boolean }>();
      const initialAssetsByRun = new Map<string, string[]>();
      const initialMediaByRun = new Map<string, { refs: FileAssetMediaRef[]; native: boolean }>();
      const stepComments = new Map<string, Array<{
        id: string; scope: "common" | "individual"; operationGroupId: string | null;
        body: string | null; assetKey: string | null; assetUrl?: string; submissionId: string | null;
        status: "draft" | "uploading" | "ready" | "failed" | "cancelled";
        images: import("../../shared/types").CommentImage[];
        attachments: import("../../shared/types").CommentAttachment[];
        actorEmail: string | null; createdAt: string;
      }>>();
      const submissions = serializeCommentSubmissions(
        commentSubmissionRows.results.map(sampleCommentSubmissionRow),
        commentSubmissionItemRows.results.map(sampleCommentSubmissionItemRow),
      );
      const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));
      for (const row of runAssetRows.results.map(sampleRunAssetRow)) {
        const entry = stepAssets.get(row.run_step_id) ?? { planned: [], execution: [] };
        if (row.r2_key) entry[row.role].push(row.r2_key);
        stepAssets.set(row.run_step_id, entry);
        const media = stepMedia.get(row.run_step_id) ?? { planned: [], execution: [], native: false };
        if (!row.r2_key && row.file_id) media[row.role].push({ assetId: row.asset_id, fileId: row.file_id,
          url: nativeAssetUrl(row.asset_id) });
        media.native ||= row.r2_key === null && Boolean(row.file_id);
        stepMedia.set(row.run_step_id, media);
      }
      for (const row of runInitialAssetRows.results.map(sampleRunInitialAssetRow)) {
        if (row.r2_key) initialAssetsByRun.set(row.run_id, [...(initialAssetsByRun.get(row.run_id) ?? []), row.r2_key]);
        const media = initialMediaByRun.get(row.run_id) ?? { refs: [], native: false };
        if (!row.r2_key && row.file_id) media.refs.push({ assetId: row.asset_id, fileId: row.file_id,
          url: nativeAssetUrl(row.asset_id) });
        media.native ||= row.r2_key === null && Boolean(row.file_id);
        initialMediaByRun.set(row.run_id, media);
      }
      for (const row of runCommentRows.results.map(sampleRunCommentRow)) {
        const entry = stepComments.get(row.run_step_id) ?? [];
        const submission = row.submission_id ? submissionById.get(row.submission_id) : null;
        entry.push({
          id: row.id,
          scope: row.scope,
          operationGroupId: row.operation_group_id,
          body: row.body,
          assetKey: row.asset_key,
          ...(!row.asset_key && row.asset_id && row.file_id ? { assetUrl: nativeAssetUrl(row.asset_id) } : {}),
          submissionId: row.submission_id,
          status: submission?.status ?? "ready",
          images: submission?.images ?? (row.asset_key || row.asset_id && row.file_id ? [{
            id: `legacy:${row.id}`,
            filename: "Comment image",
            mimeType: "image/*",
            byteSize: 0,
            originalFilename: "Comment image",
            originalMimeType: "image/*",
            originalByteSize: 0,
            assetKey: row.asset_key,
            ...(!row.asset_key && row.asset_id && row.file_id ? { assetId: row.asset_id, fileId: row.file_id,
              assetUrl: nativeAssetUrl(row.asset_id) } : {}),
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
      for (const target of commentSubmissionTargetRows.results.map(sampleCommentTargetRow)) {
        const submission = submissionById.get(target.submission_id);
        if (!submission || submission.status === "ready" || submission.status === "cancelled") continue;
        const entry = stepComments.get(target.run_step_id) ?? [];
        entry.push({
          id: `submission:${submission.id}:${target.run_step_id}`,
          scope: submission.scope || "individual",
          operationGroupId: submission.scope === "common" ? submission.id : null,
          body: submission.body,
          assetKey: submission.images[0]?.assetKey ?? null,
          ...(submission.images[0]?.assetUrl ? { assetUrl: submission.images[0].assetUrl } : {}),
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
          templateVersion: configurationSqlInteger(row.template_version, "sample.run.template_version", Number.MIN_SAFE_INTEGER),
          runKind: String(row.run_kind),
          status: String(row.run_status),
          currentPlanRevisionId: row.current_plan_revision_id ? String(row.current_plan_revision_id) : null,
          planRevisionNumber: configurationSqlInteger(row.plan_revision_no, "sample.run.plan_revision_no", Number.MIN_SAFE_INTEGER),
          predecessorRunId: row.predecessor_run_id ? String(row.predecessor_run_id) : null,
          anchorStepId: row.anchor_step_id ? String(row.anchor_step_id) : null,
          sequenceNo: configurationSqlInteger(row.sequence_no, "sample.run.sequence_no", Number.MIN_SAFE_INTEGER), runGroupId: String(row.run_group_id),
          initialStateHash: row.initial_state_hash ? String(row.initial_state_hash) : null,
          initialStateImageKeys: initialAssetsByRun.get(runId) ?? [],
          ...(initialMediaByRun.get(runId)?.native ? { initialStateImages: initialMediaByRun.get(runId)!.refs } : {}),
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
          position: sampleReadDecimal(row.position, "sample.step.position"),
          planPosition: row.plan_position === null || row.plan_position === undefined ? null : sampleReadDecimal(row.plan_position, "sample.step.plan_position"),
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
          ...(stepMedia.get(stepId)?.native ? { plannedImages: stepMedia.get(stepId)!.planned, executionImages: stepMedia.get(stepId)!.execution } : {}),
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
        ...sampleDetail(sampleSerializerRow(sample)),
        runs: [...runs.values()],
        stateVerifications,
        comments: submissions.filter((submission) => submission.contextKind === "sample" && submission.status !== "cancelled"),
      };
      await dependencies.admit(actor);
      if (processingView) return detail;
      return {
        ...detail,
        parent,
        children: children.results.map(sampleIdentityRow),
        events: events.results.map((row) => sampleEvent(sampleEventRow(row))),
      };
    },
  };
}
export type SampleReadService = ReturnType<typeof createSampleReadService>;

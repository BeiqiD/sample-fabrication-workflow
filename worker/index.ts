import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_SAMPLE_STATUS, isSampleStatus, MAX_SPLIT_PIECES, type ApplyPlanUpdateInput, type ConfirmRunStepsInput, type CreateMetrologyRunEntryInput, type CreateRecordInput, type CreateRunStepCommentsInput, type CreateRunStepInput, type CreateSampleInput, type CreateStateVerificationInput, type DeleteRunInput, type DeleteSampleInput, type FinishProcessRunInput, type InitialSubstrateStep, type RunStepTarget, type SampleDirectorySort, type SampleStatus, type SplitSampleInput, type StartMetrologyRunInput, type StartProcessRunInput, type StepStatus, type UpdateRunStepInput, type UpdateSampleInput } from "../shared/types";
import { hashInitialSubstrateRepresentation, hashRecipeManifest, hashStateRepresentation, hashStepDefinition, logicalStepKey, normalizedStepName, sha256Hex, stableJson, STATE_HASH_SCHEME, STEP_HASH_SCHEME } from "../shared/content-addressing";
import { alignFuturePlan } from "../shared/plan-alignment";
import { isSampleRecordEvent } from "../shared/sample-records";
import { sampleDetail, sampleEvent, sampleSummary } from "./serializers";
import { collectExportAssetKeys } from "./export-data";
import { authenticateRequest } from "./auth";
import { bulkInsertStatements } from "./d1-bulk";
import { contentLengthWithin, escapedLikePattern, sameOriginOrNonBrowser } from "./request-guards";
import { insertionPosition } from "./run-position";
import { ACTIVATE_SAMPLE_FOR_RUN_SQL } from "./run-lifecycle";
import { returnedEveryConfirmationTarget } from "./run-step-confirmation";
import { resolveAssetReferences } from "./asset-dedupe";
import { titleChangeAudit } from "./sample-update";
import { loadPlanContext } from "./plan-context";
import { validateSubstrateTransition } from "./run-start";
import { resolvePlanUpdateStructureTarget } from "./plan-update";
import { routes as commentSubmissionRoutes } from "./comment-submission-routes";
import { cleanupCommentUploads } from "./comment-upload-cleanup";
import { managedStorageStatus } from "./managed-storage";
import { directoryFilterValue, likeBindings, paginationMeta, processingDirectoryFilter, readPagination, repeatedLikeSql, sampleDirectorySort, searchTokens } from "./directory-query";
import {
  serializeCommentSubmissions,
  type CommentSubmissionItemRow,
  type CommentSubmissionRow,
} from "./comment-submission-serialization";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>().basePath("/api");
const MAX_FABUBLOX_IMPORT_STEPS = 180;
const MAX_FABUBLOX_IMPORT_IMAGES = MAX_FABUBLOX_IMPORT_STEPS;

async function digestSha256(buffer: ArrayBuffer) {
  return sha256Hex(buffer);
}

function safeObjectName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizedSubstrateStepName(name: string) {
  return normalizedStepName(name).replace(/[-_]+/g, " ");
}

function validRunStepTargets(value: unknown): value is RunStepTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return false;
  const keys = new Set<string>();
  for (const target of value) {
    if (!target || typeof target !== "object") return false;
    const candidate = target as Partial<RunStepTarget>;
    if (typeof candidate.sampleId !== "string" || typeof candidate.runId !== "string"
      || typeof candidate.stepId !== "string" || typeof candidate.expectedUpdatedAt !== "string"
      || !candidate.sampleId || !candidate.runId || !candidate.stepId || !candidate.expectedUpdatedAt) return false;
    const key = `${candidate.sampleId}\u0000${candidate.runId}\u0000${candidate.stepId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

async function requireVisibleCommentOperationGroup(db: D1Database, operationGroupId: string) {
  const counts = await db.prepare(
    `SELECT COUNT(*) AS target_count,
            COALESCE(SUM(CASE
              WHEN s.id IS NOT NULL AND s.deleted_at IS NULL
                AND r.id IS NOT NULL AND r.deleted_at IS NULL
                AND rs.id IS NOT NULL AND rs.deleted_at IS NULL
                AND (
                  rsc.submission_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM comment_submissions cs
                    WHERE cs.id = rsc.submission_id
                      AND cs.status = 'ready'
                      AND cs.deleted_at IS NULL
                  )
                )
              THEN 1 ELSE 0 END), 0) AS visible_count
     FROM run_step_comments rsc
     LEFT JOIN run_steps rs ON rs.id = rsc.run_step_id
     LEFT JOIN runs r ON r.id = rs.run_id
     LEFT JOIN samples s ON s.id = r.sample_id
     WHERE rsc.operation_group_id = ?`,
  ).bind(operationGroupId).first<{ target_count: number; visible_count: number }>();
  if (!counts || Number(counts.target_count) < 1
    || Number(counts.visible_count) !== Number(counts.target_count)) {
    throw new HTTPException(409, {
      message: "A common comment target is no longer available. Restore every target before changing the group.",
    });
  }
}

async function deleteR2KeysInBatches(bucket: R2Bucket, keys: string[]) {
  const failures: unknown[] = [];
  for (let index = 0; index < keys.length; index += 5) {
    const results = await Promise.allSettled(keys.slice(index, index + 5).map((key) => bucket.delete(key)));
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  }
  return failures;
}

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Unexpected server error" }, 500);
});

app.use("*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOriginOrNonBrowser(c.req.raw)) {
    return c.json({ error: "Cross-origin writes are not allowed" }, 403);
  }
  try {
    const identity = await authenticateRequest(c.req.raw, c.env);
    c.set("userEmail", identity.email);
    await next();
  } catch (error) {
    console.warn("Authentication rejected", error);
    return c.json({ error: "Authentication required" }, 403);
  }
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/ready", async (c) => {
  const checks: Promise<unknown>[] = [
    c.env.DB.prepare("SELECT 1 AS ok").first(),
    c.env.ASSETS.list({ limit: 1 }),
  ];
  if (c.env.MANAGED_STORAGE_PROVIDER) {
    const storageStatus = await managedStorageStatus(c.env);
    if (!storageStatus.available) throw new HTTPException(503, { message: storageStatus.message });
  }
  await Promise.all(checks);
  return c.json({ ok: true });
});

app.route("/", commentSubmissionRoutes);

type SampleStructureState = {
  stepId: string | null;
  stateHash: string | null;
  stepTitle: string | null;
  imageKeys: string[];
  imageHashes: string[];
};

async function stateAssets(db: D1Database, stateHash: string | null) {
  if (!stateHash) return [];
  const rows = await db.prepare(
    `SELECT a.r2_key, a.sha256
     FROM state_representation_assets sra
     JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
     WHERE sra.state_hash = ?
     ORDER BY sra.position, a.id`,
  ).bind(stateHash).all<{ r2_key: string; sha256: string }>();
  return rows.results;
}

async function stateImageKeys(db: D1Database, stateHash: string | null) {
  return (await stateAssets(db, stateHash)).map((row) => row.r2_key);
}

function parseInitialSubstrateStep(contentJson: string | null): InitialSubstrateStep | null {
  if (!contentJson) return null;
  try {
    const value = JSON.parse(contentJson) as { initialSubstrateStep?: unknown };
    const step = value.initialSubstrateStep;
    if (!step || typeof step !== "object") return null;
    const candidate = step as Partial<InitialSubstrateStep>;
    if (candidate.stepNumber !== "0" || normalizedSubstrateStepName(candidate.name ?? "") !== "substrate stack") return null;
    return step as InitialSubstrateStep;
  } catch {
    return null;
  }
}

function compareSubstrateStructures(
  previousStateHash: string | null,
  previousImageHashes: string[],
  templateStateHash: string | null,
  templateImageHashes: string[],
): "same" | "different" | "no_previous_structure" | "not_comparable" {
  if (!previousStateHash) return "no_previous_structure";
  if (previousStateHash === templateStateHash) return "same";
  if (!previousImageHashes.length || !templateImageHashes.length) return "not_comparable";
  return previousImageHashes.length === templateImageHashes.length
    && previousImageHashes.every((hash, index) => hash === templateImageHashes[index])
    ? "same"
    : "different";
}

async function loadCurrentSampleStructure(db: D1Database, sampleId: string): Promise<SampleStructureState> {
  const row = await db.prepare(
    `WITH latest_run AS (
       SELECT id, sequence_no, initial_state_hash
       FROM runs
       WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL
       ORDER BY sequence_no DESC LIMIT 1
     ),
     candidates AS (
       SELECT rs.id AS step_id, rs.expected_state_hash AS state_hash,
              COALESCE(rs.title, sd.name) AS step_title, 1 AS priority
       FROM run_steps rs
       JOIN latest_run lr ON lr.id = rs.run_id
       LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
       WHERE rs.status = 'done' AND rs.deleted_at IS NULL
         AND rs.entry_kind = 'fabrication'
         AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
         AND (rs.expected_state_hash IS NOT NULL OR EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.run_step_id = rs.id AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
         ))
       ORDER BY rs.position DESC LIMIT 1
     ),
     latest_initial AS (
       SELECT NULL AS step_id, initial_state_hash AS state_hash, NULL AS step_title, 2 AS priority
       FROM latest_run WHERE initial_state_hash IS NOT NULL
     ),
     historical_step AS (
       SELECT rs.id AS step_id, rs.expected_state_hash AS state_hash,
              COALESCE(rs.title, sd.name) AS step_title, 3 AS priority
       FROM run_steps rs
       JOIN runs r ON r.id = rs.run_id
       LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
       WHERE r.sample_id = ? AND r.run_kind = 'process' AND r.deleted_at IS NULL
         AND rs.entry_kind = 'fabrication' AND rs.status = 'done' AND rs.deleted_at IS NULL
         AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
         AND (rs.expected_state_hash IS NOT NULL OR EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.run_step_id = rs.id AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
         ))
       ORDER BY r.sequence_no DESC, rs.position DESC LIMIT 1
     ),
     inherited_sample AS (
       SELECT NULL AS step_id, inherited_state_hash AS state_hash, NULL AS step_title, 4 AS priority
       FROM samples WHERE id = ? AND inherited_state_hash IS NOT NULL AND deleted_at IS NULL
     )
     SELECT step_id, state_hash, step_title FROM (
       SELECT * FROM candidates
       UNION ALL SELECT * FROM latest_initial
       UNION ALL SELECT * FROM historical_step
       UNION ALL SELECT * FROM inherited_sample
     ) ORDER BY priority LIMIT 1`,
  ).bind(sampleId, sampleId, sampleId).first<{ step_id: string | null; state_hash: string | null; step_title: string | null }>();
  const executionAssets = row?.step_id ? await db.prepare(
    `SELECT a.r2_key, a.sha256
     FROM run_step_assets rsa
     JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
     WHERE rsa.run_step_id = ? AND rsa.role = 'execution' AND rsa.deleted_at IS NULL
     ORDER BY rsa.position, a.id`,
  ).bind(row.step_id).all<{ r2_key: string; sha256: string }>() : { results: [] };
  const assets = executionAssets.results.length
    ? executionAssets.results
    : await stateAssets(db, row?.state_hash ?? null);
  const stateHash = executionAssets.results.length
    ? `execution-assets:${await sha256Hex(stableJson(executionAssets.results.map((asset) => asset.sha256)))}`
    : row?.state_hash ?? null;
  return {
    stepId: row?.step_id ?? null,
    stateHash,
    stepTitle: row?.step_title ?? null,
    imageKeys: assets.map((asset) => asset.r2_key),
    imageHashes: assets.map((asset) => asset.sha256),
  };
}

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

app.get("/sample-directory-options", async (c) => {
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

app.get("/samples", async (c) => {
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

app.post("/samples", async (c) => {
  const input = await c.req.json<CreateSampleInput>();
  if (typeof input.code !== "string" || typeof input.title !== "string" || (input.description !== undefined && typeof input.description !== "string") || (input.location !== undefined && typeof input.location !== "string") || (input.status !== undefined && !isSampleStatus(input.status))) {
    throw new HTTPException(400, { message: "Invalid sample fields" });
  }
  const code = input.code.trim();
  const title = input.title.trim();
  if (!code || !title) throw new HTTPException(400, { message: "Code and sample name are required" });
  if (code.length > 100 || title.length > 200 || (input.description?.length ?? 0) > 10_000 || (input.location?.length ?? 0) > 500) {
    throw new HTTPException(400, { message: "One or more sample fields are too long" });
  }

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

app.post("/samples/:id/split", async (c) => {
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
  const statements: D1PreparedStatement[] = [];
  for (const child of children) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO samples
          (id, code, title, description, status, location, parent_id, inherited_state_hash,
           created_by, updated_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, id, ?, ?, ?, ?, ?
         FROM samples WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
      ).bind(child.id, child.code, child.title, child.description, child.status, child.location,
        parentStructure.stateHash, userEmail, userEmail, now, now, parentId, input.expectedUpdatedAt),
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
          inheritedStateHash: parentStructure.stateHash,
        }), userEmail, now, child.id, parentId,
      ),
    );
  }
  const childCodes = children.map((child) => child.code);
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, id, 'status', ?, ?, ?, ? FROM samples
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(), `Split into ${children.length} child samples: ${childCodes.join(", ")}`,
      JSON.stringify({ action: "sample_split", childIds: children.map((child) => child.id), childCodes, parentStatusAfter: input.parentStatusAfter }),
      userEmail, now, parentId, input.expectedUpdatedAt,
    ),
    c.env.DB.prepare(
      `UPDATE samples SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
    ).bind(input.parentStatusAfter, userEmail, mutationId, now, parentId, input.expectedUpdatedAt),
  );

  try {
    const results = await c.env.DB.batch(statements);
    if (!results.at(-1)?.meta.changes) {
      throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before splitting." });
    }
    if (results.some((result) => !result.meta.changes)) throw new Error("The complete split audit trail was not created");
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: "One or more generated sample codes already exist" });
    throw error;
  }
  return c.json({ children: children.map(({ id, code }) => ({ id, code })), updatedAt: now }, 201);
});

app.get("/samples/:id", async (c) => {
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
              rsc.body, ca.r2_key AS asset_key, rsc.submission_id, rsc.actor_email, rsc.created_at
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
    images: import("../shared/types").CommentImage[];
    attachments: import("../shared/types").CommentAttachment[];
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

app.patch("/samples/:id", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<UpdateSampleInput>();
  if ("code" in input) throw new HTTPException(400, { message: "Sample code is a permanent identifier and cannot be changed" });
  if (typeof input.expectedUpdatedAt !== "string" || (input.title !== undefined && typeof input.title !== "string") || (input.description !== undefined && typeof input.description !== "string") || (input.location !== undefined && typeof input.location !== "string") || (input.pinned !== undefined && typeof input.pinned !== "boolean")) throw new HTTPException(400, { message: "Invalid sample update" });
  if (input.title !== undefined && (!input.title.trim() || input.title.length > 200)) throw new HTTPException(400, { message: "Sample name is required and must be 200 characters or fewer" });
  if (input.description !== undefined && input.description.length > 10_000) throw new HTTPException(400, { message: "Description is too long" });
  if (input.location && input.location.length > 500) throw new HTTPException(400, { message: "Location is too long" });
  if (input.status !== undefined && !isSampleStatus(input.status)) {
    throw new HTTPException(400, { message: "Invalid sample status" });
  }
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

app.delete("/samples/:id", async (c) => {
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

app.post("/samples/:id/restore", async (c) => {
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

app.post("/samples/:id/records", async (c) => {
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
      `SELECT r2_key FROM assets WHERE status = 'ready' AND r2_key IN (${placeholders})`,
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

app.delete("/samples/:id/records/:eventId", async (c) => {
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

app.delete("/samples/:id/events/:eventId/asset", async (c) => {
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

app.post("/samples/:id/runs/preview", async (c) => {
  const sampleId = c.req.param("id");
  const { templateVersionId } = await c.req.json<{ templateVersionId?: string }>();
  if (!templateVersionId) throw new HTTPException(400, { message: "A process-template version is required" });
  const [sample, template, latestRun, currentState] = await Promise.all([
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT id, name, version, initial_state_hash, content_json
       FROM template_versions
       WHERE id = ? AND template_kind = 'process' AND archived_at IS NULL
         AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = template_versions.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first<{ id: string; name: string; version: number; initial_state_hash: string | null; content_json: string | null }>(),
    c.env.DB.prepare(
      "SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1",
    ).bind(sampleId).first<{ id: string; status: string }>(),
    loadCurrentSampleStructure(c.env.DB, sampleId),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Process-template version not found" });
  if (latestRun?.status === "active") {
    throw new HTTPException(409, { message: "Finish the active process run or update its process template instead." });
  }
  const templateAssets = await stateAssets(c.env.DB, template.initial_state_hash);
  const initialSubstrateStep = parseInitialSubstrateStep(template.content_json);
  const canConfirm = Boolean(template.initial_state_hash && initialSubstrateStep);
  return c.json({
    successor: Boolean(latestRun),
    sampleUpdatedAt: sample.updated_at,
    expectedLatestRunId: latestRun?.id ?? null,
    comparison: compareSubstrateStructures(
      currentState.stateHash,
      currentState.imageHashes,
      template.initial_state_hash,
      templateAssets.map((asset) => asset.sha256),
    ),
    canConfirm,
    blockingReason: canConfirm ? null : "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before starting a run.",
    comparisonTarget: canConfirm ? {
      kind: "initial_substrate" as const,
      key: `initial-substrate:${template.id}`,
      stateHash: template.initial_state_hash,
      imageKeys: templateAssets.map((asset) => asset.r2_key),
      stepId: null,
      stepTitle: initialSubstrateStep!.name,
    } : null,
    template: {
      id: template.id,
      name: template.name,
      version: template.version,
      initialSubstrateStep,
    },
    sampleCurrentState: {
      hash: currentState.stateHash,
      stepTitle: currentState.stepTitle,
      imageKeys: currentState.imageKeys,
    },
  });
});

app.post("/samples/:id/runs", async (c) => {
  const sampleId = c.req.param("id");
  const input = await c.req.json<StartProcessRunInput>();
  if (!input || typeof input !== "object") throw new HTTPException(400, { message: "A process-template version and substrate confirmation are required" });
  const { templateVersionId } = input;
  if (typeof templateVersionId !== "string" || !templateVersionId) throw new HTTPException(400, { message: "Template version is required" });
  const [sample, template, templateStepRows, latestRun, latestSequence] = await Promise.all([
    c.env.DB.prepare("SELECT code, updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ code: string; updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT tv.name, tv.template_type, tv.version, tv.recipe_family_id, tv.initial_state_hash, tv.content_json
       FROM template_versions tv WHERE tv.id = ? AND tv.template_kind = 'process' AND tv.archived_at IS NULL
       AND tv.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first<{ name: string; template_type: "process" | "module" | "recipe"; version: number; recipe_family_id: string; initial_state_hash: string | null; content_json: string | null }>(),
    c.env.DB.prepare(
      `SELECT id, position, logical_step_key, definition_hash, expected_state_hash
       FROM template_steps WHERE template_version_id = ? ORDER BY position`,
    ).bind(templateVersionId).all<{ id: string; position: number; logical_step_key: string; definition_hash: string; expected_state_hash: string | null }>(),
    c.env.DB.prepare(
      `SELECT id, status, sequence_no
       FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL
       ORDER BY sequence_no DESC LIMIT 1`,
    ).bind(sampleId).first<{ id: string; status: "active" | "complete" | "cancelled" | "superseded"; sequence_no: number }>(),
    c.env.DB.prepare("SELECT COALESCE(MAX(sequence_no), 0) AS sequence_no FROM runs WHERE sample_id = ?")
      .bind(sampleId).first<{ sequence_no: number }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  if (!parseInitialSubstrateStep(template.content_json)) {
    throw new HTTPException(409, { message: "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before starting a run." });
  }
  if (latestRun?.status === "active") throw new HTTPException(409, { message: "This sample already has an active process run. Update its process template or finish it before starting a new run." });
  const currentState = await loadCurrentSampleStructure(c.env.DB, sampleId);
  const initialState = validateSubstrateTransition(input.substrateConfirmation, {
    sampleUpdatedAt: sample.updated_at,
    previousStateHash: currentState.stateHash,
    templateStructureKey: `initial-substrate:${templateVersionId}`,
    templateStateHash: template.initial_state_hash,
    templateStateRequired: true,
    latestRunId: latestRun?.id ?? null,
  });
  if (!initialState.ok) {
    throw new HTTPException(409, {
      message: initialState.reason === "template_structure_missing"
        ? "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before starting a run."
        : initialState.reason === "confirmation_required"
          ? "Compare the previous structure with Step 0 and confirm that the handoff is expected."
          : "The sample, previous run, or template changed after review. Compare the structures again.",
    });
  }
  const steps = templateStepRows.results;
  if (!steps.length) throw new HTTPException(422, { message: "This template has no mapped steps. Re-import it with a step column." });

  const runId = crypto.randomUUID();
  const planRevisionId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = new Map(steps.map((step) => [step.id, crypto.randomUUID()]));
  const anchor = latestRun ? await c.env.DB.prepare(
    `SELECT id FROM run_steps
     WHERE run_id = ? AND entry_kind = 'fabrication' AND actualized_at IS NOT NULL
       AND deleted_at IS NULL
     ORDER BY position DESC LIMIT 1`,
  ).bind(latestRun.id).first<{ id: string }>() : null;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, current_plan_revision_id,
         predecessor_run_id, anchor_step_id, sequence_no, run_group_id, run_kind,
         template_name_snapshot, template_type_snapshot, template_version_snapshot,
         initial_state_hash, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'process', ?, ?, ?, ?, ?, ?
       FROM samples s
       WHERE s.id = ? AND s.updated_at = ? AND s.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM runs active
           WHERE active.sample_id = s.id AND active.status = 'active' AND active.run_kind = 'process'
             AND active.deleted_at IS NULL
         )
         AND COALESCE((
           SELECT id FROM runs latest
           WHERE latest.sample_id = s.id AND latest.run_kind = 'process'
             AND latest.deleted_at IS NULL
           ORDER BY sequence_no DESC LIMIT 1
         ), '')
             = COALESCE(?, '')`,
    ).bind(runId, sampleId, template.recipe_family_id, templateVersionId, planRevisionId,
      latestRun?.id ?? null, anchor?.id ?? null, Number(latestSequence?.sequence_no ?? 0) + 1, crypto.randomUUID(),
      template.name, template.template_type, template.version, initialState.confirmedTemplateStateHash, userEmail, now,
      sampleId, input.substrateConfirmation!.expectedSampleUpdatedAt, latestRun?.id ?? null),
    c.env.DB.prepare(
      `INSERT INTO run_plan_revisions
       (id, run_id, revision_no, template_version_id, effective_after_step_id, reason, actor_email, created_at)
       VALUES (?, ?, 1, ?, ?, 'Initial assignment', ?, ?)`,
    ).bind(planRevisionId, runId, templateVersionId, anchor?.id ?? null, userEmail, now),
    ...bulkInsertStatements(c.env.DB, "run_steps",
      ["id", "run_id", "previous_step_id", "position", "origin", "plan_status", "template_step_id", "logical_step_key", "definition_hash", "expected_state_hash", "created_at", "updated_by", "updated_at"],
      steps.map((step, index) => [stepIds.get(step.id), runId, index ? stepIds.get(steps[index - 1].id) : anchor?.id ?? null,
        (index + 1) * 1000, "template", "current", step.id, step.logical_step_key, step.definition_hash, step.expected_state_hash, now, userEmail, now])),
    ...bulkInsertStatements(c.env.DB, "run_step_plan_links",
      ["run_plan_revision_id", "template_step_id", "run_step_id", "relation", "created_at"],
      steps.map((step) => [planRevisionId, step.id, stepIds.get(step.id), "planned", now])),
    c.env.DB.prepare(
      "INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at) VALUES (?, ?, 'run', ?, ?, ?, ?)",
    ).bind(eventId, sampleId, `${latestRun ? "Started new process run" : "Started first process run"} · ${template.name} v${template.version} (${steps.length} planned steps)`, JSON.stringify({
      runId,
      templateVersionId,
      templateVersion: template.version,
      predecessorRunId: latestRun?.id ?? null,
      anchorStepId: anchor?.id ?? null,
      initialStateHash: initialState.confirmedTemplateStateHash,
      initialStateSource: "process_template_step_0",
      substrateConfirmation: {
        previousStateHash: currentState.stateHash,
        templateInitialStateHash: template.initial_state_hash,
        exactStateHashMatch: currentState.stateHash === template.initial_state_hash,
      },
    }), userEmail, now),
    c.env.DB.prepare(ACTIVATE_SAMPLE_FOR_RUN_SQL).bind(userEmail, now, sampleId),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This process template is too large to start on the current plan" });
  try { await c.env.DB.batch(statements); }
  catch (error) {
    if (/template version (archived|unavailable)/.test(String(error))) {
      throw new HTTPException(409, { message: "This process-template version became unavailable before the run started" });
    }
    if (String(error).includes("FOREIGN KEY") || String(error).includes("constraint")) {
      throw new HTTPException(409, { message: "The sample or its latest run changed while the structures were being confirmed. Review them again." });
    }
    throw error;
  }
  return c.json({ id: runId }, 201);
});

app.post("/samples/:sampleId/runs/:runId/finish", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<FinishProcessRunInput>();
  if (!input || typeof input.expectedSampleUpdatedAt !== "string"
    || (input.confirmSkipUnfinishedSteps !== undefined && typeof input.confirmSkipUnfinishedSteps !== "boolean")) {
    throw new HTTPException(400, { message: "The current sample revision is required" });
  }
  const [run, sample, unfinished] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, template_name_snapshot, template_version_snapshot, status FROM runs WHERE id = ? AND sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL",
    ).bind(runId, sampleId).first<{ id: string; template_name_snapshot: string; template_version_snapshot: number; status: string }>(),
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT id FROM run_steps
       WHERE run_id = ? AND entry_kind = 'fabrication' AND deleted_at IS NULL
         AND plan_status = 'current' AND status NOT IN ('done', 'skipped')
       ORDER BY position, id`,
    ).bind(runId).all<{ id: string }>(),
  ]);
  if (!run || !sample) throw new HTTPException(404, { message: "Process run not found" });
  if (run.status !== "active") throw new HTTPException(409, { message: "Only the active process run can be finished" });
  if (sample.updated_at !== input.expectedSampleUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before finishing the run." });
  }
  const unfinishedStepIds = unfinished.results.map((step) => step.id);
  if (unfinishedStepIds.length && input.confirmSkipUnfinishedSteps !== true) {
    throw new HTTPException(409, {
      message: `Finishing this run will mark ${unfinishedStepIds.length} unfinished step${unfinishedStepIds.length === 1 ? "" : "s"} as skipped. Confirm this action before continuing.`,
    });
  }
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
    ).bind(userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
    c.env.DB.prepare(
      `UPDATE run_steps
       SET status = 'skipped', actualized_at = COALESCE(actualized_at, ?),
           updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE run_id = ? AND entry_kind = 'fabrication' AND deleted_at IS NULL
         AND plan_status = 'current' AND status NOT IN ('done', 'skipped')
         AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = ? AND sample_id = ? AND run_kind = 'process' AND status = 'active'
             AND deleted_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL
         )`,
    ).bind(now, userEmail, mutationId, now, runId, runId, sampleId, sampleId, mutationId),
    c.env.DB.prepare(
      `UPDATE runs SET status = 'complete', completed_at = COALESCE(completed_at, ?)
       WHERE id = ? AND sample_id = ? AND run_kind = 'process'
         AND deleted_at IS NULL
         AND status IN ('active', 'complete')
         AND NOT EXISTS (
           SELECT 1 FROM run_steps
           WHERE run_id = ? AND entry_kind = 'fabrication'
             AND plan_status = 'current' AND status NOT IN ('done', 'skipped')
         )
         AND EXISTS (
           SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL
         )`,
    ).bind(now, runId, sampleId, runId, sampleId, mutationId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'run', ?, ?, ?, ? FROM samples s
       WHERE s.id = ? AND s.last_mutation_id = ? AND s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runs r
           WHERE r.id = ? AND r.sample_id = s.id AND r.status = 'complete'
             AND r.deleted_at IS NULL
         )`,
    ).bind(
      crypto.randomUUID(),
      `Finished process run · ${run.template_name_snapshot} v${run.template_version_snapshot}${unfinishedStepIds.length
        ? ` · ${unfinishedStepIds.length} unfinished step${unfinishedStepIds.length === 1 ? "" : "s"} marked skipped`
        : ""}`,
      JSON.stringify({
        action: "process_run_finished",
        runId,
        skippedUnfinishedStepCount: unfinishedStepIds.length,
        skippedUnfinishedStepIds: unfinishedStepIds,
      }),
      userEmail,
      now,
      sampleId,
      mutationId,
      runId,
    ),
  ]);
  if (!results[0].meta.changes
    || Number(results[1].meta.changes ?? 0) !== unfinishedStepIds.length
    || !results[2].meta.changes
    || !results[3].meta.changes) {
    throw new HTTPException(409, { message: "The process run changed while it was being finished. Reload and try again." });
  }
  return c.json({ ok: true, completedAt: now, skippedStepCount: unfinishedStepIds.length });
});

app.delete("/samples/:sampleId/runs/:runId", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<DeleteRunInput>().catch(() => null);
  if (!input || typeof input.expectedSampleUpdatedAt !== "string") {
    throw new HTTPException(400, { message: "The current sample revision is required" });
  }
  const run = await c.env.DB.prepare(
    `SELECT r.id, r.run_kind, r.status, r.sequence_no,
            r.template_name_snapshot, r.template_version_snapshot, r.created_at,
            s.status AS sample_status, s.updated_at AS sample_updated_at,
            (SELECT COUNT(*) FROM runs active
             WHERE active.sample_id = r.sample_id
               AND active.status = 'active'
               AND active.deleted_at IS NULL
               AND active.id != r.id) AS other_active_count
     FROM runs r
     JOIN samples s ON s.id = r.sample_id
     WHERE r.id = ? AND r.sample_id = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
  ).bind(runId, sampleId).first<{
    id: string;
    run_kind: "process" | "metrology";
    status: "active" | "complete" | "cancelled" | "superseded";
    sequence_no: number;
    template_name_snapshot: string;
    template_version_snapshot: number;
    created_at: string;
    sample_status: SampleStatus;
    sample_updated_at: string;
    other_active_count: number;
  }>();
  if (!run) throw new HTTPException(404, { message: "Run not found" });
  if (run.sample_updated_at !== input.expectedSampleUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before deleting the run." });
  }

  const matchedActivationEvent = await c.env.DB.prepare(
    `SELECT metadata_json FROM events
     WHERE sample_id = ? AND kind = 'status' AND created_at = ?
       AND json_extract(metadata_json, '$.current') = 'active'
     ORDER BY id DESC LIMIT 1`,
  ).bind(sampleId, run.created_at).first<{ metadata_json: string }>();
  let nextSampleStatus = run.sample_status;
  if (run.status === "active" && Number(run.other_active_count) === 0 && run.sample_status === "active") {
    let previousStatus: unknown;
    try {
      previousStatus = JSON.parse(matchedActivationEvent?.metadata_json || "{}").previous;
    } catch {
      previousStatus = null;
    }
    nextSampleStatus = isSampleStatus(previousStatus) && previousStatus !== "active"
      ? previousStatus
      : DEFAULT_SAMPLE_STATUS;
  }

  const now = new Date(Math.max(Date.now(), Date.parse(run.sample_updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const guardSql = "EXISTS (SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL)";
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE samples
       SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
    ).bind(nextSampleStatus, userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
    c.env.DB.prepare(
      `UPDATE runs SET deleted_at = ?, deleted_by = ?
       WHERE id = ? AND sample_id = ? AND deleted_at IS NULL AND ${guardSql}`,
    ).bind(now, userEmail, runId, sampleId, sampleId, mutationId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'run', ?, ?, ?, ?
       WHERE ${guardSql} AND EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND sample_id = ? AND deleted_at = ?
       )`,
    ).bind(
      crypto.randomUUID(),
      sampleId,
      `Moved ${run.run_kind} run to trash · ${run.template_name_snapshot}${run.run_kind === "process" ? ` v${run.template_version_snapshot}` : ""}`,
      JSON.stringify({
        action: "run_deleted",
        deletedRunId: runId,
        runKind: run.run_kind,
        sequenceNo: Number(run.sequence_no),
        templateName: run.template_name_snapshot,
        templateVersion: Number(run.template_version_snapshot),
        recoverable: true,
      }),
      userEmail,
      now,
      sampleId,
      mutationId,
      runId,
      sampleId,
      now,
    ),
  ];

  const results = await c.env.DB.batch(statements);
  if (results.some((result) => !result.meta.changes)) {
    throw new HTTPException(409, { message: "The run changed while it was being deleted. Reload and try again." });
  }
  return c.json({ ok: true, updatedAt: now });
});

app.post("/samples/:sampleId/runs/:runId/restore", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<DeleteRunInput>().catch(() => null);
  if (!input || typeof input.expectedSampleUpdatedAt !== "string") {
    throw new HTTPException(400, { message: "The current sample revision is required" });
  }
  const run = await c.env.DB.prepare(
    `SELECT r.id, r.run_kind, r.status, r.sequence_no, r.predecessor_run_id, r.deleted_at,
            r.template_name_snapshot, r.template_version_snapshot,
            s.status AS sample_status, s.updated_at AS sample_updated_at,
            (SELECT COUNT(*) FROM runs active
             WHERE active.sample_id = r.sample_id
               AND active.run_kind = 'process'
               AND active.status = 'active'
               AND active.deleted_at IS NULL
               AND active.id != r.id) AS active_process_count
            ,(SELECT COUNT(*) FROM runs newer
              WHERE newer.sample_id = r.sample_id
                AND newer.run_kind = 'process'
                AND newer.sequence_no > r.sequence_no
                AND newer.deleted_at IS NULL) AS newer_visible_process_count
            ,(SELECT COUNT(*) FROM runs successor
              WHERE r.predecessor_run_id IS NOT NULL
                AND successor.predecessor_run_id = r.predecessor_run_id
                AND successor.deleted_at IS NULL
                AND successor.id != r.id) AS successor_conflict_count
     FROM runs r
     JOIN samples s ON s.id = r.sample_id
     WHERE r.id = ? AND r.sample_id = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NOT NULL`,
  ).bind(runId, sampleId).first<{
    id: string;
    run_kind: "process" | "metrology";
    status: "active" | "complete" | "cancelled" | "superseded";
    sequence_no: number;
    predecessor_run_id: string | null;
    deleted_at: string;
    template_name_snapshot: string;
    template_version_snapshot: number;
    sample_status: SampleStatus;
    sample_updated_at: string;
    active_process_count: number;
    newer_visible_process_count: number;
    successor_conflict_count: number;
  }>();
  if (!run) throw new HTTPException(404, { message: "Run not found in trash" });
  if (run.sample_updated_at !== input.expectedSampleUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before restoring the run." });
  }
  if (run.run_kind === "process" && run.status === "active" && Number(run.active_process_count) > 0) {
    throw new HTTPException(409, { message: "Finish or move the current active process run to trash before restoring this run." });
  }
  if (run.run_kind === "process" && run.status === "active" && Number(run.newer_visible_process_count) > 0) {
    throw new HTTPException(409, { message: "An active process run can only be restored when it is the latest visible process run." });
  }
  if (run.predecessor_run_id && Number(run.successor_conflict_count) > 0) {
    throw new HTTPException(409, { message: "Another visible run already succeeds this run's predecessor." });
  }

  const now = new Date(Math.max(
    Date.now(),
    Date.parse(run.sample_updated_at) + 1,
    Date.parse(run.deleted_at) + 1,
  )).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const nextSampleStatus = run.status === "active" ? "active" : run.sample_status;
  const guardSql = "EXISTS (SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL)";
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE samples
         SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
         WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
      ).bind(nextSampleStatus, userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
      c.env.DB.prepare(
        `UPDATE runs SET deleted_at = NULL, deleted_by = NULL
         WHERE id = ? AND sample_id = ? AND deleted_at = ? AND ${guardSql}
           AND NOT EXISTS (
             SELECT 1 FROM runs successor
             WHERE runs.predecessor_run_id IS NOT NULL
               AND successor.predecessor_run_id = runs.predecessor_run_id
               AND successor.deleted_at IS NULL
               AND successor.id != runs.id
           )
           AND NOT (
             run_kind = 'process' AND status = 'active' AND EXISTS (
               SELECT 1 FROM runs newer
               WHERE newer.sample_id = runs.sample_id
                 AND newer.run_kind = 'process'
                 AND newer.sequence_no > runs.sequence_no
                 AND newer.deleted_at IS NULL
             )
           )`,
      ).bind(runId, sampleId, run.deleted_at, sampleId, mutationId),
      c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, ?, 'run', ?, ?, ?, ?
         WHERE ${guardSql} AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = ? AND sample_id = ? AND deleted_at IS NULL
         )`,
      ).bind(
        crypto.randomUUID(),
        sampleId,
        `Restored ${run.run_kind} run · ${run.template_name_snapshot}${run.run_kind === "process" ? ` v${run.template_version_snapshot}` : ""}`,
        JSON.stringify({
          action: "run_restored",
          restoredRunId: runId,
          runKind: run.run_kind,
          sequenceNo: Number(run.sequence_no),
          templateName: run.template_name_snapshot,
          templateVersion: Number(run.template_version_snapshot),
        }),
        userEmail,
        now,
        sampleId,
        mutationId,
        runId,
        sampleId,
      ),
    ]);
    if (results.some((result) => !result.meta.changes)) {
      throw new HTTPException(409, { message: "The run changed while it was being restored. Reload and try again." });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (/runs_single_successor_idx|UNIQUE constraint failed: runs\.predecessor_run_id/.test(String(error))) {
      throw new HTTPException(409, { message: "Another visible run already succeeds this run's predecessor." });
    }
    if (/runs_one_active_process_per_sample_idx|UNIQUE constraint failed: runs\.sample_id/.test(String(error))) {
      throw new HTTPException(409, { message: "Another active process run became visible before this run was restored." });
    }
    throw error;
  }
  return c.json({ ok: true, updatedAt: now });
});

app.post("/samples/:sampleId/runs/:runId/plan-update/preview", async (c) => {
  const { sampleId, runId } = c.req.param();
  const { templateVersionId } = await c.req.json<{ templateVersionId?: string }>();
  if (!templateVersionId) throw new HTTPException(400, { message: "A template version is required" });
  const context = await loadPlanContext(c.env.DB, sampleId, runId, templateVersionId);
  const [sample, latestRun, currentState] = await Promise.all([
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare("SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1")
      .bind(sampleId).first<{ id: string; status: string }>(),
    loadCurrentSampleStructure(c.env.DB, sampleId),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const sameFamily = context.run.recipe_family_id === context.nextTemplate.recipe_family_id;
  const isNewerVersion = context.nextTemplate.version > Number(context.run.current_template_version_number);
  const alignment = sameFamily ? alignFuturePlan(context.existing, context.next) : {
    matches: [], additions: [], supersededStepIds: [], historicalDifferences: [],
  };
  const canReopen = context.run.status === "complete" && latestRun?.id === runId;
  const lifecycleAllowed = context.run.status === "active" || canReopen;
  const pendingAdditions = alignment.additions.filter((step) => step.initialStatus === "pending");
  const hasFutureWork = context.run.status === "active" || pendingAdditions.length > 0;
  const initialSubstrateStep = parseInitialSubstrateStep(context.nextTemplate.content_json);
  const hasInitialSubstrate = Boolean(context.nextTemplate.initial_state_hash && initialSubstrateStep);
  const comparisonTarget = sameFamily ? resolvePlanUpdateStructureTarget(
    alignment,
    currentState.stepId,
    context.next,
    {
      templateVersionId,
      stateHash: context.nextTemplate.initial_state_hash,
      valid: hasInitialSubstrate,
    },
  ) : null;
  const comparisonAssets = await stateAssets(c.env.DB, comparisonTarget?.stateHash ?? null);
  const hasComparisonTarget = Boolean(comparisonTarget);
  const blockingReason = !sameFamily
    ? "An in-place update must use another version of the same process template."
    : !isNewerVersion
      ? "Choose a newer version of this process template."
    : !lifecycleAllowed
      ? "Only an active run or the latest completed run can be updated."
      : !hasFutureWork
        ? "This version adds no future work after the completed run."
        : !hasComparisonTarget
          ? currentState.stepId
            ? "The step that produced the current structure could not be matched in this template version."
            : "This process-template version has no valid Step 0: Substrate Stack snapshot."
          : null;
  return c.json({
    compatible: blockingReason === null,
    blockingReason,
    currentTemplateVersionId: context.run.current_template_version_id,
    nextTemplateVersionId: templateVersionId,
    canReopen,
    substrateTransition: {
      successor: false,
      sampleUpdatedAt: sample.updated_at,
      expectedLatestRunId: latestRun?.id ?? null,
      comparison: compareSubstrateStructures(
        currentState.stateHash,
        currentState.imageHashes,
        comparisonTarget?.stateHash ?? null,
        comparisonAssets.map((asset) => asset.sha256),
      ),
      canConfirm: hasComparisonTarget,
      blockingReason: hasComparisonTarget ? null : currentState.stepId
        ? "The current structure-producing step has no match in this template version. Review the step alignment before updating the run."
        : "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before updating the run.",
      comparisonTarget: comparisonTarget ? {
        ...comparisonTarget,
        imageKeys: comparisonAssets.map((asset) => asset.r2_key),
      } : null,
      template: {
        id: context.nextTemplate.id,
        name: context.nextTemplate.name,
        version: context.nextTemplate.version,
        initialSubstrateStep,
      },
      sampleCurrentState: {
        hash: currentState.stateHash,
        stepTitle: currentState.stepTitle,
        imageKeys: currentState.imageKeys,
      },
    },
    preservedCount: alignment.matches.length,
    additionCount: alignment.additions.length,
    skippedAdditionCount: alignment.additions.length - pendingAdditions.length,
    supersededCount: alignment.supersededStepIds.length,
    historicalDifferences: alignment.historicalDifferences,
    familyMismatch: !sameFamily,
  });
});

app.post("/samples/:sampleId/runs/:runId/plan-update", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<ApplyPlanUpdateInput>();
  if (!input || typeof input !== "object" || typeof input.templateVersionId !== "string" || !input.templateVersionId || (input.reason !== undefined && typeof input.reason !== "string")) {
    throw new HTTPException(400, { message: "A process-template version, substrate confirmation, and optional reason are required" });
  }
  const context = await loadPlanContext(c.env.DB, sampleId, runId, input.templateVersionId);
  const [sample, latestRun, currentState] = await Promise.all([
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare("SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1")
      .bind(sampleId).first<{ id: string; status: string }>(),
    loadCurrentSampleStructure(c.env.DB, sampleId),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const reopening = context.run.status === "complete";
  if (context.run.status !== "active" && !(reopening && latestRun?.id === runId)) {
    throw new HTTPException(409, { message: "Only an active run or the latest completed run can receive this process update" });
  }
  if (context.run.recipe_family_id !== context.nextTemplate.recipe_family_id) {
    throw new HTTPException(409, { message: "An in-place process update must use another version of the same process template. Finish this run before choosing a different template." });
  }
  if (context.nextTemplate.version <= Number(context.run.current_template_version_number)) {
    throw new HTTPException(409, { message: "A process update must use a newer version of the current process template." });
  }
  const alignment = alignFuturePlan(context.existing, context.next);
  const pendingAdditions = alignment.additions.filter((step) => step.initialStatus === "pending");
  if (reopening && !pendingAdditions.length) {
    throw new HTTPException(409, { message: "This template version adds no future work after the completed run. Start a new run if this is a separate processing stage." });
  }
  const initialSubstrateStep = parseInitialSubstrateStep(context.nextTemplate.content_json);
  const comparisonTarget = resolvePlanUpdateStructureTarget(
    alignment,
    currentState.stepId,
    context.next,
    {
      templateVersionId: input.templateVersionId,
      stateHash: context.nextTemplate.initial_state_hash,
      valid: Boolean(context.nextTemplate.initial_state_hash && initialSubstrateStep),
    },
  );
  if (!comparisonTarget) {
    throw new HTTPException(409, {
      message: currentState.stepId
        ? "The step that produced the current structure could not be matched in this template version."
        : "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before updating the run.",
    });
  }
  const transition = validateSubstrateTransition(input.substrateConfirmation, {
    sampleUpdatedAt: sample.updated_at,
    previousStateHash: currentState.stateHash,
    templateStructureKey: comparisonTarget.key,
    templateStateHash: comparisonTarget.stateHash,
    templateStateRequired: comparisonTarget.kind === "initial_substrate",
    latestRunId: latestRun?.id ?? null,
    currentPlanRevisionId: context.run.current_plan_revision_id,
  });
  if (!transition.ok) {
    throw new HTTPException(409, {
      message: transition.reason === "template_structure_missing"
        ? "The current structure-producing step could not be matched to a valid comparison point in this template version."
        : transition.reason === "confirmation_required"
          ? "Compare the current recorded structure with the matched step in the updated template."
          : "The sample, run plan, or template changed after review. Compare the structures again.",
    });
  }

  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const revisionId = crypto.randomUUID();
  const matchByTemplate = new Map(alignment.matches.map((match) => [match.templateStepId, match]));
  const existingById = new Map(context.existing.map((step) => [step.id, step]));
  const additionByTemplate = new Map(alignment.additions.map((step) => [step.id, step]));
  const addedIds = new Map(alignment.additions.map((step) => [step.id, crypto.randomUUID()]));
  const executionHead = [...context.existing].filter((step) => step.actualized).sort((left, right) => right.position - left.position)[0] ?? null;
  let previousStepId = executionHead?.id ?? null;
  let futureIndex = 0;
  const futureMatches: Array<{
    id: string; position: number; previousStepId: string | null; templateStepId: string;
    logicalStepKey: string; definitionHash: string; expectedStateHash: string | null;
  }> = [];
  const actualizedMatches: Array<{
    id: string; templateStepId: string; logicalStepKey: string;
    definitionHash: string; expectedStateHash: string | null;
  }> = [];
  const newSteps: unknown[][] = [];
  for (const step of context.next) {
    const match = matchByTemplate.get(step.id);
    if (match && existingById.get(match.existingStepId)?.actualized) {
      actualizedMatches.push({
        id: match.existingStepId,
        templateStepId: step.id,
        logicalStepKey: step.logicalStepKey,
        definitionHash: step.definitionHash,
        expectedStateHash: step.expectedStateHash,
      });
      continue;
    }
    const position = Number(executionHead?.position ?? 0) + (++futureIndex * 1000);
    if (match) {
      futureMatches.push({
        id: match.existingStepId, position, previousStepId, templateStepId: step.id,
        logicalStepKey: step.logicalStepKey, definitionHash: step.definitionHash,
        expectedStateHash: step.expectedStateHash,
      });
      previousStepId = match.existingStepId;
    } else {
      const id = addedIds.get(step.id)!;
      const initialStatus = additionByTemplate.get(step.id)?.initialStatus ?? "pending";
      newSteps.push([id, runId, previousStepId, position, "template", "current", step.id,
        step.logicalStepKey, step.definitionHash, step.expectedStateHash,
        initialStatus, initialStatus === "skipped" ? now : null, now, userEmail, now]);
      previousStepId = id;
    }
  }

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO run_plan_revisions
       (id, run_id, revision_no, template_version_id, effective_after_step_id, reason, actor_email, created_at)
       SELECT ?, r.id, ?, ?, ?, ?, ?, ?
       FROM runs r JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.current_plan_revision_id = ?
         AND r.status = ? AND r.deleted_at IS NULL
         AND s.deleted_at IS NULL AND s.updated_at = ?
         AND (? = 0 OR NOT EXISTS (
           SELECT 1 FROM runs successor
           WHERE successor.predecessor_run_id = r.id AND successor.deleted_at IS NULL
         ))`,
    ).bind(revisionId, Number(context.run.revision_no) + 1, input.templateVersionId,
      executionHead?.id ?? null, input.reason?.trim() || "Imported process-template version update", userEmail, now,
      runId, sampleId, input.substrateConfirmation.expectedCurrentPlanRevisionId,
      reopening ? "complete" : "active", input.substrateConfirmation.expectedSampleUpdatedAt, reopening ? 1 : 0),
    c.env.DB.prepare(
      `UPDATE run_steps SET position = -1000000000 - (? * 1000000) - position
       WHERE run_id = ? AND origin = 'template' AND actualized_at IS NULL AND plan_status = 'current'
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(Number(context.run.revision_no) + 1, runId, revisionId),
  ];
  statements.push(...bulkInsertStatements(c.env.DB, "run_steps",
    ["id", "run_id", "previous_step_id", "position", "origin", "plan_status", "template_step_id", "logical_step_key", "definition_hash", "expected_state_hash", "status", "actualized_at", "created_at", "updated_by", "updated_at"],
    newSteps));
  for (let index = 0; index < actualizedMatches.length; index += 16) {
    const chunk = actualizedMatches.slice(index, index + 16);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((step) => [step.id, step.templateStepId,
      step.logicalStepKey, step.definitionHash, step.expectedStateHash]);
    statements.push(c.env.DB.prepare(
      `WITH changes(id, template_step_id, logical_step_key, definition_hash, expected_state_hash) AS (VALUES ${values})
       UPDATE run_steps SET
         template_step_id = (SELECT template_step_id FROM changes WHERE changes.id = run_steps.id),
         logical_step_key = (SELECT logical_step_key FROM changes WHERE changes.id = run_steps.id),
         definition_hash = (SELECT definition_hash FROM changes WHERE changes.id = run_steps.id),
         expected_state_hash = (SELECT expected_state_hash FROM changes WHERE changes.id = run_steps.id),
         updated_by = ?, updated_at = ?
       WHERE id IN (SELECT id FROM changes)
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(...bindings, userEmail, now, revisionId));
  }
  for (let index = 0; index < futureMatches.length; index += 12) {
    const chunk = futureMatches.slice(index, index + 12);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((step) => [step.id, step.position, step.previousStepId, step.templateStepId,
      step.logicalStepKey, step.definitionHash, step.expectedStateHash]);
    statements.push(c.env.DB.prepare(
      `WITH changes(id, position, previous_step_id, template_step_id, logical_step_key, definition_hash, expected_state_hash) AS (VALUES ${values})
       UPDATE run_steps SET
         position = (SELECT position FROM changes WHERE changes.id = run_steps.id),
         previous_step_id = (SELECT previous_step_id FROM changes WHERE changes.id = run_steps.id),
         template_step_id = (SELECT template_step_id FROM changes WHERE changes.id = run_steps.id),
         logical_step_key = (SELECT logical_step_key FROM changes WHERE changes.id = run_steps.id),
         definition_hash = (SELECT definition_hash FROM changes WHERE changes.id = run_steps.id),
         expected_state_hash = (SELECT expected_state_hash FROM changes WHERE changes.id = run_steps.id),
         plan_status = 'current', updated_by = ?, updated_at = ?
       WHERE id IN (SELECT id FROM changes)
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(...bindings, userEmail, now, revisionId));
  }
  if (alignment.supersededStepIds.length) {
    for (let index = 0; index < alignment.supersededStepIds.length; index += 80) {
      const ids = alignment.supersededStepIds.slice(index, index + 80);
      statements.push(c.env.DB.prepare(
        `UPDATE run_steps SET plan_status = 'superseded', updated_by = ?, updated_at = ?
         WHERE run_id = ? AND id IN (${ids.map(() => "?").join(", ")})
           AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
      ).bind(userEmail, now, runId, ...ids, revisionId));
    }
  }
  const linkRows = context.next.map((step) => {
    const match = matchByTemplate.get(step.id);
    const addition = match ? null : additionByTemplate.get(step.id);
    return [revisionId, step.id, match?.existingStepId ?? addedIds.get(step.id),
      match?.relation ?? (addition?.initialStatus === "skipped" ? "skipped" : "planned"), now];
  });
  statements.push(
    ...bulkInsertStatements(c.env.DB, "run_step_plan_links",
      ["run_plan_revision_id", "template_step_id", "run_step_id", "relation", "created_at"], linkRows),
    c.env.DB.prepare(
      `UPDATE runs SET current_plan_revision_id = ?, template_version_id = ?,
              template_name_snapshot = ?, template_type_snapshot = ?, template_version_snapshot = ?,
              status = 'active', completed_at = NULL
       WHERE id = ? AND sample_id = ? AND status = ?
         AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(revisionId, input.templateVersionId, context.nextTemplate.name, context.nextTemplate.template_type,
      context.nextTemplate.version, runId, sampleId, reopening ? "complete" : "active", revisionId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'plan', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND current_plan_revision_id = ? AND deleted_at IS NULL
       )`,
    ).bind(crypto.randomUUID(), sampleId,
      `${reopening ? "Reopened process run with" : "Updated active plan to"} ${context.nextTemplate.name} v${context.nextTemplate.version}`,
      JSON.stringify({ runId, planRevisionId: revisionId, fromTemplateVersionId: context.run.current_template_version_id,
        toTemplateVersionId: input.templateVersionId, preserved: alignment.matches.length,
        added: alignment.additions.length, superseded: alignment.supersededStepIds.length,
        autoSkippedAdditions: alignment.additions.length - pendingAdditions.length,
        historicalDifferences: alignment.historicalDifferences, action: reopening ? "process_run_reopened" : "active_plan_updated",
        structureConfirmation: {
          previousStateHash: currentState.stateHash,
          templateStructureKey: comparisonTarget.key,
          templateStateHash: comparisonTarget.stateHash,
          templateStepId: comparisonTarget.stepId,
        } }), userEmail, now, runId, revisionId),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND current_plan_revision_id = ? AND deleted_at IS NULL
       )`,
    ).bind(userEmail, now, sampleId, runId, revisionId),
  );
  if (statements.length > 49) throw new HTTPException(413, { message: "This plan update is too large for one atomic operation" });
  try {
    const results = await c.env.DB.batch(statements);
    if (!results[0].meta.changes || !results[results.length - 3].meta.changes
      || !results[results.length - 2].meta.changes || !results[results.length - 1].meta.changes) {
      throw new HTTPException(409, { message: "The run or sample changed while the structures were being confirmed. Review them again." });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (/template version (archived|unavailable)/.test(String(error))) {
      throw new HTTPException(409, { message: "This process-template version became unavailable before the plan update was saved." });
    }
    throw error;
  }
  return c.json({ ok: true, planRevisionId: revisionId, revisionNumber: Number(context.run.revision_no) + 1 });
});

app.patch("/samples/:sampleId/runs/:runId/steps/:stepId", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<UpdateRunStepInput>();
  const allowed: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];
  if (!input.status || !allowed.includes(input.status) || typeof input.expectedUpdatedAt !== "string" || typeof input.title !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || typeof input.deviationNote !== "string" || typeof input.notes !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid editable step fields and expectedUpdatedAt are required" });
  const title = input.title.trim();
  if (!title) throw new HTTPException(400, { message: "Step title is required" });
  if (title.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000 || input.deviationNote.length > 4_000 || input.notes.length > 10_000) throw new HTTPException(400, { message: "One or more step fields are too long" });
  const asset = input.assetKey ? await c.env.DB.prepare("SELECT id, r2_key FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; r2_key: string }>() : null;
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const runStepAssetId = asset
    ? (await c.env.DB.prepare(
      "SELECT id FROM run_step_assets WHERE run_step_id = ? AND asset_id = ? AND role = 'execution'",
    ).bind(stepId, asset.id).first<{ id: string }>())?.id ?? crypto.randomUUID()
    : null;
  const step = await c.env.DB.prepare(
    `SELECT COALESCE(rs.title, sd.name) AS title, rs.status, rs.notes,
            COALESCE(rs.tool_name, sd.tool_name) AS tool_name,
            COALESCE(rs.parameters_text, sd.parameters_text) AS parameters_text,
            COALESCE(rs.comments_text, sd.comments_text) AS comments_text,
            sd.name AS planned_title, sd.tool_name AS planned_tool_name,
            sd.parameters_text AS planned_parameters_text, sd.comments_text AS planned_comments_text,
            rs.deviation_note, rs.origin, rs.updated_at
     FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     JOIN samples s ON s.id = r.sample_id
     LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(stepId, runId, sampleId).first<Record<string, string | null>>();
  if (!step) throw new HTTPException(404, { message: "Run step not found" });
  if (step.updated_at !== input.expectedUpdatedAt) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
  const now = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const notes = input.notes?.trim() || null;
  const toolName = input.toolName.trim() || null;
  const parametersText = input.parametersText.trim() || null;
  const commentsText = input.commentsText.trim() || null;
  const deviationNote = input.deviationNote.trim() || null;
  const titleOverride = title === step.planned_title ? null : title;
  const toolOverride = toolName === step.planned_tool_name ? null : toolName;
  const parametersOverride = parametersText === step.planned_parameters_text ? null : parametersText;
  const commentsOverride = commentsText === step.planned_comments_text ? null : commentsText;
  const mutationId = crypto.randomUUID();
  const statements = [
    c.env.DB.prepare(
      `UPDATE run_steps SET status = ?, title = ?, tool_name = ?, parameters_text = ?, comments_text = ?,
       deviation_note = ?, notes = ?, actualized_at = COALESCE(actualized_at, ?), updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runs
           JOIN samples s ON s.id = runs.sample_id
           WHERE runs.id = run_steps.run_id
             AND s.deleted_at IS NULL AND runs.deleted_at IS NULL
         )`,
    ).bind(input.status, titleOverride, toolOverride, parametersOverride, commentsOverride, deviationNote, notes, now, userEmail, mutationId, now, stepId, input.expectedUpdatedAt),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, r.sample_id, 'step', ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(crypto.randomUUID(), `${title}: ${input.status.replace("_", " ")}${deviationNote ? ` — deviation: ${deviationNote}` : notes ? ` — ${notes}` : ""}`, JSON.stringify({
      runId, stepId, action: "updated", origin: step.origin,
      previous: { title: step.title, status: step.status, toolName: step.tool_name, parametersText: step.parameters_text, commentsText: step.comments_text, deviationNote: step.deviation_note, notes: step.notes },
      current: { title, status: input.status, toolName, parametersText, commentsText, deviationNote, notes },
    }), userEmail, now, stepId, runId, sampleId, mutationId),
  ];
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO run_step_assets (id, run_step_id, asset_id, role, position, actor_email, created_at)
     SELECT ?, ?, ?, 'execution',
            COALESCE((SELECT MAX(position) FROM run_step_assets WHERE run_step_id = ? AND role = 'execution'), -1) + 1,
            ?, ?
     WHERE EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
     )`,
  ).bind(runStepAssetId, stepId, asset.id, stepId, userEmail, now, stepId, runId, sampleId, mutationId));
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `UPDATE run_step_assets SET deleted_at = NULL, deleted_by = NULL
     WHERE id = ? AND run_step_id = ? AND asset_id = ? AND role = 'execution'
       AND EXISTS (
         SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
         WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
           AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       )`,
  ).bind(runStepAssetId, stepId, asset.id, stepId, runId, sampleId, mutationId));
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, r.sample_id, 'image', ?, ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
       AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(crypto.randomUUID(), `Execution diagram for step: ${title}`, asset.r2_key,
    JSON.stringify({ runId, stepId, runStepAssetId }), userEmail, now, stepId, runId, sampleId, mutationId));
  statements.push(c.env.DB.prepare(
    `UPDATE samples SET updated_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
     )`,
  ).bind(userEmail, now, sampleId, stepId, runId, sampleId, mutationId));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
  if (!results[1].meta.changes || !results[results.length - 1].meta.changes) throw new Error("Atomic step record was not completed");
  return c.json({ ok: true });
});

app.delete("/samples/:sampleId/runs/:runId/steps/:stepId/assets", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<{ assetKey?: string }>();
  if (typeof input.assetKey !== "string" || !input.assetKey) throw new HTTPException(400, { message: "An image attachment is required" });
  const attachment = await c.env.DB.prepare(
    `SELECT rsa.id, rs.title, sd.name AS planned_title, rs.updated_at, s.updated_at AS sample_updated_at
     FROM run_step_assets rsa JOIN run_steps rs ON rs.id = rsa.run_step_id
     JOIN runs r ON r.id = rs.run_id JOIN samples s ON s.id = r.sample_id
     LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
     JOIN assets a ON a.id = rsa.asset_id
     WHERE rsa.run_step_id = ? AND r.id = ? AND r.sample_id = ? AND a.r2_key = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL
       AND rs.deleted_at IS NULL AND rsa.deleted_at IS NULL`,
  ).bind(stepId, runId, sampleId, input.assetKey).first<{ id: string; title: string | null; planned_title: string | null; updated_at: string; sample_updated_at: string }>();
  if (!attachment) throw new HTTPException(404, { message: "Execution image not found" });
  const now = new Date(Math.max(Date.now(), Date.parse(attachment.updated_at) + 1, Date.parse(attachment.sample_updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const title = attachment.title || attachment.planned_title || "Step";
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE run_step_assets
       SET deleted_at = ?, deleted_by = ?, last_mutation_id = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM run_steps rs
           JOIN runs r ON r.id = rs.run_id
           JOIN samples s ON s.id = r.sample_id
           WHERE rs.id = run_step_assets.run_step_id
             AND rs.id = ? AND r.id = ? AND s.id = ?
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL
             AND rs.deleted_at IS NULL
         )`,
    ).bind(now, userEmail, mutationId, attachment.id, stepId, runId, sampleId),
    c.env.DB.prepare(
      `UPDATE events SET asset_key = NULL,
         metadata_json = json_set(metadata_json,
           '$.runStepAssetId', ?, '$.assetDeletedAt', ?, '$.assetDeletedBy', ?,
           '$.assetMutationId', ?)
       WHERE sample_id = ? AND kind = 'image' AND asset_key = ? AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.runId') = ? AND json_extract(metadata_json, '$.stepId') = ?
         AND (json_extract(metadata_json, '$.runStepAssetId') IS NULL
           OR json_extract(metadata_json, '$.runStepAssetId') = ?)
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         )`,
    ).bind(
      attachment.id, now, userEmail, mutationId,
      sampleId, input.assetKey, runId, stepId, attachment.id,
      attachment.id, mutationId,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.run_step_id = run_steps.id
             AND rsa.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, stepId, runId, attachment.id, mutationId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'image', ?, ?, ?, ?
       FROM run_step_assets rsa
       JOIN run_steps rs ON rs.id = rsa.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         AND rs.id = ? AND r.id = ? AND s.id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(),
      `Deleted execution image attachment · ${title}`,
      JSON.stringify({ action: "execution_attachment_deleted", runId, stepId, hadAsset: true }),
      userEmail, now, attachment.id, mutationId, stepId, runId, sampleId,
    ),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM run_step_assets rsa
           JOIN run_steps rs ON rs.id = rsa.run_step_id
           JOIN runs r ON r.id = rs.run_id
           WHERE rsa.id = ? AND rsa.last_mutation_id = ?
             AND rs.id = ? AND r.id = ? AND r.sample_id = samples.id
             AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, sampleId, attachment.id, mutationId, stepId, runId),
  ]);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This execution image was already deleted" });
  return c.json({ ok: true, updatedAt: now });
});

app.post("/samples/:sampleId/runs/:runId/steps/:stepId/assets/restore", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<{ assetKey?: string }>();
  if (typeof input.assetKey !== "string" || !input.assetKey) {
    throw new HTTPException(400, { message: "An image attachment is required" });
  }
  const attachment = await c.env.DB.prepare(
    `SELECT rsa.id, rsa.deleted_at, rs.title, sd.name AS planned_title,
            rs.updated_at, s.updated_at AS sample_updated_at
     FROM run_step_assets rsa
     JOIN run_steps rs ON rs.id = rsa.run_step_id
     JOIN runs r ON r.id = rs.run_id
     JOIN samples s ON s.id = r.sample_id
     LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
     JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
     WHERE rsa.run_step_id = ? AND r.id = ? AND r.sample_id = ? AND a.r2_key = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       AND rsa.deleted_at IS NOT NULL`,
  ).bind(stepId, runId, sampleId, input.assetKey).first<{
    id: string; deleted_at: string; title: string | null; planned_title: string | null;
    updated_at: string; sample_updated_at: string;
  }>();
  if (!attachment) throw new HTTPException(404, { message: "Deleted execution image not found" });
  const now = new Date(Math.max(
    Date.now(), Date.parse(attachment.deleted_at) + 1,
    Date.parse(attachment.updated_at) + 1, Date.parse(attachment.sample_updated_at) + 1,
  )).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const title = attachment.title || attachment.planned_title || "Step";
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE run_step_assets
       SET deleted_at = NULL, deleted_by = NULL, last_mutation_id = ?
       WHERE id = ? AND deleted_at = ?
         AND EXISTS (
           SELECT 1
           FROM run_steps rs
           JOIN runs r ON r.id = rs.run_id
           JOIN samples s ON s.id = r.sample_id
           WHERE rs.id = run_step_assets.run_step_id
             AND rs.id = ? AND r.id = ? AND s.id = ?
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL
             AND rs.deleted_at IS NULL
         )`,
    ).bind(mutationId, attachment.id, attachment.deleted_at, stepId, runId, sampleId),
    c.env.DB.prepare(
      `UPDATE events SET asset_key = ?,
         metadata_json = json_remove(
           metadata_json, '$.assetDeletedAt', '$.assetDeletedBy',
           '$.assetMutationId', '$.assetDeletionOperationId'
         )
       WHERE sample_id = ? AND kind = 'image' AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.runId') = ?
         AND json_extract(metadata_json, '$.stepId') = ?
         AND json_extract(metadata_json, '$.assetDeletedAt') = ?
         AND (json_extract(metadata_json, '$.runStepAssetId') = ?
           OR json_extract(metadata_json, '$.runStepAssetId') IS NULL)
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         )`,
    ).bind(
      input.assetKey, sampleId, runId, stepId, attachment.deleted_at,
      attachment.id, attachment.id, mutationId,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.run_step_id = run_steps.id
             AND rsa.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, stepId, runId, attachment.id, mutationId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'image', ?, ?, ?, ?, ?
       FROM run_step_assets rsa
       JOIN run_steps rs ON rs.id = rsa.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         AND rs.id = ? AND r.id = ? AND s.id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(), `Restored execution image attachment · ${title}`, input.assetKey,
      JSON.stringify({ action: "execution_attachment_restored", runId, stepId }),
      userEmail, now, attachment.id, mutationId, stepId, runId, sampleId,
    ),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM run_step_assets rsa
           JOIN run_steps rs ON rs.id = rsa.run_step_id
           JOIN runs r ON r.id = rs.run_id
           WHERE rsa.id = ? AND rsa.last_mutation_id = ?
             AND rs.id = ? AND r.id = ? AND r.sample_id = samples.id
             AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, sampleId, attachment.id, mutationId, stepId, runId),
  ]);
  if (!results[0].meta.changes) {
    throw new HTTPException(409, { message: "The execution image changed while it was being restored" });
  }
  return c.json({ ok: true, updatedAt: now });
});

app.post("/samples/:sampleId/runs/:runId/steps", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<CreateRunStepInput>();
  if (typeof input.title !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || typeof input.deviationNote !== "string" || (input.afterStepId !== undefined && typeof input.afterStepId !== "string") || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid ad hoc step fields are required" });
  const title = input.title.trim();
  if (!title) throw new HTTPException(400, { message: "Step title is required" });
  if (title.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000 || input.deviationNote.length > 4_000) throw new HTTPException(400, { message: "One or more step fields are too long" });
  const definition = await hashStepDefinition({ name: title, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [run, stepRows, asset] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.anchor_step_id FROM runs r
       JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(runId, sampleId).first<{ id: string; anchor_step_id: string | null }>(),
    c.env.DB.prepare("SELECT id, position, updated_at FROM run_steps WHERE run_id = ? AND deleted_at IS NULL ORDER BY position")
      .bind(runId).all<{ id: string; position: number; updated_at: string }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id, r2_key FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; r2_key: string }>() : Promise.resolve(null),
  ]);
  if (!run) throw new HTTPException(404, { message: "Sample run not found" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const position = insertionPosition(stepRows.results, input.afterStepId);
  if (position === null) throw new HTTPException(404, { message: "Insertion point not found" });
  const stepId = crypto.randomUUID();
  const runStepAssetId = asset ? crypto.randomUUID() : null;
  const mutationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const afterIndex = input.afterStepId ? stepRows.results.findIndex((step) => step.id === input.afterStepId) : -1;
  const previousStepId = input.afterStepId ?? run.anchor_step_id;
  const nextStepId = stepRows.results[afterIndex + 1]?.id ?? null;
  const adjacentSteps = stepRows.results.filter((step) => step.id === input.afterStepId || step.id === nextStepId);
  const stepSnapshotSql = `AND (
       SELECT COUNT(*) FROM run_steps snapshot
       WHERE snapshot.run_id = runs.id AND snapshot.deleted_at IS NULL
     ) = ?
     ${adjacentSteps.map(() => `AND EXISTS (
       SELECT 1 FROM run_steps snapshot
       WHERE snapshot.run_id = runs.id AND snapshot.id = ?
         AND snapshot.position = ? AND snapshot.updated_at = ?
         AND snapshot.deleted_at IS NULL
     )`).join("\n")}`;
  const stepSnapshotBindings = [
    stepRows.results.length,
    ...adjacentSteps.flatMap((step) => [step.id, step.position, step.updated_at]),
  ];
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE runs SET last_mutation_id = ?
       WHERE id = ? AND sample_id = ? AND run_kind = 'process'
         AND status = 'active' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = runs.sample_id AND s.deleted_at IS NULL
         )
         ${stepSnapshotSql}`,
    ).bind(mutationId, runId, sampleId, ...stepSnapshotBindings),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO step_definitions
       (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM runs r
         WHERE r.id = ? AND r.last_mutation_id = ?
           AND r.status = 'active' AND r.deleted_at IS NULL
       )`,
    ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
      definition.canonical.parametersText, definition.canonical.commentsText,
      stableJson(definition.canonical), now, runId, mutationId),
    c.env.DB.prepare(
      `INSERT INTO run_steps
        (id, run_id, previous_step_id, position, title, status, origin, entry_kind, logical_step_key, definition_hash,
         tool_name, parameters_text, comments_text, deviation_note, actualized_at, created_at, updated_by, updated_at)
       SELECT ?, r.id, ?, ?, ?, 'pending', 'ad_hoc', 'fabrication', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM runs r JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.last_mutation_id = ?
         AND r.run_kind = 'process' AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(stepId, previousStepId, position, title, `ad-hoc:${stepId}`, definition.hash,
      input.toolName.trim() || null, input.parametersText.trim() || null, input.commentsText.trim() || null,
      input.deviationNote.trim() || null, now, now, userEmail, now,
      runId, sampleId, mutationId),
  ];
  if (nextStepId) statements.push(c.env.DB.prepare(
    `UPDATE run_steps SET previous_step_id = ?
     WHERE id = ? AND run_id = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
  ).bind(stepId, nextStepId, runId, stepId, runId, mutationId));
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `INSERT INTO run_step_assets
     (id, run_step_id, asset_id, role, position, actor_email, created_at)
     SELECT ?, inserted.id, ?, 'execution', 0, ?, ?
     FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
     WHERE inserted.id = ? AND inserted.run_id = ?
       AND r.last_mutation_id = ? AND r.status = 'active'
       AND r.deleted_at IS NULL`,
  ).bind(runStepAssetId, asset.id, userEmail, now, stepId, runId, mutationId));
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'step', ?, ?, ?, ?
       FROM run_steps inserted
       JOIN runs r ON r.id = inserted.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE inserted.id = ? AND inserted.run_id = ?
         AND r.last_mutation_id = ? AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(),
      `Added ad hoc step: ${title}`,
      JSON.stringify({
        runId,
        stepId,
        action: "added",
        afterStepId: input.afterStepId ?? null,
        deviationNote: input.deviationNote.trim() || null,
      }),
      userEmail,
      now,
      stepId,
      runId,
      mutationId,
    ),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
           WHERE inserted.id = ? AND inserted.run_id = ?
             AND r.sample_id = samples.id AND r.last_mutation_id = ?
             AND r.status = 'active' AND r.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, sampleId, stepId, runId, mutationId),
  );
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, s.id, 'image', ?, ?, ?, ?, ?
     FROM run_step_assets rsa
     JOIN run_steps inserted ON inserted.id = rsa.run_step_id
     JOIN runs r ON r.id = inserted.run_id
     JOIN samples s ON s.id = r.sample_id
     WHERE rsa.id = ? AND inserted.id = ? AND r.id = ?
       AND r.last_mutation_id = ? AND r.status = 'active'
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
  ).bind(
    crypto.randomUUID(),
    `Execution diagram for step: ${title}`,
    asset.r2_key,
    JSON.stringify({ runId, stepId, runStepAssetId, action: "execution_attachment_added" }),
    userEmail,
    now,
    runStepAssetId,
    stepId,
    runId,
    mutationId,
  ));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes || !results[2].meta.changes) {
    throw new HTTPException(409, { message: "The process run changed while the step was being added" });
  }
  return c.json({ id: stepId }, 201);
});

app.post("/samples/:sampleId/runs/:runId/metrology", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<CreateMetrologyRunEntryInput>();
  if (!input || typeof input.templateVersionId !== "string" || !input.templateVersionId
    || (input.afterStepId !== undefined && typeof input.afterStepId !== "string")) {
    throw new HTTPException(400, { message: "A metrology template and insertion point are required" });
  }
  const [run, template, stepRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.anchor_step_id FROM runs r
       JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(runId, sampleId).first<{ id: string; anchor_step_id: string | null }>(),
    c.env.DB.prepare(
      `SELECT tv.id, tv.name, tv.version, tv.recipe_family_id,
              ts.id AS template_step_id, ts.logical_step_key, ts.definition_hash
       FROM template_versions tv
       JOIN template_steps ts ON ts.template_version_id = tv.id
       WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL
         AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
    ).bind(input.templateVersionId).first<{
      id: string; name: string; version: number; recipe_family_id: string;
      template_step_id: string; logical_step_key: string; definition_hash: string;
    }>(),
    c.env.DB.prepare("SELECT id, position, updated_at FROM run_steps WHERE run_id = ? AND deleted_at IS NULL ORDER BY position")
      .bind(runId).all<{ id: string; position: number; updated_at: string }>(),
  ]);
  if (!run) throw new HTTPException(404, { message: "Active process run not found" });
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const position = insertionPosition(stepRows.results, input.afterStepId);
  if (position === null) throw new HTTPException(404, { message: "Insertion point not found" });
  const afterIndex = input.afterStepId ? stepRows.results.findIndex((step) => step.id === input.afterStepId) : -1;
  const nextStepId = stepRows.results[afterIndex + 1]?.id ?? null;
  const stepId = crypto.randomUUID();
  const mutationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const adjacentSteps = stepRows.results.filter((step) => step.id === input.afterStepId || step.id === nextStepId);
  const stepSnapshotSql = `AND (
       SELECT COUNT(*) FROM run_steps snapshot
       WHERE snapshot.run_id = runs.id AND snapshot.deleted_at IS NULL
     ) = ?
     ${adjacentSteps.map(() => `AND EXISTS (
       SELECT 1 FROM run_steps snapshot
       WHERE snapshot.run_id = runs.id AND snapshot.id = ?
         AND snapshot.position = ? AND snapshot.updated_at = ?
         AND snapshot.deleted_at IS NULL
     )`).join("\n")}`;
  const stepSnapshotBindings = [
    stepRows.results.length,
    ...adjacentSteps.flatMap((step) => [step.id, step.position, step.updated_at]),
  ];
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE runs SET last_mutation_id = ?
       WHERE id = ? AND sample_id = ? AND run_kind = 'process'
         AND status = 'active' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = runs.sample_id AND s.deleted_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM template_versions tv
           WHERE tv.id = ? AND tv.template_kind = 'metrology'
             AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
         )
         ${stepSnapshotSql}`,
    ).bind(mutationId, runId, sampleId, input.templateVersionId, ...stepSnapshotBindings),
    c.env.DB.prepare(
      `INSERT INTO run_steps
        (id, run_id, previous_step_id, position, status, origin, entry_kind, template_step_id,
         logical_step_key, definition_hash, actualized_at, created_at, updated_by, updated_at)
       SELECT ?, r.id, ?, ?, 'pending', 'ad_hoc', 'metrology', ?, ?, ?, ?, ?, ?, ?
       FROM runs r JOIN template_versions tv ON tv.id = ?
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND r.deleted_at IS NULL AND r.last_mutation_id = ?
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = r.sample_id AND s.deleted_at IS NULL
         )
         AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL`,
    ).bind(stepId, input.afterStepId ?? run.anchor_step_id, position, template.template_step_id,
      template.logical_step_key, template.definition_hash, now, now, userEmail, now,
      input.templateVersionId, runId, sampleId, mutationId),
  ];
  if (nextStepId) statements.push(c.env.DB.prepare(
    `UPDATE run_steps SET previous_step_id = ?
     WHERE id = ? AND run_id = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
  ).bind(stepId, nextStepId, runId, stepId, runId, mutationId));
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
    ).bind(crypto.randomUUID(), sampleId, `Added metrology: ${template.name}`,
      JSON.stringify({ runId, stepId, action: "metrology_added", templateVersionId: template.id, afterStepId: input.afterStepId ?? null }),
      userEmail, now, stepId, runId, mutationId),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
           WHERE inserted.id = ? AND inserted.run_id = ?
             AND r.sample_id = samples.id AND r.last_mutation_id = ?
             AND r.status = 'active' AND r.deleted_at IS NULL
             AND inserted.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, sampleId, stepId, runId, mutationId),
  );
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes || !results[1].meta.changes || !results.at(-1)?.meta.changes) {
    throw new HTTPException(409, { message: "The process run or metrology template changed while the record was being added" });
  }
  return c.json({ id: stepId }, 201);
});

app.post("/samples/:sampleId/metrology-runs", async (c) => {
  const sampleId = c.req.param("sampleId");
  const input = await c.req.json<StartMetrologyRunInput>();
  if (!input || typeof input.templateVersionId !== "string" || !input.templateVersionId) {
    throw new HTTPException(400, { message: "A metrology template is required" });
  }
  const [sample, template, latestSequence] = await Promise.all([
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL")
      .bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT tv.id, tv.name, tv.version, tv.recipe_family_id, tv.template_type,
              ts.id AS template_step_id, ts.logical_step_key, ts.definition_hash
       FROM template_versions tv
       JOIN template_steps ts ON ts.template_version_id = tv.id
       WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL
         AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
    ).bind(input.templateVersionId).first<{
      id: string; name: string; version: number; recipe_family_id: string; template_type: string;
      template_step_id: string; logical_step_key: string; definition_hash: string;
    }>(),
    c.env.DB.prepare("SELECT COALESCE(MAX(sequence_no), 0) AS sequence_no FROM runs WHERE sample_id = ?")
      .bind(sampleId).first<{ sequence_no: number }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id, run_kind,
         template_name_snapshot, template_type_snapshot, template_version_snapshot,
         created_by, created_at)
       SELECT ?, s.id, ?, ?, ?, ?, 'metrology', ?, ?, ?, ?, ?
       FROM samples s
       WHERE s.id = ? AND s.updated_at = ? AND s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM template_versions tv
           WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
             AND tv.deleted_at IS NULL
         )`,
    ).bind(runId, template.recipe_family_id, template.id, Number(latestSequence?.sequence_no ?? 0) + 1,
      crypto.randomUUID(), template.name, template.template_type, template.version, userEmail, now,
      sampleId, sample.updated_at, template.id),
    c.env.DB.prepare(
      `INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, template_step_id,
         logical_step_key, definition_hash, created_at, updated_by, updated_at)
       SELECT ?, ?, 1000, 'pending', 'template', 'metrology', ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology')`,
    ).bind(stepId, runId, template.template_step_id, template.logical_step_key,
      template.definition_hash, now, userEmail, now, runId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'run', ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology')`,
    ).bind(crypto.randomUUID(), sampleId, `Started metrology run · ${template.name}`,
      JSON.stringify({ runId, stepId, action: "metrology_run_started", templateVersionId: template.id }),
      userEmail, now, runId),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology' AND deleted_at IS NULL)`,
    ).bind(userEmail, now, sampleId, runId),
  ]);
  if (results.some((result) => !result.meta.changes)) {
    throw new HTTPException(409, { message: "The sample or metrology template changed while the run was being started" });
  }
  return c.json({ id: runId }, 201);
});

app.post("/run-step-comments", async (c) => {
  const input = await c.req.json<CreateRunStepCommentsInput>();
  if (!input || !["common", "individual"].includes(input.scope)
    || typeof input.body !== "string" || !validRunStepTargets(input.targets)
    || (input.assetKey !== undefined && typeof input.assetKey !== "string")) {
    throw new HTTPException(400, { message: "A valid comment and 1–12 step targets are required" });
  }
  const body = input.body.trim();
  const assetKey = input.assetKey?.trim() || null;
  if (!body && !assetKey) throw new HTTPException(400, { message: "Comment text or an image is required" });
  if (body.length > 10_000) throw new HTTPException(400, { message: "Comment is too long" });
  if (input.scope === "individual" && input.targets.length !== 1) {
    throw new HTTPException(400, { message: "An individual comment must target one sample step" });
  }

  const values = input.targets.map(() => "(?, ?, ?, ?)").join(", ");
  const bindings = input.targets.flatMap((target) => [target.sampleId, target.runId, target.stepId, target.expectedUpdatedAt]);
  const [matched, commentAsset] = await Promise.all([c.env.DB.prepare(
    `WITH requested(sample_id, run_id, step_id, expected_updated_at) AS (VALUES ${values})
     SELECT q.sample_id, q.run_id, q.step_id
     FROM requested q
     JOIN runs r ON r.id = q.run_id AND r.sample_id = q.sample_id
     JOIN run_steps rs ON rs.id = q.step_id AND rs.run_id = q.run_id
     JOIN samples s ON s.id = q.sample_id
     WHERE rs.updated_at = q.expected_updated_at
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(...bindings).all<{ sample_id: string; run_id: string; step_id: string }>(),
  assetKey ? c.env.DB.prepare(
    "SELECT id, r2_key FROM assets WHERE status = 'ready' AND r2_key = ?",
  ).bind(assetKey).first<{ id: string; r2_key: string }>() : Promise.resolve(null)]);
  if (matched.results.length !== input.targets.length) {
    throw new HTTPException(404, { message: "One or more sample steps were not found" });
  }
  if (assetKey && !commentAsset) throw new HTTPException(400, { message: "The uploaded comment image is unavailable" });

  const operationGroupId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const sampleIds = [...new Set(input.targets.map((target) => target.sampleId))];
  const occurrenceTargets = input.targets.map((target) => ({
    ...target,
    occurrenceId: crypto.randomUUID(),
  }));
  const requestedValues = occurrenceTargets.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const requestedBindings = occurrenceTargets.flatMap((target) => [
    target.occurrenceId,
    target.sampleId,
    target.runId,
    target.stepId,
    target.expectedUpdatedAt,
  ]);
  const occurrenceIds = occurrenceTargets.map((target) => target.occurrenceId);
  const occurrencePlaceholders = occurrenceIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [c.env.DB.prepare(
    `WITH requested(comment_id, sample_id, run_id, step_id, expected_updated_at) AS (
       VALUES ${requestedValues}
     ),
     valid AS (
       SELECT q.comment_id, q.step_id
       FROM requested q
       JOIN samples s ON s.id = q.sample_id AND s.deleted_at IS NULL
       JOIN runs r ON r.id = q.run_id AND r.sample_id = q.sample_id
         AND r.deleted_at IS NULL
       JOIN run_steps rs ON rs.id = q.step_id AND rs.run_id = q.run_id
         AND rs.deleted_at IS NULL
       WHERE rs.updated_at = q.expected_updated_at
     )
     INSERT INTO run_step_comments
       (id, run_step_id, scope, operation_group_id, body, asset_id, actor_email, created_at)
     SELECT valid.comment_id, valid.step_id, ?, ?, ?, ?, ?, ?
     FROM valid
     WHERE (SELECT COUNT(*) FROM valid) = ?`,
  ).bind(
    ...requestedBindings,
    input.scope,
    operationGroupId,
    body,
    commentAsset?.id ?? null,
    userEmail,
    now,
    occurrenceTargets.length,
  )];
  statements.push(c.env.DB.prepare(
    `UPDATE run_steps
     SET actualized_at = COALESCE(actualized_at, ?), updated_by = ?, updated_at = ?
     WHERE id IN (${occurrenceTargets.map(() => "?").join(", ")})
       AND deleted_at IS NULL
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${occurrencePlaceholders})
           AND rsc.operation_group_id = ?
           AND rsc.deleted_at IS NULL
       ) = ?`,
  ).bind(
    now,
    userEmail,
    now,
    ...occurrenceTargets.map((target) => target.stepId),
    ...occurrenceIds,
    operationGroupId,
    occurrenceTargets.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTargets = occurrenceTargets.filter((target) => target.sampleId === sampleId);
    const stepIds = sampleTargets.map((target) => target.stepId);
    const sampleOccurrenceIds = sampleTargets.map((target) => target.occurrenceId);
    const sampleOccurrencePlaceholders = sampleOccurrenceIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleOccurrencePlaceholders})
           AND rsc.operation_group_id = ?
           AND rsc.deleted_at IS NULL
       ) = ?`,
    ).bind(
      crypto.randomUUID(), sampleId,
      input.scope === "common" ? `Common step comment: ${body || "Image attached"}` : `Step comment: ${body || "Image attached"}`,
      commentAsset?.r2_key ?? null,
      JSON.stringify({ action: "step_comment", scope: input.scope, operationGroupId, stepIds }),
      userEmail, now,
      ...sampleOccurrenceIds,
      operationGroupId,
      sampleOccurrenceIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleOccurrencePlaceholders})
             AND rsc.operation_group_id = ?
             AND rsc.deleted_at IS NULL
         ) = ?`,
    ).bind(
      userEmail,
      now,
      sampleId,
      ...sampleOccurrenceIds,
      operationGroupId,
      sampleOccurrenceIds.length,
    ));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].meta.changes !== input.targets.length) {
    throw new HTTPException(409, { message: "One or more sample steps changed before the comment was saved" });
  }
  return c.json({ ok: true, operationGroupId }, 201);
});

app.delete("/run-step-comments/:id/asset", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id, a.r2_key
     FROM run_step_comments rsc
     JOIN run_steps rs ON rs.id = rsc.run_step_id
     JOIN runs r ON r.id = rs.run_id
     LEFT JOIN assets a ON a.id = rsc.asset_id
     WHERE rsc.id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NULL
       AND (
         rsc.submission_id IS NULL
         OR EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = rsc.submission_id
             AND cs.status = 'ready' AND cs.deleted_at IS NULL
         )
       )`,
  ).bind(commentId).first<{ id: string; scope: "common" | "individual"; operation_group_id: string | null; r2_key: string | null }>();
  if (!comment) throw new HTTPException(404, { message: "Step comment not found" });
  if (!comment.r2_key) throw new HTTPException(409, { message: "This comment attachment was already deleted" });
  const removeCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  if (removeCommonGroup && comment.operation_group_id) {
    await requireVisibleCommentOperationGroup(c.env.DB, comment.operation_group_id);
  }
  const targets = removeCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, rsc.body, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id JOIN samples s ON s.id = r.sample_id
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ? AND rsc.asset_id IS NOT NULL
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.operation_group_id).all<{ id: string; run_step_id: string; body: string; sample_id: string; updated_at: string; sample_updated_at: string }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, rsc.body, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id JOIN samples s ON s.id = r.sample_id
       WHERE rsc.id = ? AND rsc.asset_id IS NOT NULL
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.id).all<{ id: string; run_step_id: string; body: string; sample_id: string; updated_at: string; sample_updated_at: string }>();
  if (!targets.results.length) throw new HTTPException(409, { message: "This comment attachment was already deleted" });
  const latestUpdate = Math.max(...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map(Date.parse).filter(Number.isFinite));
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const deletionOperationId = crypto.randomUUID();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_step_comments
       SET asset_deleted_at = ?, asset_deleted_by = ?,
           asset_deletion_operation_id = ?, last_mutation_id = ?
       WHERE id IN (${targetPlaceholders})
         AND deleted_at IS NULL AND asset_id IS NOT NULL AND asset_deleted_at IS NULL
         AND (
           SELECT COUNT(*)
           FROM run_step_comments candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate.id IN (${targetPlaceholders})
             AND candidate.deleted_at IS NULL
             AND candidate.asset_id IS NOT NULL
             AND candidate.asset_deleted_at IS NULL
             AND (
               candidate.submission_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = candidate.submission_id
                   AND cs.status = 'ready' AND cs.deleted_at IS NULL
               )
             )
         ) = ?`,
    ).bind(
      now,
      userEmail,
      deletionOperationId,
      deletionOperationId,
      ...targetIds,
      ...targetIds,
      targetIds.length,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id IN (${targetPlaceholders})
             AND rsc.run_step_id = run_steps.id
             AND rsc.asset_deletion_operation_id = ?
             AND rsc.last_mutation_id = ?
         )`,
    ).bind(
      userEmail,
      now,
      ...stepIds,
      ...targetIds,
      deletionOperationId,
      deletionOperationId,
    ),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `UPDATE events SET asset_key = NULL,
       metadata_json = json_set(metadata_json,
         '$.assetDeletedAt', ?, '$.assetDeletedBy', ?,
         '$.assetDeletionOperationId', ?)
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${targetPlaceholders})
           AND rsc.asset_deletion_operation_id = ?
           AND rsc.last_mutation_id = ?
       ) = ?`,
  ).bind(
    now,
    userEmail,
    deletionOperationId,
    comment.operation_group_id,
    ...targetIds,
    deletionOperationId,
    deletionOperationId,
    targetIds.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTarget = targets.results.find((target) => target.sample_id === sampleId);
    const sampleTargetIds = targets.results
      .filter((target) => target.sample_id === sampleId)
      .map((target) => target.id);
    const sampleTargetPlaceholders = sampleTargetIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleTargetPlaceholders})
           AND rsc.asset_deletion_operation_id = ?
           AND rsc.last_mutation_id = ?
       ) = ?`,
    ).bind(crypto.randomUUID(), sampleId, `Deleted comment image attachment · ${sampleTarget?.body.trim() || "Image"}`,
      JSON.stringify({ action: "comment_attachment_deleted", operationGroupId: comment.operation_group_id, stepIds: targets.results.filter((target) => target.sample_id === sampleId).map((target) => target.run_step_id) }), userEmail, now,
      ...sampleTargetIds, deletionOperationId, deletionOperationId, sampleTargetIds.length));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.asset_deletion_operation_id = ?
             AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(
      userEmail,
      now,
      sampleId,
      ...sampleTargetIds,
      deletionOperationId,
      deletionOperationId,
      sampleTargetIds.length,
    ));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].meta.changes !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment attachment changed while it was being deleted" });
  }
  return c.json({ ok: true, updatedAt: now });
});

app.post("/run-step-comments/:id/asset/restore", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id, rsc.deleted_at,
            rsc.asset_deleted_at, rsc.asset_deletion_operation_id,
            rsc.submission_id,
            cs.status AS submission_status, cs.deleted_at AS submission_deleted_at
     FROM run_step_comments rsc
     JOIN run_steps rs ON rs.id = rsc.run_step_id
     JOIN runs r ON r.id = rs.run_id
     JOIN samples s ON s.id = r.sample_id
     LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id
     WHERE rsc.id = ? AND rsc.asset_id IS NOT NULL
       AND rsc.asset_deleted_at IS NOT NULL
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(commentId).first<{
    id: string; scope: "common" | "individual"; operation_group_id: string | null;
    deleted_at: string | null; asset_deleted_at: string;
    asset_deletion_operation_id: string | null; submission_id: string | null;
    submission_status: string | null; submission_deleted_at: string | null;
  }>();
  if (!comment) throw new HTTPException(404, { message: "Deleted comment attachment not found" });
  if (comment.submission_id
    && (comment.submission_status !== "ready" || comment.submission_deleted_at !== null)) {
    throw new HTTPException(409, { message: "Restore the canonical Comment before restoring this attachment" });
  }
  if (comment.deleted_at !== null) {
    throw new HTTPException(404, { message: "Deleted comment attachment not found" });
  }
  if (!comment.asset_deletion_operation_id) {
    throw new HTTPException(409, { message: "This deleted attachment has no recoverable operation identity" });
  }
  const restoreCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  if (restoreCommonGroup && comment.operation_group_id) {
    await requireVisibleCommentOperationGroup(c.env.DB, comment.operation_group_id);
  }
  const targets = restoreCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, r.sample_id, a.r2_key,
              rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       JOIN assets a ON a.id = rsc.asset_id AND a.status = 'ready'
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ?
         AND rsc.deleted_at IS NULL AND rsc.asset_deletion_operation_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.operation_group_id, comment.asset_deletion_operation_id).all<{
      id: string; run_step_id: string; sample_id: string; r2_key: string;
      updated_at: string; sample_updated_at: string;
    }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, r.sample_id, a.r2_key,
              rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       JOIN assets a ON a.id = rsc.asset_id AND a.status = 'ready'
       WHERE rsc.id = ? AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NOT NULL
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.id).all<{
      id: string; run_step_id: string; sample_id: string; r2_key: string;
      updated_at: string; sample_updated_at: string;
    }>();
  if (!targets.results.length) throw new HTTPException(404, { message: "Deleted comment attachment not found" });
  const latestUpdate = Math.max(
    Date.parse(comment.asset_deleted_at),
    ...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map(Date.parse),
  );
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_step_comments
       SET asset_deleted_at = NULL, asset_deleted_by = NULL,
           asset_deletion_operation_id = NULL, last_mutation_id = ?
       WHERE id IN (${targetPlaceholders}) AND asset_deletion_operation_id = ?
         AND (
           SELECT COUNT(*)
           FROM run_step_comments candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate.id IN (${targetPlaceholders})
             AND candidate.deleted_at IS NULL
             AND candidate.asset_deletion_operation_id = ?
             AND (
               candidate.submission_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = candidate.submission_id
                   AND cs.status = 'ready' AND cs.deleted_at IS NULL
               )
             )
         ) = ?`,
    ).bind(
      mutationId,
      ...targetIds,
      comment.asset_deletion_operation_id,
      ...targetIds,
      comment.asset_deletion_operation_id,
      targetIds.length,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id IN (${targetPlaceholders})
             AND rsc.run_step_id = run_steps.id
             AND rsc.asset_deleted_at IS NULL
             AND rsc.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, ...stepIds, ...targetIds, mutationId),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `UPDATE events SET asset_key = ?,
       metadata_json = json_remove(
         metadata_json, '$.assetDeletedAt', '$.assetDeletedBy',
         '$.assetDeletionOperationId'
       )
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?
       AND json_extract(metadata_json, '$.assetDeletionOperationId') = ?
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${targetPlaceholders})
           AND rsc.asset_deleted_at IS NULL AND rsc.last_mutation_id = ?
       ) = ?`,
  ).bind(
    targets.results[0].r2_key,
    comment.operation_group_id,
    comment.asset_deletion_operation_id,
    ...targetIds,
    mutationId,
    targetIds.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTargetIds = targets.results
      .filter((target) => target.sample_id === sampleId)
      .map((target) => target.id);
    const sampleTargetPlaceholders = sampleTargetIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.asset_deleted_at IS NULL AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(userEmail, now, sampleId, ...sampleTargetIds, mutationId, sampleTargetIds.length));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].meta.changes !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment attachment changed while it was being restored" });
  }
  return c.json({ ok: true, updatedAt: now });
});

app.delete("/run-step-comments/:id", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id
     FROM run_step_comments rsc
     JOIN run_steps rs ON rs.id = rsc.run_step_id
     JOIN runs r ON r.id = rs.run_id
     WHERE rsc.id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       AND rsc.deleted_at IS NULL
       AND (
         rsc.submission_id IS NULL
         OR EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = rsc.submission_id
             AND cs.status = 'ready' AND cs.deleted_at IS NULL
         )
       )`,
  ).bind(commentId).first<{
    id: string; scope: "common" | "individual"; operation_group_id: string | null;
  }>();
  if (!comment) throw new HTTPException(404, { message: "Step comment not found" });

  const removeCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  if (removeCommonGroup && comment.operation_group_id) {
    await requireVisibleCommentOperationGroup(c.env.DB, comment.operation_group_id);
  }
  const targets = removeCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, rsc.body, rsc.asset_id, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND rsc.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.operation_group_id).all<{ id: string; run_step_id: string; body: string; asset_id: string | null; sample_id: string; updated_at: string; sample_updated_at: string }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, rsc.body, rsc.asset_id, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsc.id = ? AND s.deleted_at IS NULL AND r.deleted_at IS NULL
         AND rs.deleted_at IS NULL AND rsc.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.id).all<{ id: string; run_step_id: string; body: string; asset_id: string | null; sample_id: string; updated_at: string; sample_updated_at: string }>();
  if (!targets.results.length) throw new HTTPException(404, { message: "Step comment not found" });

  const latestUpdate = Math.max(...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map((value) => Date.parse(value)).filter(Number.isFinite));
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const deletionOperationId = crypto.randomUUID();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_step_comments
       SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
           last_mutation_id = ?, updated_at = ?, updated_by = ?
       WHERE id IN (${targetPlaceholders}) AND deleted_at IS NULL
         AND (
           SELECT COUNT(*)
           FROM run_step_comments candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate.id IN (${targetPlaceholders})
             AND candidate.deleted_at IS NULL
             AND (
               candidate.submission_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = candidate.submission_id
                   AND cs.status = 'ready' AND cs.deleted_at IS NULL
               )
             )
         ) = ?`,
    ).bind(
      now,
      userEmail,
      deletionOperationId,
      deletionOperationId,
      now,
      userEmail,
      ...targetIds,
      ...targetIds,
      targetIds.length,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id IN (${targetPlaceholders})
             AND rsc.run_step_id = run_steps.id
             AND rsc.deletion_operation_id = ?
             AND rsc.last_mutation_id = ?
         )`,
    ).bind(
      userEmail,
      now,
      ...stepIds,
      ...targetIds,
      deletionOperationId,
      deletionOperationId,
    ),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `UPDATE events SET asset_key = NULL,
       metadata_json = json_set(metadata_json,
         '$.deletedAt', ?, '$.deletedBy', ?, '$.deletionOperationId', ?)
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${targetPlaceholders})
           AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
       ) = ?`,
  ).bind(
    now,
    userEmail,
    deletionOperationId,
    comment.operation_group_id,
    ...targetIds,
    deletionOperationId,
    deletionOperationId,
    targetIds.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTargets = targets.results.filter((target) => target.sample_id === sampleId);
    const sampleStepIds = sampleTargets.map((target) => target.run_step_id);
    const sampleTargetIds = sampleTargets.map((target) => target.id);
    const sampleTargetPlaceholders = sampleTargetIds.map(() => "?").join(", ");
    const deletedSummary = sampleTargets[0]?.body.trim() || (sampleTargets.some((target) => target.asset_id) ? "Image attachment" : "Empty comment");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleTargetPlaceholders})
           AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
       ) = ?`,
    ).bind(
      crypto.randomUUID(), sampleId,
      `Deleted ${removeCommonGroup ? "common " : ""}step comment · ${deletedSummary}`,
      JSON.stringify({ action: "step_comment_deleted", operationGroupId: comment.operation_group_id, stepIds: sampleStepIds, hadAsset: sampleTargets.some((target) => Boolean(target.asset_id)) }),
      userEmail, now, ...sampleTargetIds,
      deletionOperationId, deletionOperationId, sampleTargetIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(
      userEmail,
      now,
      sampleId,
      ...sampleTargetIds,
      deletionOperationId,
      deletionOperationId,
      sampleTargetIds.length,
    ));
  }

  const results = await c.env.DB.batch(statements);
  const deleted = results[0].meta.changes ?? 0;
  if (deleted !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment changed while it was being deleted" });
  }
  return c.json({ ok: true, deleted });
});

app.post("/run-step-comments/:id/restore", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id, rsc.deleted_at,
            rsc.deletion_operation_id, rsc.submission_id,
            cs.status AS submission_status,
            cs.deleted_at AS submission_deleted_at
     FROM run_step_comments rsc
     LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id
     WHERE rsc.id = ? AND rsc.deleted_at IS NOT NULL`,
  ).bind(commentId).first<{
    id: string; scope: "common" | "individual"; operation_group_id: string | null;
    deleted_at: string; deletion_operation_id: string | null;
    submission_id: string | null; submission_status: string | null;
    submission_deleted_at: string | null;
  }>();
  if (!comment) throw new HTTPException(404, { message: "Deleted step comment not found" });
  if (comment.submission_id
    && (comment.submission_status !== "ready" || comment.submission_deleted_at !== null)) {
    throw new HTTPException(409, { message: "Restore the canonical Comment before restoring this comment" });
  }
  if (!comment.deletion_operation_id) {
    throw new HTTPException(409, { message: "This deleted comment has no recoverable operation identity" });
  }
  const restoreCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  if (restoreCommonGroup && comment.operation_group_id) {
    await requireVisibleCommentOperationGroup(c.env.DB, comment.operation_group_id);
  }
  const targets = restoreCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, rsc.body, r.sample_id, a.r2_key,
              rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       LEFT JOIN assets a ON a.id = rsc.asset_id AND a.status = 'ready'
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ?
         AND rsc.deletion_operation_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.operation_group_id, comment.deletion_operation_id).all<{
      id: string; run_step_id: string; body: string; sample_id: string; r2_key: string | null;
      updated_at: string; sample_updated_at: string;
    }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, rsc.body, r.sample_id, a.r2_key,
              rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       LEFT JOIN assets a ON a.id = rsc.asset_id AND a.status = 'ready'
       WHERE rsc.id = ? AND rsc.deleted_at IS NOT NULL
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.id).all<{
      id: string; run_step_id: string; body: string; sample_id: string; r2_key: string | null;
      updated_at: string; sample_updated_at: string;
    }>();
  if (!targets.results.length) throw new HTTPException(409, { message: "Restore the comment source before restoring this comment" });
  const latestUpdate = Math.max(
    Date.parse(comment.deleted_at),
    ...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map(Date.parse),
  );
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_step_comments
       SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
           last_mutation_id = ?, updated_at = ?, updated_by = ?
       WHERE id IN (${targetPlaceholders}) AND deletion_operation_id = ?
         AND (
           submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = run_step_comments.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )
         AND (
           SELECT COUNT(*)
           FROM run_step_comments candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate.id IN (${targetPlaceholders})
             AND candidate.deletion_operation_id = ?
             AND (
               candidate.submission_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = candidate.submission_id
                   AND cs.status = 'ready' AND cs.deleted_at IS NULL
               )
             )
         ) = ?`,
    ).bind(
      mutationId,
      now,
      userEmail,
      ...targetIds,
      comment.deletion_operation_id,
      ...targetIds,
      comment.deletion_operation_id,
      targetIds.length,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id IN (${targetPlaceholders})
             AND rsc.run_step_id = run_steps.id
             AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, ...stepIds, ...targetIds, mutationId),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `UPDATE events SET asset_key = ?,
       metadata_json = json_remove(
         metadata_json, '$.deletedAt', '$.deletedBy', '$.deletionOperationId'
       )
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?
       AND json_extract(metadata_json, '$.deletionOperationId') = ?
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${targetPlaceholders})
           AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
       ) = ?`,
  ).bind(
    targets.results[0].r2_key,
    comment.operation_group_id,
    comment.deletion_operation_id,
    ...targetIds,
    mutationId,
    targetIds.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTarget = targets.results.find((target) => target.sample_id === sampleId);
    const sampleTargetIds = targets.results
      .filter((target) => target.sample_id === sampleId)
      .map((target) => target.id);
    const sampleTargetPlaceholders = sampleTargetIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleTargetPlaceholders})
           AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
       ) = ?`,
    ).bind(
      crypto.randomUUID(), sampleId,
      `Restored ${restoreCommonGroup ? "common " : ""}step comment · ${sampleTarget?.body.trim() || "Image attachment"}`,
      JSON.stringify({ action: "step_comment_restored", operationGroupId: comment.operation_group_id,
        stepIds: targets.results.filter((target) => target.sample_id === sampleId).map((target) => target.run_step_id) }),
      userEmail, now, ...sampleTargetIds, mutationId, sampleTargetIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(userEmail, now, sampleId, ...sampleTargetIds, mutationId, sampleTargetIds.length));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].meta.changes !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment changed while it was being restored" });
  }
  return c.json({ ok: true, restored: results[0].meta.changes ?? 0, updatedAt: now });
});

app.post("/run-steps/confirm", async (c) => {
  const input = await c.req.json<ConfirmRunStepsInput>();
  if (!input || !validRunStepTargets(input.targets)) {
    throw new HTTPException(400, { message: "Between 1 and 12 step targets are required" });
  }
  const operationGroupId = crypto.randomUUID();
  const expectedTimes = input.targets.map((target) => Date.parse(target.expectedUpdatedAt)).filter(Number.isFinite);
  const now = new Date(Math.max(Date.now(), ...expectedTimes.map((value) => value + 1))).toISOString();
  const userEmail = c.get("userEmail");
  const values = input.targets.map(() => "(?, ?, ?, ?)").join(", ");
  const bindings = input.targets.flatMap((target) => [target.sampleId, target.runId, target.stepId, target.expectedUpdatedAt]);
  const statements: D1PreparedStatement[] = [c.env.DB.prepare(
    `WITH requested(sample_id, run_id, step_id, expected_updated_at) AS (VALUES ${values}),
     valid AS (
       SELECT q.step_id
       FROM requested q
       JOIN runs r ON r.id = q.run_id AND r.sample_id = q.sample_id
       JOIN run_steps rs ON rs.id = q.step_id AND rs.run_id = q.run_id
       JOIN samples s ON s.id = q.sample_id
       WHERE rs.updated_at = q.expected_updated_at AND rs.status IN ('pending', 'in_progress')
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
     )
     UPDATE run_steps
     SET status = 'done', actualized_at = COALESCE(actualized_at, ?), updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id IN (SELECT step_id FROM valid)
       AND (SELECT COUNT(*) FROM valid) = ?
     RETURNING id`,
  ).bind(...bindings, now, userEmail, operationGroupId, now, input.targets.length)];

  const sampleIds = [...new Set(input.targets.map((target) => target.sampleId))];
  for (const sampleId of sampleIds) {
    const stepIds = input.targets.filter((target) => target.sampleId === sampleId).map((target) => target.stepId);
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM run_steps WHERE last_mutation_id = ? AND id IN (${stepIds.map(() => "?").join(", ")})
       )`,
    ).bind(
      crypto.randomUUID(), sampleId, `Confirmed ${stepIds.length} step${stepIds.length === 1 ? "" : "s"} as done`,
      JSON.stringify({ action: "confirmed_done", operationGroupId, stepIds }), userEmail, now,
      operationGroupId, ...stepIds,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM run_steps WHERE last_mutation_id = ? AND id IN (${stepIds.map(() => "?").join(", ")})
       )`,
    ).bind(userEmail, now, sampleId, operationGroupId, ...stepIds));
  }
  const results = await c.env.DB.batch(statements);
  if (!returnedEveryConfirmationTarget(results[0].results, input.targets.map((target) => target.stepId))) {
    throw new HTTPException(409, { message: "One or more steps changed elsewhere. Reload before confirming." });
  }
  return c.json({ ok: true, confirmed: input.targets.length });
});

app.post("/samples/:sampleId/runs/:runId/steps/:stepId/verify-state", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<CreateStateVerificationInput>();
  if (!input || !["matched", "mismatched"].includes(input.result)
    || typeof input.note !== "string" || typeof input.expectedUpdatedAt !== "string"
    || (input.completeStep !== undefined && typeof input.completeStep !== "boolean")
    || (input.assetKey !== undefined && typeof input.assetKey !== "string")) {
    throw new HTTPException(400, { message: "A valid verification result and current step timestamp are required" });
  }
  if (input.note.length > 10_000) throw new HTTPException(400, { message: "Verification note is too long" });
  const [target, evidence, previous, chainRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT rs.id, rs.status, rs.updated_at, rs.expected_state_hash, rs.position,
              r.sequence_no, r.current_plan_revision_id, r.recipe_family_id, r.template_version_id
       FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?
         AND r.run_kind = 'process' AND rs.entry_kind = 'fabrication'
         AND rs.plan_status = 'current'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(stepId, runId, sampleId).first<{
      id: string; status: StepStatus; updated_at: string; expected_state_hash: string | null;
      position: number; sequence_no: number; current_plan_revision_id: string;
      recipe_family_id: string; template_version_id: string;
    }>(),
    input.assetKey ? c.env.DB.prepare(
      "SELECT id, r2_key FROM assets WHERE status = 'ready' AND r2_key = ?",
    ).bind(input.assetKey).first<{ id: string; r2_key: string }>() : Promise.resolve(null),
    c.env.DB.prepare(
      `SELECT sv.id, sv.after_run_step_id
       FROM state_verifications sv
       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
       JOIN runs endpoint_run ON endpoint_run.id = endpoint.run_id
       WHERE sv.sample_id = ? AND sv.status = 'valid'
         AND endpoint_run.deleted_at IS NULL AND endpoint.deleted_at IS NULL
       ORDER BY sv.created_at DESC, sv.id DESC LIMIT 1`,
    ).bind(sampleId).first<{ id: string; after_run_step_id: string }>(),
    c.env.DB.prepare(
      `SELECT rs.id, rs.status, rs.plan_status, rs.actualized_at, r.sequence_no, rs.position
       FROM runs r JOIN run_steps rs ON rs.run_id = r.id
       WHERE r.sample_id = ? AND r.run_kind = 'process' AND rs.entry_kind = 'fabrication'
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       ORDER BY r.sequence_no, rs.position`,
    ).bind(sampleId).all<{
      id: string; status: StepStatus; plan_status: "current" | "superseded";
      actualized_at: string | null; sequence_no: number; position: number;
    }>(),
  ]);
  if (!target) throw new HTTPException(404, { message: "Current run step not found" });
  if (target.updated_at !== input.expectedUpdatedAt) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before verifying its state." });
  if (input.assetKey && !evidence) throw new HTTPException(400, { message: "The verification image is unavailable" });

  const targetIndex = chainRows.results.findIndex((step) => step.id === stepId);
  const previousIndex = previous ? chainRows.results.findIndex((step) => step.id === previous.after_run_step_id) : -1;
  if (targetIndex < 0 || previousIndex >= targetIndex) throw new HTTPException(409, { message: "The verification endpoint is not after the previous verified state" });
  const segment = chainRows.results.slice(previousIndex + 1, targetIndex + 1)
    .filter((step) => step.plan_status === "current" || step.actualized_at);
  const incomplete = segment.find((step) => step.plan_status === "current"
    && !["done", "skipped"].includes(step.status)
    && !(step.id === stepId && input.completeStep));
  if (incomplete) throw new HTTPException(409, { message: "Finish or skip each current step since the previous verification before verifying this state" });
  const covered = segment.filter((step) => step.actualized_at || step.id === stepId);

  const now = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const verificationId = crypto.randomUUID();
  const note = input.note.trim() || null;
  const coveredJson = JSON.stringify(covered.map((step, ordinal) => ({ stepId: step.id, ordinal })));
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `WITH covered AS MATERIALIZED (
         SELECT CAST(json_extract(value, '$.stepId') AS TEXT) AS run_step_id
         FROM json_each(?)
       )
       UPDATE run_steps SET status = CASE WHEN ? THEN 'done' ELSE status END,
              actualized_at = COALESCE(actualized_at, ?), updated_by = ?,
              last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND updated_at = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runs r JOIN samples s ON s.id = r.sample_id
           WHERE r.id = run_steps.run_id AND r.id = ? AND r.sample_id = ?
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL
         )
         AND (
           SELECT COUNT(*)
           FROM run_steps covered_step
           JOIN runs covered_run ON covered_run.id = covered_step.run_id
           JOIN samples covered_sample ON covered_sample.id = covered_run.sample_id
           WHERE covered_step.id IN (SELECT run_step_id FROM covered)
             AND covered_run.sample_id = ?
             AND covered_sample.deleted_at IS NULL
             AND covered_run.deleted_at IS NULL
             AND covered_step.deleted_at IS NULL
         ) = ?`,
    ).bind(
      coveredJson,
      input.completeStep ? 1 : 0,
      now,
      userEmail,
      verificationId,
      now,
      stepId,
      runId,
      input.expectedUpdatedAt,
      runId,
      sampleId,
      sampleId,
      covered.length,
    ),
    c.env.DB.prepare(
      `INSERT INTO state_verifications
       (id, sample_id, after_run_step_id, previous_verification_id, run_plan_revision_id,
        expected_state_hash, result, evidence_asset_id, note, actor_email, created_at)
       SELECT ?, s.id, rs.id, ?, ?, ?, ?, ?, ?, ?, ?
       FROM run_steps rs
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rs.id = ? AND r.id = ? AND s.id = ?
         AND rs.last_mutation_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(
      verificationId,
      previous?.id ?? null,
      target.current_plan_revision_id,
      target.expected_state_hash,
      input.result,
      evidence?.id ?? null,
      note,
      userEmail,
      now,
      stepId,
      runId,
      sampleId,
      verificationId,
    ),
    c.env.DB.prepare(
      `WITH covered AS MATERIALIZED (
         SELECT CAST(json_extract(value, '$.stepId') AS TEXT) AS run_step_id,
                CAST(json_extract(value, '$.ordinal') AS INTEGER) AS ordinal
         FROM json_each(?)
       )
       INSERT INTO state_verification_steps (verification_id, run_step_id, ordinal)
       SELECT ?, covered.run_step_id, covered.ordinal
       FROM covered
       JOIN run_steps rs ON rs.id = covered.run_step_id AND rs.deleted_at IS NULL
       JOIN runs r ON r.id = rs.run_id AND r.deleted_at IS NULL
       JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
       WHERE s.id = ?
         AND EXISTS (
           SELECT 1
           FROM state_verifications sv
           JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
           WHERE sv.id = ? AND endpoint.last_mutation_id = ?
         )
         AND (
           SELECT COUNT(*)
           FROM covered candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate_sample.id = ?
       ) = ?`,
    ).bind(
      coveredJson,
      verificationId,
      sampleId,
      verificationId,
      verificationId,
      sampleId,
      covered.length,
    ),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'verification', ?, ?, ?, ?, ?
       FROM state_verifications sv
       JOIN samples s ON s.id = sv.sample_id
       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
       WHERE sv.id = ? AND endpoint.last_mutation_id = ?
         AND s.deleted_at IS NULL`,
    ).bind(crypto.randomUUID(),
      `State ${input.result === "matched" ? "verified" : "mismatch recorded"} after ${covered.length} step${covered.length === 1 ? "" : "s"}`,
      evidence?.r2_key ?? null,
      JSON.stringify({ verificationId, runId, stepId, previousVerificationId: previous?.id ?? null, coveredStepIds: covered.map((step) => step.id), result: input.result }),
      userEmail, now, verificationId, verificationId),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM state_verifications sv
           JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
           WHERE sv.id = ? AND sv.sample_id = samples.id
             AND endpoint.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, sampleId, verificationId, verificationId),
  ];
  if (input.result === "mismatched") statements.push(c.env.DB.prepare(
    `INSERT INTO recipe_change_proposals
     (id, recipe_family_id, source_template_version_id, source_verification_id, change_type, body, actor_email, created_at)
     SELECT ?, ?, ?, sv.id, 'expected_state', ?, ?, ?
     FROM state_verifications sv
     JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
     WHERE sv.id = ? AND endpoint.last_mutation_id = ?`,
  ).bind(
    crypto.randomUUID(),
    target.recipe_family_id,
    target.template_version_id,
    note || "Observed state did not match the process template's expected state",
    userEmail,
    now,
    verificationId,
    verificationId,
  ));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before verifying its state." });
  return c.json({
    verification: {
      id: verificationId, sampleId, afterRunStepId: stepId, previousVerificationId: previous?.id ?? null,
      runPlanRevisionId: target.current_plan_revision_id, expectedStateHash: target.expected_state_hash,
      result: input.result, note, status: "valid", actorEmail: userEmail, createdAt: now,
      coveredRunStepIds: covered.map((step) => step.id),
    },
  }, 201);
});

app.post("/assets", async (c) => {
  if (!contentLengthWithin(c.req.raw, 10 * 1024 * 1024)) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: "Ordinary asset uploads must be images" });
  const filename = c.req.header("x-filename") || "upload";
  if (filename.length > 255 || contentType.length > 200) throw new HTTPException(400, { message: "Asset metadata is too long" });
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const sha256 = await digestSha256(buffer);
  const existing = await c.env.DB.prepare(
    "SELECT id, r2_key FROM assets WHERE sha256 = ? AND status = 'ready' LIMIT 1",
  ).bind(sha256).first<{ id: string; r2_key: string }>();
  if (existing) return c.json({ id: existing.id, key: existing.r2_key, deduplicated: true });

  const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
  try {
    await c.env.DB.prepare(
      `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
    ).bind(id, key, filename, contentType, buffer.byteLength, c.get("userEmail"), now, sha256).run();
  } catch (error) {
    await c.env.ASSETS.delete(key);
    if (String(error).includes("UNIQUE")) {
      const winner = await c.env.DB.prepare(
        "SELECT id, r2_key FROM assets WHERE sha256 = ? AND status = 'ready' LIMIT 1",
      ).bind(sha256).first<{ id: string; r2_key: string }>();
      if (winner) return c.json({ id: winner.id, key: winner.r2_key, deduplicated: true });
    }
    throw error;
  }
  return c.json({ id, key, deduplicated: false }, 201);
});

app.get("/assets/:key{.+}", async (c) => {
  const object = await c.env.ASSETS.get(c.req.param("key"));
  if (!object) throw new HTTPException(404, { message: "Asset not found" });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-content-type-options", "nosniff");
  if (!headers.get("content-type")?.startsWith("image/")) headers.set("content-disposition", "attachment");
  return new Response(object.body, { headers });
});

app.get("/exports/all", async (c) => {
  const tableQueries = {
    samples: "SELECT * FROM samples ORDER BY created_at, id",
    events: "SELECT * FROM events ORDER BY created_at, id",
    recipe_families: "SELECT * FROM recipe_families ORDER BY created_at, id",
    step_definitions: "SELECT * FROM step_definitions ORDER BY hash",
    state_representations: "SELECT * FROM state_representations ORDER BY hash",
    state_representation_assets: "SELECT * FROM state_representation_assets ORDER BY state_hash, position",
    template_versions: "SELECT * FROM template_versions ORDER BY created_at, id",
    template_steps: "SELECT * FROM template_steps ORDER BY template_version_id, position",
    metrology_template_references: "SELECT * FROM metrology_template_references ORDER BY template_version_id, position, id",
    runs: "SELECT * FROM runs ORDER BY created_at, id",
    run_plan_revisions: "SELECT * FROM run_plan_revisions ORDER BY run_id, revision_no",
    run_steps: "SELECT * FROM run_steps ORDER BY run_id, position",
    run_step_plan_links: "SELECT * FROM run_step_plan_links ORDER BY run_plan_revision_id, template_step_id",
    run_step_comments: "SELECT * FROM run_step_comments ORDER BY run_step_id, created_at, id",
    run_step_assets: "SELECT * FROM run_step_assets ORDER BY run_step_id, role, position",
    state_verifications: "SELECT * FROM state_verifications ORDER BY sample_id, created_at, id",
    state_verification_steps: "SELECT * FROM state_verification_steps ORDER BY verification_id, ordinal",
    recipe_change_proposals: "SELECT * FROM recipe_change_proposals ORDER BY created_at, id",
    imports: "SELECT * FROM imports ORDER BY created_at, id",
    assets: "SELECT * FROM assets ORDER BY created_at, id",
    comment_submissions: "SELECT * FROM comment_submissions ORDER BY created_at, id",
    comment_submission_targets: "SELECT * FROM comment_submission_targets ORDER BY submission_id, run_step_id",
    comment_submission_items: "SELECT * FROM comment_submission_items ORDER BY submission_id, position",
    managed_storage_objects: "SELECT * FROM managed_storage_objects ORDER BY created_at, id",
  } as const;
  const names = Object.keys(tableQueries);
  const results = await c.env.DB.batch(Object.values(tableQueries).map((sql) => c.env.DB.prepare(sql)));
  const entries = names.map((name, index) => [name, results[index].results ?? []] as const);
  const tables = Object.fromEntries(entries) as Record<string, Array<Record<string, unknown>>>;
  const managedAttachments = (tables.comment_submission_items ?? []).flatMap((item) => {
    if (item.kind !== "attachment" || item.status !== "ready" || typeof item.storage_object_id !== "string") return [];
    const object = (tables.managed_storage_objects ?? []).find((candidate) => candidate.id === item.storage_object_id);
    if (!object || object.status !== "ready") return [];
    return [{
      itemId: String(item.id),
      filename: String(item.filename || object.original_name || "attachment"),
      byteSize: Number(item.byte_size || object.byte_size || 0),
      sha256: String(item.sha256 || object.sha256 || ""),
      downloadUrl: `/api/exports/attachments/${encodeURIComponent(String(item.id))}`,
    }];
  });
  return c.json({
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    tables,
    assetKeys: collectExportAssetKeys(tables.assets, tables.imports),
    managedAttachments,
  });
});

app.post("/imports/fabublox", async (c) => {
  if (!contentLengthWithin(c.req.raw, 50 * 1024 * 1024)) throw new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
  const form = await c.req.raw.formData();
  const workbook = form.get("workbook");
  const manifestFile = form.get("manifest");
  if (!(workbook instanceof File) || !(manifestFile instanceof File)) throw new HTTPException(400, { message: "Workbook and manifest files are required" });
  let parsedManifest: unknown;
  try { parsedManifest = JSON.parse(await manifestFile.text()); }
  catch { throw new HTTPException(400, { message: "The FabuBlox manifest is not valid JSON" }); }
  if (!parsedManifest || typeof parsedManifest !== "object") throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  const manifest = parsedManifest as {
    schemaVersion: number;
    title: string;
    recipeFamilyId?: string | null;
    source: { fileName: string; fileSha256: string; sheetName: string };
    initialSubstrateStep: InitialSubstrateStep | null;
    steps: Array<{
      localId: string; sourceRow: number; position: number; stepNumber: string | null;
      sectionName: string | null; name: string; toolName: string | null;
      parametersText: string | null; commentsText: string | null;
      imageIds: string[]; rawCells: Record<string, unknown>;
    }>;
    images: Array<{
      localId: string; sourcePart: string; mimeType: string;
      assignedStepLocalId: string | null;
      anchor: Record<string, unknown>;
    }>;
    initialStateImageIds: string[];
    warnings: unknown[];
  };
  if (manifest.schemaVersion !== 2 || typeof manifest.title !== "string" || !manifest.title.trim() || manifest.title.length > 200 || typeof manifest.source?.sheetName !== "string" || !manifest.source.sheetName || !Array.isArray(manifest.steps) || !manifest.steps.length || !Array.isArray(manifest.images) || !Array.isArray(manifest.initialStateImageIds) || !Array.isArray(manifest.warnings)
    || (manifest.initialSubstrateStep !== null && (typeof manifest.initialSubstrateStep !== "object"
      || manifest.initialSubstrateStep.stepNumber !== "0"
      || typeof manifest.initialSubstrateStep.name !== "string"
      || normalizedSubstrateStepName(manifest.initialSubstrateStep.name) !== "substrate stack"
      || !Array.isArray(manifest.initialSubstrateStep.imageIds)))) {
    throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  }
  if (manifest.recipeFamilyId !== undefined && manifest.recipeFamilyId !== null && typeof manifest.recipeFamilyId !== "string") {
    throw new HTTPException(400, { message: "Invalid process-template family" });
  }
  if (manifest.steps.length > MAX_FABUBLOX_IMPORT_STEPS || manifest.images.length > MAX_FABUBLOX_IMPORT_IMAGES) {
    throw new HTTPException(413, { message: `This import exceeds the ${MAX_FABUBLOX_IMPORT_STEPS}-step or ${MAX_FABUBLOX_IMPORT_IMAGES}-image deployment limit` });
  }
  for (const image of manifest.images) {
    if (!(form.get(`image:${image.localId}`) instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
  }
  const imageIds = new Set(manifest.images.map((image) => image.localId));
  if (imageIds.size !== manifest.images.length || manifest.images.some((image) => typeof image.localId !== "string" || !image.localId)) {
    throw new HTTPException(400, { message: "Imported image identifiers must be unique" });
  }
  if (new Set(manifest.initialStateImageIds).size !== manifest.initialStateImageIds.length
    || manifest.initialStateImageIds.some((id) => typeof id !== "string" || !imageIds.has(id))) {
    throw new HTTPException(400, { message: "Invalid initial substrate image selection" });
  }
  if (manifest.initialSubstrateStep) {
    const declared = new Set(manifest.initialSubstrateStep.imageIds);
    if (manifest.initialStateImageIds.some((id) => !declared.has(id))
      || manifest.initialSubstrateStep.imageIds.some((id) => !manifest.initialStateImageIds.includes(id))
      || manifest.steps.some((step) => step.localId === manifest.initialSubstrateStep?.localId)) {
      throw new HTTPException(400, { message: "Step 0 must be represented only as the initial substrate" });
    }
  } else if (manifest.initialStateImageIds.length) {
    throw new HTTPException(400, { message: "Initial substrate images require Step 0: Substrate Stack" });
  }
  const processStepIds = new Set(manifest.steps.map((step) => step.localId));
  if (processStepIds.size !== manifest.steps.length
    || (manifest.initialSubstrateStep && processStepIds.has(manifest.initialSubstrateStep.localId))) {
    throw new HTTPException(400, { message: "Process and substrate step identifiers must be unique" });
  }
  const allowedStepIds = new Set([
    ...processStepIds,
    ...(manifest.initialSubstrateStep ? [manifest.initialSubstrateStep.localId] : []),
  ]);
  for (const image of manifest.images) {
    if (image.assignedStepLocalId !== null && !allowedStepIds.has(image.assignedStepLocalId)) {
      throw new HTTPException(400, { message: `Image ${image.localId} refers to an unknown process row` });
    }
  }
  const payloadBytes = workbook.size + manifestFile.size + manifest.images.reduce((sum, image) => {
    const file = form.get(`image:${image.localId}`);
    return sum + (file instanceof File ? file.size : 0);
  }, 0);
  if (payloadBytes > 50 * 1024 * 1024) throw new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
  const workbookBuffer = await workbook.arrayBuffer();
  const actualSha = await digestSha256(workbookBuffer);
  if (actualSha !== manifest.source.fileSha256) throw new HTTPException(400, { message: "Workbook checksum does not match the preview" });

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const manifestBuffer = manifestBytes.buffer.slice(manifestBytes.byteOffset, manifestBytes.byteOffset + manifestBytes.byteLength) as ArrayBuffer;
  const imageInputs: Array<{
    image: typeof manifest.images[number]; file: File; buffer: ArrayBuffer; sha256: string;
  }> = [];
  for (let index = 0; index < manifest.images.length; index += 5) {
    const prepared = await Promise.all(manifest.images.slice(index, index + 5).map(async (image) => {
      const value = form.get(`image:${image.localId}`);
      if (!(value instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
      const mimeType = value.type || image.mimeType;
      if (!mimeType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: `Imported asset ${image.localId} is not an image` });
      const buffer = await value.arrayBuffer();
      return { image, file: value, buffer, sha256: await digestSha256(buffer) };
    }));
    imageInputs.push(...prepared);
  }

  const existingFamily = manifest.recipeFamilyId
    ? await c.env.DB.prepare("SELECT id, name, template_type FROM recipe_families WHERE id = ? AND archived_at IS NULL")
      .bind(manifest.recipeFamilyId).first<{ id: string; name: string; template_type: string }>()
    : await c.env.DB.prepare("SELECT id, name, template_type FROM recipe_families WHERE name = ? AND template_type = 'process' AND archived_at IS NULL")
      .bind(manifest.title.trim()).first<{ id: string; name: string; template_type: string }>();
  if (manifest.recipeFamilyId && !existingFamily) throw new HTTPException(404, { message: "Process-template family not found" });
  const internalTemplateType = existingFamily?.template_type ?? "process";
  const recipeFamilyId = existingFamily?.id ?? crypto.randomUUID();
  const recipeName = existingFamily?.name ?? manifest.title.trim();
  const importId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  await c.env.DB.prepare(
    `INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type, recipe_family_id, warning_count, actor_email, created_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(importId, workbook.name, actualSha, manifest.source.sheetName, internalTemplateType, recipeFamilyId, manifest.warnings.length, userEmail, now).run();

  const uploadedKeys: string[] = [];
  try {
    const prefix = `imports/${importId}`;
    type Candidate = {
      kind: "workbook" | "manifest" | "image";
      localId: string;
      originalName: string;
      mimeType: string;
      buffer: ArrayBuffer;
      sha256: string;
      image?: typeof manifest.images[number];
    };
    const candidates: Candidate[] = [
      { kind: "workbook", localId: "workbook", originalName: workbook.name, mimeType: workbook.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: workbookBuffer, sha256: actualSha },
      { kind: "manifest", localId: "manifest", originalName: "manifest.json", mimeType: "application/json", buffer: manifestBuffer, sha256: await digestSha256(manifestBuffer) },
      ...imageInputs.map(({ image, file, buffer, sha256 }) => ({ kind: "image" as const, localId: image.localId, originalName: file.name, mimeType: file.type || image.mimeType, buffer, sha256, image })),
    ];
    const hashes = [...new Set(candidates.map((candidate) => candidate.sha256))];
    const placeholders = hashes.map(() => "?").join(", ");
    const existingRows = await c.env.DB.prepare(
      `SELECT id, r2_key, sha256 FROM assets WHERE status = 'ready' AND sha256 IN (${placeholders})`,
    ).bind(...hashes).all<{ id: string; r2_key: string; sha256: string }>();
    const existingByHash = new Map<string, { assetId: string; key: string }>(
      existingRows.results.map((asset) => [asset.sha256, { assetId: asset.id, key: asset.r2_key }]),
    );
    const resolved = resolveAssetReferences(candidates, existingByHash, (candidate) => {
      const suffix = candidate.kind === "workbook" ? `source/${safeObjectName(candidate.originalName)}`
        : candidate.kind === "manifest" ? "manifest.json"
          : `images/${candidate.localId}-${safeObjectName(candidate.originalName)}`;
      return { assetId: crypto.randomUUID(), key: `${prefix}/${suffix}` };
    });
    const newAssets = [...new Map(resolved.filter((asset) => asset.isNew).map((asset) => [asset.assetId, asset])).values()];
    for (let index = 0; index < newAssets.length; index += 5) {
      const uploadResults = await Promise.allSettled(newAssets.slice(index, index + 5).map(async (asset) => {
        await c.env.ASSETS.put(asset.key, asset.buffer, { httpMetadata: { contentType: asset.mimeType } });
        uploadedKeys.push(asset.key);
      }));
      const failedUpload = uploadResults.find((result) => result.status === "rejected");
      if (failedUpload?.status === "rejected") throw failedUpload.reason;
    }
    const workbookAsset = resolved.find((asset) => asset.kind === "workbook")!;
    const manifestAsset = resolved.find((asset) => asset.kind === "manifest")!;
    const imageAssets = resolved.filter((asset) => asset.kind === "image");
    const latest = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE recipe_family_id = ?",
    ).bind(recipeFamilyId).first<{ version: number }>();
    const version = (latest?.version ?? 0) + 1;
    const templateVersionId = crypto.randomUUID();
    const stepIds = new Map(manifest.steps.map((step) => [step.localId, crypto.randomUUID()]));

    const occurrences = new Map<string, number>();
    const definitions = new Map<string, Awaited<ReturnType<typeof hashStepDefinition>>>();
    const states = new Map<string, { hash: string; canonical: Record<string, unknown> }>();
    const stateAssetRows = new Map<string, [string, string, number]>();
    const initialStateAssets = imageAssets.filter((asset) => manifest.initialStateImageIds.includes(asset.localId));
    let initialStateHash: string | null = null;
    if (manifest.initialSubstrateStep) {
      const initialState = await hashInitialSubstrateRepresentation(
        manifest.initialSubstrateStep,
        initialStateAssets.map((asset) => asset.sha256),
      );
      states.set(initialState.hash, initialState);
      initialStateHash = initialState.hash;
      initialStateAssets.forEach((asset, index) =>
        stateAssetRows.set(`${initialState.hash}:${asset.assetId}`, [initialState.hash, asset.assetId, index]));
    }
    let inheritedStateHash: string | null = initialStateHash;
    const preparedSteps: Array<{
      source: typeof manifest.steps[number]; logicalKey: string; definitionHash: string; expectedStateHash: string | null;
    }> = [];
    for (const step of manifest.steps) {
      const occurrenceKey = normalizedStepName(step.name);
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      const logicalKey = logicalStepKey(step, occurrence);
      const definition = await hashStepDefinition(step);
      definitions.set(definition.hash, definition);
      const assignedAssets = imageAssets.filter((asset) => asset.image?.assignedStepLocalId === step.localId);
      if (assignedAssets.length) {
        const state = await hashStateRepresentation(assignedAssets.map((asset) => asset.sha256));
        states.set(state.hash, state);
        inheritedStateHash = state.hash;
        assignedAssets.forEach((asset, index) => stateAssetRows.set(`${state.hash}:${asset.assetId}`, [state.hash, asset.assetId, index]));
      }
      preparedSteps.push({ source: step, logicalKey, definitionHash: definition.hash, expectedStateHash: inheritedStateHash });
    }
    const manifestHash = await hashRecipeManifest(preparedSteps.map((step) => ({
      logicalStepKey: step.logicalKey, definitionHash: step.definitionHash, expectedStateHash: step.expectedStateHash,
    })));

    const existingDefinitionHashes = new Set<string>();
    const definitionHashes = [...definitions.keys()];
    for (let index = 0; index < definitionHashes.length; index += 90) {
      const chunk = definitionHashes.slice(index, index + 90);
      const rows = await c.env.DB.prepare(`SELECT hash FROM step_definitions WHERE hash IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk).all<{ hash: string }>();
      rows.results.forEach((row) => existingDefinitionHashes.add(row.hash));
    }
    const stateHashes = [...states.keys()];
    const existingStateHashes = new Set<string>();
    if (stateHashes.length) {
      const rows = await c.env.DB.prepare(`SELECT hash FROM state_representations WHERE hash IN (${stateHashes.map(() => "?").join(", ")})`)
        .bind(...stateHashes).all<{ hash: string }>();
      rows.results.forEach((row) => existingStateHashes.add(row.hash));
    }

    const statements: D1PreparedStatement[] = [
      ...(!existingFamily ? [c.env.DB.prepare(
        `INSERT INTO recipe_families (id, name, template_type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(recipeFamilyId, recipeName, internalTemplateType, userEmail, now)] : []),
      c.env.DB.prepare("UPDATE imports SET template_version_id = ? WHERE id = ? AND status = 'pending'")
        .bind(templateVersionId, importId),
      ...bulkInsertStatements(c.env.DB, "assets",
        ["id", "import_id", "r2_key", "original_name", "mime_type", "byte_size", "status", "actor_email", "created_at", "sha256"],
        newAssets.map((asset) => [asset.assetId, importId, asset.key, asset.originalName, asset.mimeType, asset.buffer.byteLength, "ready", userEmail, now, asset.sha256])),
      ...bulkInsertStatements(c.env.DB, "step_definitions",
        ["hash", "hash_scheme", "name", "tool_name", "parameters_text", "comments_text", "canonical_json", "created_at"],
        [...definitions.values()].filter((definition) => !existingDefinitionHashes.has(definition.hash)).map((definition) => [
          definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
          definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now,
        ])),
      ...bulkInsertStatements(c.env.DB, "state_representations",
        ["hash", "hash_scheme", "representation_type", "content_json", "created_at"],
        [...states.values()].filter((state) => !existingStateHashes.has(state.hash)).map((state) => [
          state.hash, String(state.canonical.schema), String(state.canonical.type), stableJson(state.canonical), now,
        ])),
      ...bulkInsertStatements(c.env.DB, "state_representation_assets",
        ["state_hash", "asset_id", "position"],
        [...stateAssetRows.values()].filter(([stateHash]) => !existingStateHashes.has(stateHash))),
      c.env.DB.prepare(
        `INSERT INTO template_versions
          (id, recipe_family_id, name, template_type, version, manifest_hash, initial_state_hash,
           source_filename, source_asset_key, content_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(templateVersionId, recipeFamilyId, recipeName, internalTemplateType, version, manifestHash, initialStateHash, workbook.name, workbookAsset.key, JSON.stringify({
        schemaVersion: manifest.schemaVersion,
        source: manifest.source,
        importedTitle: manifest.title,
        objectKind: "process_template",
        initialSubstrateStep: manifest.initialSubstrateStep,
        warningCount: manifest.warnings.length,
      }), userEmail, now),
      ...bulkInsertStatements(c.env.DB, "template_steps",
        ["id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json"],
        preparedSteps.map((step) => [stepIds.get(step.source.localId), templateVersionId, step.logicalKey, step.source.position,
          step.source.sourceRow, step.source.stepNumber, step.source.sectionName, step.definitionHash, step.expectedStateHash, JSON.stringify(step.source.rawCells)])),
      c.env.DB.prepare(
        `UPDATE imports SET status = 'ready', workbook_asset_key = ?, manifest_asset_key = ?, completed_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).bind(workbookAsset.key, manifestAsset.key, new Date().toISOString(), importId),
    ];
    for (let index = 0; index < statements.length; index += 45) await c.env.DB.batch(statements.slice(index, index + 45));
    return c.json({ id: importId, templateVersionId, version }, 201);
  } catch (error) {
    const cleanupFailures = await deleteR2KeysInBatches(c.env.ASSETS, uploadedKeys);
    if (cleanupFailures.length) console.error("Could not clean every failed import object", cleanupFailures);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE imports SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?")
        .bind(String(error), new Date().toISOString(), importId),
      c.env.DB.prepare("UPDATE assets SET status = 'failed', sha256 = NULL WHERE import_id = ?").bind(importId),
    ]);
    throw error;
  }
});

type ProcessTemplateDirectoryRow = {
  id: string;
  recipe_family_id: string;
  name: string;
  template_type: "process" | "module" | "recipe";
  version: number;
  source_filename: string | null;
  step_count: number;
  initial_state_hash: string | null;
  has_initial_substrate_step: number;
  initial_asset_count: number;
  locked_at: string | null;
  created_at: string;
  version_count?: number;
};

function processTemplateVersionSummary(row: ProcessTemplateDirectoryRow) {
  return {
    id: row.id,
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    templateType: row.template_type,
    version: Number(row.version),
    sourceFilename: row.source_filename,
    stepCount: Number(row.step_count),
    initialStateHash: row.initial_state_hash,
    hasInitialSubstrateStep: Boolean(row.has_initial_substrate_step),
    initialStateImageCount: Number(row.initial_asset_count),
    locked: Boolean(row.locked_at),
    createdAt: row.created_at,
  };
}

const visibleProcessTemplateSql = (alias: string) => `
  ${alias}.template_kind = 'process'
  AND ${alias}.archived_at IS NULL
  AND ${alias}.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM imports hidden_import
    WHERE hidden_import.template_version_id = ${alias}.id
      AND hidden_import.status != 'ready'
  )`;

function processTemplateFamilySearch(query: string, familyAlias: string) {
  const tokens = searchTokens(query);
  if (!tokens.length) return { sql: "1 = 1", bindings: [] as string[] };
  const haystack = `LOWER(
    COALESCE(candidate.name, '') || ' ' ||
    COALESCE(candidate.template_type, '') || ' process fabrication ' ||
    COALESCE(candidate.source_filename, '') || ' v' ||
    CAST(candidate.version AS TEXT) || ' version ' ||
    CAST(candidate.version AS TEXT) || ' ' ||
    CAST((SELECT COUNT(*) FROM template_steps search_steps WHERE search_steps.template_version_id = candidate.id) AS TEXT) ||
    ' steps ' || CASE WHEN candidate.locked_at IS NULL THEN 'editable' ELSE 'locked' END
  )`;
  return {
    sql: `EXISTS (
      SELECT 1
      FROM template_versions candidate
      WHERE candidate.recipe_family_id = ${familyAlias}.recipe_family_id
        AND ${visibleProcessTemplateSql("candidate")}
        AND ${repeatedLikeSql(haystack, tokens)}
    )`,
    bindings: likeBindings(tokens),
  };
}

function metrologyTemplateSearch(query: string) {
  const tokens = searchTokens(query);
  if (!tokens.length) return { sql: "1 = 1", bindings: [] as string[] };
  const haystack = `LOWER(
    COALESCE(tv.name, '') || ' metrology ' ||
    COALESCE(sd.tool_name, '') || ' ' ||
    COALESCE(sd.parameters_text, '') || ' ' ||
    COALESCE(sd.comments_text, '')
  )`;
  return { sql: repeatedLikeSql(haystack, tokens), bindings: likeBindings(tokens) };
}

const processTemplateDirectoryColumns = `
  tv.id, tv.recipe_family_id, tv.name, tv.template_type, tv.version,
  tv.source_filename, tv.initial_state_hash, tv.locked_at, tv.created_at,
  (SELECT COUNT(*) FROM template_steps ts WHERE ts.template_version_id = tv.id) AS step_count,
  CASE WHEN json_valid(tv.content_json)
    AND json_type(tv.content_json, '$.initialSubstrateStep') = 'object'
    THEN 1 ELSE 0 END AS has_initial_substrate_step,
  (SELECT COUNT(*)
   FROM state_representation_assets sra
   JOIN assets initial_asset ON initial_asset.id = sra.asset_id AND initial_asset.status = 'ready'
   WHERE sra.state_hash = tv.initial_state_hash) AS initial_asset_count`;

app.get("/template-families/options", async (c) => {
  const d1Started = performance.now();
  const result = await c.env.DB.prepare(
    `SELECT tv.recipe_family_id, tv.name, tv.version
     FROM template_versions tv
     WHERE ${visibleProcessTemplateSql("tv")}
       AND NOT EXISTS (
         SELECT 1 FROM template_versions newer
         WHERE newer.recipe_family_id = tv.recipe_family_id
           AND ${visibleProcessTemplateSql("newer")}
           AND newer.version > tv.version
       )
     ORDER BY tv.name, tv.template_type, tv.recipe_family_id`,
  ).all<{ recipe_family_id: string; name: string; version: number }>();
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { families: result.results.map((row) => ({
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    latestVersion: Number(row.version),
  })) };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.get("/template-families", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const { page, pageSize, offset } = readPagination(c.req.query("page"), c.req.query("pageSize"), 20);
  const search = processTemplateFamilySearch(query, "tv");
  const latestWhere = `
    ${visibleProcessTemplateSql("tv")}
    AND NOT EXISTS (
      SELECT 1 FROM template_versions newer
      WHERE newer.recipe_family_id = tv.recipe_family_id
        AND ${visibleProcessTemplateSql("newer")}
        AND newer.version > tv.version
    )
    AND ${search.sql}`;
  const d1Started = performance.now();
  const [result, countRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${processTemplateDirectoryColumns},
              (SELECT COUNT(*) FROM template_versions family_version
               WHERE family_version.recipe_family_id = tv.recipe_family_id
                 AND ${visibleProcessTemplateSql("family_version")}) AS version_count
       FROM template_versions tv
       WHERE ${latestWhere}
       ORDER BY tv.name, tv.template_type, tv.recipe_family_id
       LIMIT ? OFFSET ?`,
    ).bind(...search.bindings, pageSize, offset).all<ProcessTemplateDirectoryRow>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM template_versions tv
       WHERE ${latestWhere}`,
    ).bind(...search.bindings).first<{ total: number }>(),
  ]);
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = {
    families: result.results.map((row) => ({
      recipeFamilyId: row.recipe_family_id,
      name: row.name,
      templateType: row.template_type,
      latestVersion: Number(row.version),
      versionCount: Number(row.version_count ?? 1),
      latest: processTemplateVersionSummary(row),
    })),
    pagination: paginationMeta(Number(countRow?.total ?? 0), page, pageSize),
  };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.get("/template-families/:id/versions", async (c) => {
  const recipeFamilyId = c.req.param("id");
  const search = processTemplateFamilySearch(c.req.query("q")?.trim() ?? "", "tv");
  const d1Started = performance.now();
  const result = await c.env.DB.prepare(
    `SELECT ${processTemplateDirectoryColumns}
     FROM template_versions tv
     WHERE tv.recipe_family_id = ?
       AND ${visibleProcessTemplateSql("tv")}
       AND ${search.sql}
     ORDER BY tv.version DESC, tv.created_at DESC`,
  ).bind(recipeFamilyId, ...search.bindings).all<ProcessTemplateDirectoryRow>();
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { versions: result.results.map(processTemplateVersionSummary) };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.get("/metrology-templates", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const { page, pageSize, offset } = readPagination(c.req.query("page"), c.req.query("pageSize"), 25);
  const search = metrologyTemplateSearch(query);
  const fromSql = `
    FROM template_versions tv
    LEFT JOIN template_steps ts ON ts.template_version_id = tv.id AND ts.position = 0
    LEFT JOIN step_definitions sd ON sd.hash = ts.definition_hash
    WHERE tv.template_kind = 'metrology'
      AND tv.archived_at IS NULL
      AND tv.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM imports hidden_import
        WHERE hidden_import.template_version_id = tv.id
          AND hidden_import.status != 'ready'
      )
      AND ${search.sql}`;
  const d1Started = performance.now();
  const [result, countRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT tv.id, tv.name, tv.created_at, sd.tool_name,
              CASE WHEN NULLIF(TRIM(sd.parameters_text), '') IS NOT NULL
                     OR NULLIF(TRIM(sd.comments_text), '') IS NOT NULL
                   THEN 1 ELSE 0 END AS has_default_content
       ${fromSql}
       ORDER BY tv.name, tv.created_at DESC, tv.id
       LIMIT ? OFFSET ?`,
    ).bind(...search.bindings, pageSize, offset).all<{
      id: string;
      name: string;
      created_at: string;
      tool_name: string | null;
      has_default_content: number;
    }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total ${fromSql}`)
      .bind(...search.bindings).first<{ total: number }>(),
  ]);
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = {
    templates: result.results.map((row) => ({
      id: row.id,
      name: row.name,
      toolName: row.tool_name,
      hasDefaultContent: Boolean(row.has_default_content),
      createdAt: row.created_at,
    })),
    pagination: paginationMeta(Number(countRow?.total ?? 0), page, pageSize),
  };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.get("/templates", async (c) => {
  const pickerView = c.req.query("view") === "picker";
  const d1Started = performance.now();
  const [result, initialAssetRows] = await Promise.all([
    c.env.DB.prepare(
    `SELECT tv.id, tv.recipe_family_id, tv.name, tv.template_type, tv.template_kind,
            tv.version, tv.manifest_hash,
            tv.initial_state_hash, tv.source_filename, ${pickerView ? "NULL" : "tv.content_json"} AS content_json, tv.created_at,
            tv.locked_at, tv.archived_at,
            (SELECT COUNT(*) FROM template_steps ts WHERE ts.template_version_id = tv.id) AS step_count,
            (SELECT sd.tool_name FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
             WHERE ts.template_version_id = tv.id ORDER BY ts.position LIMIT 1) AS tool_name,
            (SELECT sd.parameters_text FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
             WHERE ts.template_version_id = tv.id ORDER BY ts.position LIMIT 1) AS parameters_text,
            (SELECT sd.comments_text FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
             WHERE ts.template_version_id = tv.id ORDER BY ts.position LIMIT 1) AS comments_text
     FROM template_versions tv
     WHERE tv.archived_at IS NULL AND tv.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')
     ORDER BY tv.name, tv.template_type, tv.version DESC`,
  ).all<{
    id: string;
    recipe_family_id: string;
    name: string;
    template_type: "process" | "module" | "recipe";
    template_kind: "process" | "metrology";
    version: number;
    manifest_hash: string;
    initial_state_hash: string | null;
    content_json: string | null;
    source_filename: string | null;
    created_at: string;
    locked_at: string | null;
    archived_at: string | null;
    step_count: number;
    tool_name: string | null;
    parameters_text: string | null;
    comments_text: string | null;
  }>(),
    pickerView ? Promise.resolve({ results: [] as Array<{ template_version_id: string; r2_key: string }> }) : c.env.DB.prepare(
      `SELECT tv.id AS template_version_id, a.r2_key
       FROM template_versions tv
       JOIN state_representation_assets sra ON sra.state_hash = tv.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE tv.archived_at IS NULL AND tv.deleted_at IS NULL
       ORDER BY tv.id, sra.position, a.id`,
    ).all<{ template_version_id: string; r2_key: string }>(),
  ]);
  const initialAssets = new Map<string, string[]>();
  for (const row of initialAssetRows.results) {
    initialAssets.set(row.template_version_id, [...(initialAssets.get(row.template_version_id) ?? []), row.r2_key]);
  }
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { templates: result.results.map((row) => ({
    id: row.id,
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    templateType: row.template_type,
    templateKind: row.template_kind,
    version: row.version,
    manifestHash: row.manifest_hash,
    sourceFilename: row.source_filename,
    stepCount: Number(row.step_count),
    toolName: row.tool_name,
    parametersText: row.parameters_text,
    commentsText: row.comments_text,
    initialStateHash: row.initial_state_hash,
    initialStateImageKeys: initialAssets.get(row.id) ?? [],
    initialSubstrateStep: pickerView ? null : parseInitialSubstrateStep(row.content_json),
    locked: Boolean(row.locked_at),
    lockedAt: row.locked_at,
    createdAt: row.created_at,
  })) };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.post("/metrology-templates", async (c) => {
  const input = await c.req.json<{
    name?: string; toolName?: string; parametersText?: string; commentsText?: string;
  }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string"
    || typeof input.parametersText !== "string" || typeof input.commentsText !== "string") {
    throw new HTTPException(400, { message: "Valid metrology-template fields are required" });
  }
  const name = input.name.trim();
  const toolName = input.toolName.trim();
  const parametersText = input.parametersText.trim();
  const commentsText = input.commentsText.trim();
  if (!name || name.length > 200 || toolName.length > 500
    || parametersText.length > 10_000 || commentsText.length > 10_000) {
    throw new HTTPException(400, { message: "One or more metrology-template fields are invalid" });
  }
  const definition = await hashStepDefinition({ name, toolName, parametersText, commentsText });
  const familyId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const logicalKey = `metrology:${stepId}`;
  const manifestHash = await hashRecipeManifest([
    { logicalStepKey: logicalKey, definitionHash: definition.hash, expectedStateHash: null },
  ]);
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO recipe_families (id, name, template_type, created_by, created_at)
         VALUES (?, ?, 'module', ?, ?)`,
      ).bind(familyId, `Metrology template · ${familyId}`, userEmail, now),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO step_definitions
         (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
        definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
      c.env.DB.prepare(
        `INSERT INTO template_versions
         (id, recipe_family_id, name, template_type, template_kind, version, manifest_hash,
          content_json, created_by, created_at)
         VALUES (?, ?, ?, 'module', 'metrology', 1, ?, '{}', ?, ?)`,
      ).bind(templateId, familyId, name, manifestHash, userEmail, now),
      c.env.DB.prepare(
        `INSERT INTO template_steps
         (id, template_version_id, logical_step_key, position, definition_hash, raw_json)
         VALUES (?, ?, ?, 0, ?, '{}')`,
      ).bind(stepId, templateId, logicalKey, definition.hash),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "A metrology template with this title already exists" });
    }
    throw error;
  }
  return c.json({ id: templateId, version: 1 }, 201);
});

app.patch("/metrology-templates/:id", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<{
    name?: string; toolName?: string; parametersText?: string; commentsText?: string;
  }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string"
    || typeof input.parametersText !== "string" || typeof input.commentsText !== "string") {
    throw new HTTPException(400, { message: "Valid metrology-template fields are required" });
  }
  const name = input.name.trim();
  const toolName = input.toolName.trim();
  const parametersText = input.parametersText.trim();
  const commentsText = input.commentsText.trim();
  if (!name || name.length > 200 || toolName.length > 500
    || parametersText.length > 10_000 || commentsText.length > 10_000) {
    throw new HTTPException(400, { message: "One or more metrology-template fields are invalid" });
  }
  const template = await c.env.DB.prepare(
    `SELECT ts.id AS template_step_id, ts.logical_step_key
     FROM template_versions tv
     JOIN template_steps ts ON ts.template_version_id = tv.id
     WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
       AND tv.deleted_at IS NULL
       AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
  ).bind(id).first<{ template_step_id: string; logical_step_key: string }>();
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const definition = await hashStepDefinition({ name, toolName, parametersText, commentsText });
  const manifestHash = await hashRecipeManifest([
    { logicalStepKey: template.logical_step_key, definitionHash: definition.hash, expectedStateHash: null },
  ]);
  const now = new Date().toISOString();
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO step_definitions
         (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
        definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
      c.env.DB.prepare(
        `UPDATE template_versions SET name = ?, manifest_hash = ?
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL`,
      ).bind(name, manifestHash, id),
      c.env.DB.prepare(
        `UPDATE template_steps SET definition_hash = ?, expected_state_hash = NULL
         WHERE id = ? AND template_version_id = ?`,
      ).bind(definition.hash, template.template_step_id, id),
    ]);
    if (results.slice(1).some((result) => !result.meta.changes)) {
      throw new HTTPException(409, { message: "This metrology template changed while it was being saved" });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "A metrology template with this title already exists" });
    }
    throw error;
  }
  return c.json({ ok: true });
});

app.patch("/metrology-templates/:id/notes", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<{ notes?: string }>();
  if (typeof input.notes !== "string" || input.notes.length > 20_000) {
    throw new HTTPException(400, { message: "Equipment or method notes must be at most 20,000 characters" });
  }
  const result = await c.env.DB.prepare(
    `UPDATE template_versions SET metrology_notes = ?
     WHERE id = ? AND template_kind = 'metrology'
       AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(input.notes.trim() || null, id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Metrology template not found" });
  return c.json({ ok: true });
});

app.post("/metrology-templates/:id/references", async (c) => {
  const templateId = c.req.param("id");
  if (!contentLengthWithin(c.req.raw, 25 * 1024 * 1024)) {
    throw new HTTPException(413, { message: "Template reference files are limited to 25 MB" });
  }
  const filename = (c.req.header("x-filename") || "reference").trim();
  const mimeType = (c.req.header("content-type") || "application/octet-stream").trim();
  if (!filename || filename.length > 255 || mimeType.length > 200) {
    throw new HTTPException(400, { message: "Reference-file metadata is invalid" });
  }
  const template = await c.env.DB.prepare(
    `SELECT id FROM template_versions
     WHERE id = ? AND template_kind = 'metrology'
       AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(templateId).first<{ id: string }>();
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const buffer = await c.req.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > 25 * 1024 * 1024) {
    throw new HTTPException(413, { message: "Template reference files must be between 1 byte and 25 MB" });
  }
  const sha256 = await digestSha256(buffer);
  const existingReference = await c.env.DB.prepare(
    `SELECT mtr.id, mtr.display_name, a.mime_type, a.byte_size, a.r2_key,
            mtr.created_at, mtr.deleted_at
     FROM metrology_template_references mtr
     JOIN assets a ON a.id = mtr.asset_id AND a.status = 'ready'
     WHERE mtr.template_version_id = ? AND a.sha256 = ?`,
  ).bind(templateId, sha256).first<{
    id: string; display_name: string; mime_type: string; byte_size: number;
    r2_key: string; created_at: string; deleted_at: string | null;
  }>();
  if (existingReference) {
    if (existingReference.deleted_at) {
      await c.env.DB.prepare(
        `UPDATE metrology_template_references
         SET deleted_at = NULL, deleted_by = NULL, display_name = ?
         WHERE id = ? AND deleted_at = ?`,
      ).bind(filename, existingReference.id, existingReference.deleted_at).run();
    }
    return c.json({ reference: {
      id: existingReference.id,
      filename: existingReference.deleted_at ? filename : existingReference.display_name,
      mimeType: existingReference.mime_type,
      byteSize: Number(existingReference.byte_size),
      assetKey: existingReference.r2_key,
      createdAt: existingReference.created_at,
    } });
  }

  const existingAsset = await c.env.DB.prepare(
    "SELECT id, r2_key, original_name, mime_type, byte_size FROM assets WHERE sha256 = ? AND status = 'ready' LIMIT 1",
  ).bind(sha256).first<{
    id: string; r2_key: string; original_name: string; mime_type: string; byte_size: number;
  }>();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  let asset = existingAsset;
  let uploadedKey: string | null = null;
  if (!asset) {
    const assetId = crypto.randomUUID();
    const key = `metrology/${templateId}/${crypto.randomUUID()}-${safeObjectName(filename)}`;
    await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType: mimeType } });
    uploadedKey = key;
    try {
      await c.env.DB.prepare(
        `INSERT INTO assets
         (id, r2_key, original_name, mime_type, byte_size, status, sha256, actor_email, created_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      ).bind(assetId, key, filename, mimeType, buffer.byteLength, sha256, userEmail, now).run();
      asset = { id: assetId, r2_key: key, original_name: filename, mime_type: mimeType, byte_size: buffer.byteLength };
    } catch (error) {
      await c.env.ASSETS.delete(key);
      if (!String(error).includes("UNIQUE")) throw error;
      asset = await c.env.DB.prepare(
        "SELECT id, r2_key, original_name, mime_type, byte_size FROM assets WHERE sha256 = ? AND status = 'ready' LIMIT 1",
      ).bind(sha256).first<{
        id: string; r2_key: string; original_name: string; mime_type: string; byte_size: number;
      }>();
      if (!asset) throw error;
      uploadedKey = null;
    }
  }
  const referenceId = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO metrology_template_references
       (id, template_version_id, asset_id, display_name, position, actor_email, created_at)
       VALUES (?, ?, ?, ?, COALESCE((
         SELECT MAX(position) + 1 FROM metrology_template_references WHERE template_version_id = ?
       ), 0), ?, ?)`,
    ).bind(referenceId, templateId, asset.id, filename, templateId, userEmail, now).run();
  } catch (error) {
    if (uploadedKey) {
      await c.env.ASSETS.delete(uploadedKey);
      await c.env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(asset.id).run();
    }
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "This reference file is already attached" });
    }
    throw error;
  }
  return c.json({ reference: {
    id: referenceId,
    filename,
    mimeType: asset.mime_type,
    byteSize: Number(asset.byte_size),
    assetKey: asset.r2_key,
    createdAt: now,
  } }, 201);
});

app.delete("/metrology-templates/:id/references/:referenceId", async (c) => {
  const { id, referenceId } = c.req.param();
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE metrology_template_references
     SET deleted_at = ?, deleted_by = ?
     WHERE id = ? AND template_version_id = ?
       AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM template_versions
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL
       )`,
  ).bind(now, c.get("userEmail"), referenceId, id, id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Template reference not found" });
  return c.json({ ok: true });
});

app.post("/metrology-templates/:id/references/:referenceId/restore", async (c) => {
  const { id, referenceId } = c.req.param();
  const result = await c.env.DB.prepare(
    `UPDATE metrology_template_references
     SET deleted_at = NULL, deleted_by = NULL
     WHERE id = ? AND template_version_id = ? AND deleted_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM template_versions
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL
       )`,
  ).bind(referenceId, id, id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Deleted template reference not found" });
  return c.json({ ok: true });
});

app.post("/templates/:id/clone", async (c) => {
  const sourceId = c.req.param("id");
  const [source, steps] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM template_versions WHERE id = ? AND deleted_at IS NULL",
    ).bind(sourceId).first<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT * FROM template_steps WHERE template_version_id = ? ORDER BY position").bind(sourceId).all<Record<string, unknown>>(),
  ]);
  if (!source) throw new HTTPException(404, { message: "Template version not found" });
  const latest = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE recipe_family_id = ?",
  ).bind(source.recipe_family_id).first<{ version: number }>();
  const id = crypto.randomUUID();
  const version = Number(latest?.version ?? 0) + 1;
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = new Map(steps.results.map((step) => [String(step.id), crypto.randomUUID()]));
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, template_kind, version, manifest_hash, initial_state_hash,
         source_filename, source_asset_key, content_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, source.recipe_family_id, source.name, source.template_type, source.template_kind, version, source.manifest_hash,
      source.initial_state_hash, source.source_filename, source.source_asset_key, source.content_json, userEmail, now),
    ...bulkInsertStatements(c.env.DB, "template_steps",
      ["id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json"],
      steps.results.map((step) => [stepIds.get(String(step.id)), id, step.logical_step_key, step.position,
        step.source_row, step.step_number, step.section_name, step.definition_hash, step.expected_state_hash, step.raw_json])),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This template is too large to clone on the current plan" });
  await c.env.DB.batch(statements);
  return c.json({ id, version }, 201);
});

app.get("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const [template, stepRows, assetRows, initialAssetRows, referenceRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, recipe_family_id, name, template_type, template_kind, metrology_notes,
              version, manifest_hash, initial_state_hash,
              source_filename, content_json, locked_at, archived_at, created_at
       FROM template_versions WHERE id = ? AND deleted_at IS NULL`,
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT ts.id, ts.logical_step_key, ts.definition_hash, ts.expected_state_hash,
              ts.position, ts.source_row, ts.step_number, ts.section_name,
              sd.name, sd.tool_name, sd.parameters_text, sd.comments_text
       FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
       WHERE ts.template_version_id = ? ORDER BY ts.position`,
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT ts.id AS template_step_id, a.r2_key
       FROM template_steps ts
       JOIN state_representation_assets sra ON sra.state_hash = ts.expected_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE ts.template_version_id = ? ORDER BY ts.id, sra.position, a.id`,
    ).bind(id).all<{ template_step_id: string; r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT a.r2_key
       FROM template_versions tv
       JOIN state_representation_assets sra ON sra.state_hash = tv.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE tv.id = ? ORDER BY sra.position, a.id`,
    ).bind(id).all<{ r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT mtr.id, mtr.display_name, a.mime_type, a.byte_size, a.r2_key, mtr.created_at
       FROM metrology_template_references mtr
       JOIN assets a ON a.id = mtr.asset_id AND a.status = 'ready'
       WHERE mtr.template_version_id = ? AND mtr.deleted_at IS NULL
       ORDER BY mtr.position, mtr.created_at, mtr.id`,
    ).bind(id).all<{
      id: string; display_name: string; mime_type: string; byte_size: number;
      r2_key: string; created_at: string;
    }>(),
  ]);
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  const images = new Map<string, string[]>();
  for (const row of assetRows.results) images.set(row.template_step_id, [...(images.get(row.template_step_id) ?? []), row.r2_key]);
  return c.json({ template: {
    id: String(template.id), recipeFamilyId: String(template.recipe_family_id), name: String(template.name),
    templateType: String(template.template_type), templateKind: String(template.template_kind),
    version: Number(template.version),
    manifestHash: String(template.manifest_hash),
    initialStateHash: template.initial_state_hash ? String(template.initial_state_hash) : null,
    initialStateImageKeys: initialAssetRows.results.map((row) => row.r2_key),
    initialSubstrateStep: parseInitialSubstrateStep(template.content_json ? String(template.content_json) : null),
    sourceFilename: template.source_filename ? String(template.source_filename) : null,
    metrologyNotes: template.metrology_notes ? String(template.metrology_notes) : null,
    referenceAttachments: referenceRows.results.map((reference) => ({
      id: reference.id,
      filename: reference.display_name,
      mimeType: reference.mime_type,
      byteSize: Number(reference.byte_size),
      assetKey: reference.r2_key,
      createdAt: reference.created_at,
    })),
    locked: Boolean(template.locked_at), lockedAt: template.locked_at ? String(template.locked_at) : null,
    archived: Boolean(template.archived_at), createdAt: String(template.created_at),
    steps: stepRows.results.map((step) => ({
      id: String(step.id), logicalStepKey: String(step.logical_step_key), definitionHash: String(step.definition_hash),
      expectedStateHash: step.expected_state_hash ? String(step.expected_state_hash) : null,
      position: Number(step.position), sourceRow: step.source_row === null ? null : Number(step.source_row),
      stepNumber: step.step_number ? String(step.step_number) : null, sectionName: step.section_name ? String(step.section_name) : null,
      name: String(step.name), toolName: step.tool_name ? String(step.tool_name) : null,
      parametersText: step.parameters_text ? String(step.parameters_text) : null,
      commentsText: step.comments_text ? String(step.comments_text) : null,
      imageKeys: images.get(String(step.id)) ?? [],
    })),
  } });
});

app.patch("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<{ name?: string; version?: number }>();
  if (typeof input.name !== "string" || typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) throw new HTTPException(400, { message: "A template name and positive integer version are required" });
  const name = input.name.trim();
  if (!name || name.length > 200) throw new HTTPException(400, { message: "Template name is required and must be at most 200 characters" });
  const current = await c.env.DB.prepare(
    "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
  ).bind(id).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>();
  if (!current) throw new HTTPException(404, { message: "Template version not found" });
  if (current.deleted_at) throw new HTTPException(404, { message: "Template version not found" });
  if (current.archived_at) throw new HTTPException(409, { message: "Archived templates cannot be edited" });
  if (current.locked_at) throw new HTTPException(409, { message: "This template version has been used by a process run and is now locked. Clone it to create an editable version." });
  try {
    const result = await c.env.DB.prepare(
      `UPDATE template_versions SET name = ?, version = ?
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
    ).bind(name, input.version, id).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: `Version ${input.version} already exists for this template` });
    throw error;
  }
  return c.json({ ok: true });
});

app.post("/templates/:id/steps", async (c) => {
  const templateId = c.req.param("id");
  const input = await c.req.json<{ name?: string; toolName?: string; parametersText?: string; commentsText?: string; assetKey?: string }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid template step fields are required" });
  const name = input.name.trim();
  if (!name || name.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000) throw new HTTPException(400, { message: "One or more template step fields are invalid" });
  const definition = await hashStepDefinition({ name, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [template, existingSteps, asset] = await Promise.all([
    c.env.DB.prepare(
      "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
    ).bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    c.env.DB.prepare("SELECT logical_step_key, definition_hash, expected_state_hash, position FROM template_steps WHERE template_version_id = ? ORDER BY position")
      .bind(templateId).all<{ logical_step_key: string; definition_hash: string; expected_state_hash: string | null; position: number }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id, sha256 FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; sha256: string }>() : Promise.resolve(null),
  ]);
  if (!template || template.deleted_at) throw new HTTPException(404, { message: "Template version not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const stepId = crypto.randomUUID();
  const now = new Date().toISOString();
  const state = asset ? await hashStateRepresentation([asset.sha256]) : null;
  const expectedStateHash = state?.hash ?? existingSteps.results.at(-1)?.expected_state_hash ?? null;
  const logicalKey = `manual:${stepId}`;
  const manifestHash = await hashRecipeManifest([
    ...existingSteps.results.map((step) => ({ logicalStepKey: step.logical_step_key, definitionHash: step.definition_hash, expectedStateHash: step.expected_state_hash })),
    { logicalStepKey: logicalKey, definitionHash: definition.hash, expectedStateHash },
  ]);
  const statements = [
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO step_definitions
       (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
      definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
  ];
  if (state) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO state_representations (hash, hash_scheme, representation_type, content_json, created_at)
     VALUES (?, ?, 'diagram', ?, ?)`,
  ).bind(state.hash, STATE_HASH_SCHEME, stableJson(state.canonical), now));
  if (state && asset) statements.push(c.env.DB.prepare(
    "INSERT OR IGNORE INTO state_representation_assets (state_hash, asset_id, position) VALUES (?, ?, 0)",
  ).bind(state.hash, asset.id));
  statements.push(c.env.DB.prepare(
    `INSERT INTO template_steps
     (id, template_version_id, logical_step_key, position, definition_hash, expected_state_hash)
     SELECT ?, id, ?, ?, ?, ? FROM template_versions
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(stepId, logicalKey, Number(existingSteps.results.at(-1)?.position ?? -1) + 1, definition.hash, expectedStateHash, templateId));
  statements.push(c.env.DB.prepare(
    `UPDATE template_versions SET manifest_hash = ?
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(manifestHash, templateId));
  const results = await c.env.DB.batch(statements);
  if (!results[results.length - 2].meta.changes || !results.at(-1)?.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  return c.json({ id: stepId }, 201);
});

app.patch("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  const input = await c.req.json<{ name?: string; toolName?: string; parametersText?: string; commentsText?: string; assetKey?: string }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid template step fields are required" });
  const name = input.name.trim();
  if (!name || name.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000) throw new HTTPException(400, { message: "One or more template step fields are invalid" });
  const definition = await hashStepDefinition({ name, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [template, step, allSteps, asset] = await Promise.all([
    c.env.DB.prepare(
      "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
    ).bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    c.env.DB.prepare("SELECT id, logical_step_key, expected_state_hash FROM template_steps WHERE id = ? AND template_version_id = ?")
      .bind(stepId, templateId).first<{ id: string; logical_step_key: string; expected_state_hash: string | null }>(),
    c.env.DB.prepare("SELECT id, logical_step_key, definition_hash, expected_state_hash FROM template_steps WHERE template_version_id = ? ORDER BY position")
      .bind(templateId).all<{ id: string; logical_step_key: string; definition_hash: string; expected_state_hash: string | null }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id, sha256 FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; sha256: string }>() : Promise.resolve(null),
  ]);
  if (!template || template.deleted_at || !step) throw new HTTPException(404, { message: "Template step not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const now = new Date().toISOString();
  const state = asset ? await hashStateRepresentation([asset.sha256]) : null;
  const expectedStateHash = state?.hash ?? step.expected_state_hash;
  const manifestHash = await hashRecipeManifest(allSteps.results.map((entry) => ({
    logicalStepKey: entry.logical_step_key,
    definitionHash: entry.id === stepId ? definition.hash : entry.definition_hash,
    expectedStateHash: entry.id === stepId ? expectedStateHash : entry.expected_state_hash,
  })));
  const statements = [c.env.DB.prepare(
    `INSERT OR IGNORE INTO step_definitions
     (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
    definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now)];
  if (state) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO state_representations (hash, hash_scheme, representation_type, content_json, created_at)
     VALUES (?, ?, 'diagram', ?, ?)`,
  ).bind(state.hash, STATE_HASH_SCHEME, stableJson(state.canonical), now));
  if (state && asset) statements.push(c.env.DB.prepare(
    "INSERT OR IGNORE INTO state_representation_assets (state_hash, asset_id, position) VALUES (?, ?, 0)",
  ).bind(state.hash, asset.id));
  statements.push(c.env.DB.prepare(
    `UPDATE template_steps SET definition_hash = ?, expected_state_hash = ?
     WHERE id = ? AND template_version_id = ? AND EXISTS (
       SELECT 1 FROM template_versions
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
     )`,
  ).bind(definition.hash, expectedStateHash, stepId, templateId, templateId));
  statements.push(c.env.DB.prepare(
    `UPDATE template_versions SET manifest_hash = ?
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(manifestHash, templateId));
  const results = await c.env.DB.batch(statements);
  if (!results[results.length - 2].meta.changes || !results.at(-1)?.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  return c.json({ ok: true });
});

app.delete("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  const [template, step, remainingSteps] = await Promise.all([
    c.env.DB.prepare("SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?")
      .bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    c.env.DB.prepare(
      "SELECT id FROM template_steps WHERE id = ? AND template_version_id = ?",
    ).bind(stepId, templateId).first<{ id: string }>(),
    c.env.DB.prepare(
      `SELECT logical_step_key, definition_hash, expected_state_hash
       FROM template_steps WHERE template_version_id = ? AND id != ? ORDER BY position`,
    ).bind(templateId, stepId).all<{
      logical_step_key: string;
      definition_hash: string;
      expected_state_hash: string | null;
    }>(),
  ]);
  if (!template || template.deleted_at || !step) throw new HTTPException(404, { message: "Template step not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  const manifestHash = await hashRecipeManifest(remainingSteps.results.map((entry) => ({
    logicalStepKey: entry.logical_step_key,
    definitionHash: entry.definition_hash,
    expectedStateHash: entry.expected_state_hash,
  })));
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM template_steps
       WHERE id = ? AND template_version_id = ?
         AND EXISTS (
           SELECT 1 FROM template_versions
           WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
         )`,
    ).bind(stepId, templateId, templateId),
    c.env.DB.prepare(
      `UPDATE template_versions SET manifest_hash = ?
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
    ).bind(manifestHash, templateId),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) {
    throw new HTTPException(409, { message: "This template version was used to start a process run while the step was being deleted. Clone it to continue." });
  }
  return c.json({ ok: true });
});

app.delete("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const template = await c.env.DB.prepare(
    `SELECT tv.recipe_family_id, tv.locked_at, tv.archived_at, tv.deleted_at,
            EXISTS (SELECT 1 FROM runs r WHERE r.template_version_id = tv.id) OR
            EXISTS (SELECT 1 FROM run_plan_revisions rpr WHERE rpr.template_version_id = tv.id) OR
            EXISTS (
              SELECT 1 FROM run_steps rs
              JOIN template_steps ts ON ts.id = rs.template_step_id
              WHERE ts.template_version_id = tv.id
            ) OR
            EXISTS (SELECT 1 FROM recipe_change_proposals rcp WHERE rcp.source_template_version_id = tv.id) AS referenced
     FROM template_versions tv WHERE tv.id = ?`,
  ).bind(id).first<{
    recipe_family_id: string; locked_at: string | null; archived_at: string | null;
    deleted_at: string | null; referenced: number;
  }>();
  if (!template || template.archived_at || template.deleted_at) {
    throw new HTTPException(404, { message: "Active template version not found" });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const archive = Boolean(template.locked_at || template.referenced);
  const result = await c.env.DB.prepare(
    `UPDATE template_versions
     SET deleted_at = ?, deleted_by = ?,
         archived_at = CASE WHEN ? THEN ? ELSE archived_at END,
         archived_by = CASE WHEN ? THEN ? ELSE archived_by END
     WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(now, userEmail, archive ? 1 : 0, now, archive ? 1 : 0, userEmail, id).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "This template changed while it was being deleted" });
  }
  return c.json({ ok: true, disposition: archive ? "archived" as const : "deleted" as const });
});

app.post("/templates/:id/restore", async (c) => {
  const id = c.req.param("id");
  const template = await c.env.DB.prepare(
    `SELECT deleted_at, deleted_by, archived_at, archived_by
     FROM template_versions WHERE id = ? AND deleted_at IS NOT NULL`,
  ).bind(id).first<{
    deleted_at: string; deleted_by: string | null;
    archived_at: string | null; archived_by: string | null;
  }>();
  if (!template) throw new HTTPException(404, { message: "Deleted template version not found" });
  const result = await c.env.DB.prepare(
    `UPDATE template_versions
     SET archived_at = CASE
           WHEN archived_at = deleted_at AND archived_by IS deleted_by THEN NULL
           ELSE archived_at
         END,
         archived_by = CASE
           WHEN archived_at = deleted_at AND archived_by IS deleted_by THEN NULL
           ELSE archived_by
         END,
         deleted_at = NULL,
         deleted_by = NULL
     WHERE id = ? AND deleted_at = ?`,
  ).bind(id, template.deleted_at).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "The template changed while it was being restored" });
  }
  return c.json({ ok: true });
});

export default {
  fetch: (request: Request, env: Env, executionContext: ExecutionContext) => app.fetch(request, env, executionContext),
  scheduled: (_event: ScheduledController, env: Env, executionContext: ExecutionContext) => {
    executionContext.waitUntil(cleanupCommentUploads(env));
  },
} satisfies ExportedHandler<Env>;

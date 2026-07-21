import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ConfirmRunStepsInput, CreateRecordInput, CreateRunStepCommentsInput, CreateRunStepInput, CreateSampleInput, CreateStateVerificationInput, RunStepTarget, SampleStatus, StepStatus, UpdateRunStepInput, UpdateSampleInput } from "../shared/types";
import { hashRecipeManifest, hashStateRepresentation, hashStepDefinition, logicalStepKey, sha256Hex, stableJson, STATE_HASH_SCHEME, STEP_HASH_SCHEME } from "../shared/content-addressing";
import { alignFuturePlan } from "../shared/plan-alignment";
import { isSampleRecordEvent } from "../shared/sample-records";
import { sampleDetail, sampleEvent, sampleSummary } from "./serializers";
import { collectExportAssetKeys } from "./export-data";
import { authenticateRequest } from "./auth";
import { bulkInsertStatements } from "./d1-bulk";
import { contentLengthWithin, escapedLikePattern, sameOriginOrNonBrowser } from "./request-guards";
import { insertionPosition } from "./run-position";
import { returnedEveryConfirmationTarget } from "./run-step-confirmation";
import { resolveAssetReferences } from "./asset-dedupe";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>().basePath("/api");

async function digestSha256(buffer: ArrayBuffer) {
  return sha256Hex(buffer);
}

function safeObjectName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
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

async function deleteR2KeysInBatches(bucket: R2Bucket, keys: string[]) {
  const failures: unknown[] = [];
  for (let index = 0; index < keys.length; index += 5) {
    const results = await Promise.allSettled(keys.slice(index, index + 5).map((key) => bucket.delete(key)));
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  }
  return failures;
}

type PlanContext = {
  run: {
    id: string; status: string; recipe_family_id: string; current_plan_revision_id: string;
    revision_no: number; current_template_version_id: string;
  };
  nextTemplate: { id: string; recipe_family_id: string; name: string; template_type: string; version: number };
  existing: Array<{
    id: string; logicalStepKey: string | null; definitionHash: string | null;
    position: number; actualized: boolean; origin: "template" | "ad_hoc";
  }>;
  next: Array<{
    id: string; logicalStepKey: string; definitionHash: string; expectedStateHash: string | null; position: number;
  }>;
};

async function loadPlanContext(db: D1Database, sampleId: string, runId: string, templateVersionId: string): Promise<PlanContext> {
  const [run, nextTemplate, existingRows, nextRows] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.status, r.recipe_family_id, r.current_plan_revision_id,
              rpr.revision_no, rpr.template_version_id AS current_template_version_id
       FROM runs r JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id
       WHERE r.id = ? AND r.sample_id = ?`,
    ).bind(runId, sampleId).first<PlanContext["run"]>(),
    db.prepare(
      `SELECT id, recipe_family_id, name, template_type, version FROM template_versions
       WHERE id = ? AND archived_at IS NULL`,
    ).bind(templateVersionId).first<PlanContext["nextTemplate"]>(),
    db.prepare(
      `SELECT id, logical_step_key, definition_hash, position,
              CASE WHEN actualized_at IS NOT NULL THEN 1 ELSE 0 END AS actualized, origin
       FROM run_steps WHERE run_id = ? AND (plan_status = 'current' OR origin = 'ad_hoc')
       ORDER BY position`,
    ).bind(runId).all<{
      id: string; logical_step_key: string | null; definition_hash: string | null;
      position: number; actualized: number; origin: "template" | "ad_hoc";
    }>(),
    db.prepare(
      `SELECT id, logical_step_key, definition_hash, expected_state_hash, position
       FROM template_steps WHERE template_version_id = ? ORDER BY position`,
    ).bind(templateVersionId).all<{
      id: string; logical_step_key: string; definition_hash: string;
      expected_state_hash: string | null; position: number;
    }>(),
  ]);
  if (!run) throw new HTTPException(404, { message: "Sample run not found" });
  if (!nextTemplate) throw new HTTPException(404, { message: "Recipe version not found" });
  return {
    run,
    nextTemplate,
    existing: existingRows.results.map((row) => ({
      id: row.id, logicalStepKey: row.logical_step_key, definitionHash: row.definition_hash,
      position: Number(row.position), actualized: Boolean(row.actualized), origin: row.origin,
    })),
    next: nextRows.results.map((row) => ({
      id: row.id, logicalStepKey: row.logical_step_key, definitionHash: row.definition_hash,
      expectedStateHash: row.expected_state_hash, position: Number(row.position),
    })),
  };
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
  await Promise.all([
    c.env.DB.prepare("SELECT 1 AS ok").first(),
    c.env.ASSETS.list({ limit: 1 }),
  ]);
  return c.json({ ok: true });
});

const sampleOverviewSelect = `
  SELECT s.*,
         COALESCE(ptv.name, r.template_name_snapshot) AS current_recipe_name,
         COALESCE(ptv.version, r.template_version_snapshot) AS current_recipe_version,
         r.status AS current_recipe_status,
         (
           SELECT COALESCE(rs.title, sd.name)
           FROM run_steps rs
           LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
           WHERE rs.run_id = r.id AND rs.plan_status = 'current'
             AND rs.status NOT IN ('done', 'skipped')
           ORDER BY rs.position
           LIMIT 1
         ) AS current_step_title,
         (
           SELECT COALESCE(rs.title, sd.name)
           FROM run_steps rs
           LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
           WHERE rs.run_id = r.id AND rs.status = 'done'
             AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
           ORDER BY rs.position DESC
           LIMIT 1
         ) AS current_state_step_title,
         (
           SELECT a.r2_key
           FROM run_steps rs
           JOIN state_representation_assets sra ON sra.state_hash = rs.expected_state_hash
           JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
           WHERE rs.run_id = r.id AND rs.status = 'done'
             AND (rs.plan_status = 'current' OR rs.actualized_at IS NOT NULL)
           ORDER BY rs.position DESC, sra.position
           LIMIT 1
         ) AS current_state_thumbnail_key
  FROM samples s
  LEFT JOIN runs r ON r.sample_id = s.id
    AND r.sequence_no = (SELECT MAX(latest.sequence_no) FROM runs latest WHERE latest.sample_id = s.id)
  LEFT JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id
  LEFT JOIN template_versions ptv ON ptv.id = rpr.template_version_id`;

app.get("/samples", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const pattern = escapedLikePattern(query);
  const statement = query
    ? c.env.DB.prepare(
        `WITH sample_overview AS (${sampleOverviewSelect})
         SELECT * FROM sample_overview
         WHERE code LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\'
           OR current_recipe_name LIKE ? ESCAPE '\\'
         ORDER BY pinned DESC, updated_at DESC LIMIT 50`,
      ).bind(pattern, pattern, pattern, pattern)
    : c.env.DB.prepare(`${sampleOverviewSelect} ORDER BY s.pinned DESC, s.updated_at DESC LIMIT 30`);
  const result = await statement.all();
  return c.json({ samples: result.results.map((row) => sampleSummary(row as never)) });
});

app.post("/samples", async (c) => {
  const input = await c.req.json<CreateSampleInput>();
  if (typeof input.code !== "string" || typeof input.title !== "string" || (input.description !== undefined && typeof input.description !== "string") || (input.location !== undefined && typeof input.location !== "string") || (input.parentId !== undefined && typeof input.parentId !== "string")) {
    throw new HTTPException(400, { message: "Invalid sample fields" });
  }
  const code = input.code.trim();
  const title = input.title.trim();
  if (!code || !title) throw new HTTPException(400, { message: "Code and title are required" });
  if (code.length > 100 || title.length > 200 || (input.description?.length ?? 0) > 10_000 || (input.location?.length ?? 0) > 500) {
    throw new HTTPException(400, { message: "One or more sample fields are too long" });
  }

  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO samples (id, code, title, description, location, parent_id, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, code, title, input.description?.trim() || null, input.location?.trim() || null, input.parentId || null, userEmail, userEmail, now, now),
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

app.get("/samples/:id", async (c) => {
  const id = c.req.param("id");
  const [sample, children, events, runRows, runAssetRows, runCommentRows, verificationRows, verificationStepRows] = await Promise.all([
    c.env.DB.prepare(
      `WITH sample_overview AS (${sampleOverviewSelect})
       SELECT s.*, p.id AS p_id, p.code AS p_code, p.title AS p_title
       FROM sample_overview s LEFT JOIN samples p ON p.id = s.parent_id WHERE s.id = ?`,
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT id, code, title FROM samples WHERE parent_id = ? ORDER BY created_at").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM events WHERE sample_id = ? ORDER BY created_at DESC").bind(id).all(),
    c.env.DB.prepare(
      `SELECT r.id AS run_id, r.recipe_family_id, r.template_version_id, r.status AS run_status,
              r.created_at AS run_created_at, r.completed_at,
              r.current_plan_revision_id, COALESCE(rpr.revision_no, 1) AS plan_revision_no,
              r.predecessor_run_id, r.anchor_step_id, r.sequence_no, r.run_group_id,
              COALESCE(ptv.name, r.template_name_snapshot) AS template_name,
              COALESCE(ptv.template_type, r.template_type_snapshot) AS template_type,
              COALESCE(ptv.version, r.template_version_snapshot) AS template_version,
              COALESCE(ptv.id, r.template_version_id) AS current_template_version_id,
              rs.id AS step_id, rs.template_step_id, rs.logical_step_key, rs.definition_hash,
              rs.expected_state_hash, rs.position, COALESCE(rs.title, sd.name) AS step_title,
              rs.status AS step_status, rs.notes, rs.updated_at AS step_updated_at,
              rs.origin, rs.plan_status,
              COALESCE(rs.tool_name, sd.tool_name) AS tool_name,
              COALESCE(rs.parameters_text, sd.parameters_text) AS parameters_text,
              COALESCE(rs.comments_text, sd.comments_text) AS comments_text,
              rs.deviation_note, rs.actualized_at,
              sd.name AS planned_title, sd.tool_name AS planned_tool_name,
              sd.parameters_text AS planned_parameters_text, sd.comments_text AS planned_comments_text,
              rs.created_at AS step_created_at
       FROM runs r
       LEFT JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id
       LEFT JOIN template_versions ptv ON ptv.id = rpr.template_version_id
       LEFT JOIN run_steps rs ON rs.run_id = r.id
       LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
       WHERE r.sample_id = ?
       ORDER BY r.sequence_no DESC, rs.position ASC`,
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT run_step_id, role, r2_key FROM (
         SELECT rs.id AS run_step_id, 'planned' AS role, a.r2_key, sra.position, a.created_at
         FROM run_steps rs
         JOIN runs r ON r.id = rs.run_id
         JOIN state_representation_assets sra ON sra.state_hash = rs.expected_state_hash
         JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
         WHERE r.sample_id = ?
         UNION ALL
         SELECT rsa.run_step_id, 'execution' AS role, a.r2_key, rsa.position, rsa.created_at
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         WHERE r.sample_id = ? AND rsa.role = 'execution'
       ) ORDER BY run_step_id, role, position, created_at`,
    ).bind(id, id).all<{ run_step_id: string; role: "planned" | "execution"; r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, rsc.scope, rsc.operation_group_id,
              rsc.body, ca.r2_key AS asset_key, rsc.actor_email, rsc.created_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       LEFT JOIN assets ca ON ca.id = rsc.asset_id AND ca.status = 'ready'
       WHERE r.sample_id = ?
       ORDER BY rsc.created_at, rsc.id`,
    ).bind(id).all<{
      id: string; run_step_id: string; scope: "common" | "individual";
      operation_group_id: string | null; body: string; asset_key: string | null;
      actor_email: string | null; created_at: string;
    }>(),
    c.env.DB.prepare(
      `SELECT sv.* FROM state_verifications sv
       WHERE sv.sample_id = ? ORDER BY sv.created_at, sv.id`,
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT svs.verification_id, svs.run_step_id, svs.ordinal
       FROM state_verification_steps svs
       JOIN state_verifications sv ON sv.id = svs.verification_id
       WHERE sv.sample_id = ? ORDER BY sv.created_at, svs.ordinal`,
    ).bind(id).all<{ verification_id: string; run_step_id: string; ordinal: number }>(),
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
  const stepComments = new Map<string, Array<{
    id: string; scope: "common" | "individual"; operationGroupId: string | null;
    body: string; assetKey: string | null; actorEmail: string | null; createdAt: string;
  }>>();
  for (const row of runAssetRows.results) {
    const entry = stepAssets.get(row.run_step_id) ?? { planned: [], execution: [] };
    entry[row.role].push(row.r2_key);
    stepAssets.set(row.run_step_id, entry);
  }
  for (const row of runCommentRows.results) {
    const entry = stepComments.get(row.run_step_id) ?? [];
    entry.push({
      id: row.id,
      scope: row.scope,
      operationGroupId: row.operation_group_id,
      body: row.body,
      assetKey: row.asset_key,
      actorEmail: row.actor_email,
      createdAt: row.created_at,
    });
    stepComments.set(row.run_step_id, entry);
  }
  for (const row of runRows.results) {
    const runId = String(row.run_id);
    if (!runs.has(runId)) runs.set(runId, {
      id: runId, recipeFamilyId: String(row.recipe_family_id),
      templateVersionId: String(row.current_template_version_id),
      templateName: String(row.template_name),
      templateType: String(row.template_type),
      templateVersion: Number(row.template_version),
      status: String(row.run_status), currentPlanRevisionId: String(row.current_plan_revision_id),
      planRevisionNumber: Number(row.plan_revision_no),
      predecessorRunId: row.predecessor_run_id ? String(row.predecessor_run_id) : null,
      anchorStepId: row.anchor_step_id ? String(row.anchor_step_id) : null,
      sequenceNo: Number(row.sequence_no), runGroupId: String(row.run_group_id),
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
      definitionHash: row.definition_hash ? String(row.definition_hash) : null,
      expectedStateHash: row.expected_state_hash ? String(row.expected_state_hash) : null,
      position: Number(row.position), origin: String(row.origin), planStatus: String(row.plan_status), title: String(row.step_title),
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
  return c.json({
    ...sampleDetail(sample as never),
    parent,
    children: children.results,
    events: events.results.map((row) => sampleEvent(row as never)),
    runs: [...runs.values()],
    stateVerifications,
  });
});

app.patch("/samples/:id", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<UpdateSampleInput>();
  const allowedStatuses: SampleStatus[] = ["active", "stored", "consumed", "lost"];
  if (typeof input.expectedUpdatedAt !== "string" || (input.location !== undefined && typeof input.location !== "string") || (input.pinned !== undefined && typeof input.pinned !== "boolean")) throw new HTTPException(400, { message: "Invalid sample update" });
  if (input.location && input.location.length > 500) throw new HTTPException(400, { message: "Location is too long" });
  if (input.status !== undefined && !allowedStatuses.includes(input.status)) {
    throw new HTTPException(400, { message: "Invalid sample status" });
  }
  const current = await c.env.DB.prepare(
    "SELECT status, location, pinned, updated_at FROM samples WHERE id = ?",
  ).bind(id).first<{ status: SampleStatus; location: string | null; pinned: number; updated_at: string }>();
  if (!current) throw new HTTPException(404, { message: "Sample not found" });
  if (current.updated_at !== input.expectedUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
  }

  const nextStatus = input.status ?? current.status;
  const nextLocation = input.location === undefined ? current.location : input.location.trim() || null;
  const nextPinned = input.pinned === undefined ? Boolean(current.pinned) : input.pinned;
  const changed = nextLocation !== current.location || nextStatus !== current.status || nextPinned !== Boolean(current.pinned);
  if (!changed) return c.json({ ok: true, updatedAt: current.updated_at });

  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE samples SET status = ?, location = ?, pinned = ?, updated_by = ?, updated_at = ?
     WHERE id = ? AND updated_at = ?`,
  ).bind(nextStatus, nextLocation, nextPinned ? 1 : 0, c.get("userEmail"), now, id, input.expectedUpdatedAt).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
  }
  return c.json({ ok: true, updatedAt: now });
});

app.post("/samples/:id/records", async (c) => {
  const sampleId = c.req.param("id");
  const input = await c.req.json<CreateRecordInput>();
  const allowedStatuses: SampleStatus[] = ["active", "stored", "consumed", "lost"];
  if (typeof input.expectedUpdatedAt !== "string" || typeof input.location !== "string" || typeof input.pinned !== "boolean" || !allowedStatuses.includes(input.status) || (input.body !== undefined && typeof input.body !== "string") || (input.assetKey !== undefined && typeof input.assetKey !== "string") || (input.thumbnailKey !== undefined && typeof input.thumbnailKey !== "string")) {
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
    "SELECT status, location, pinned, updated_at FROM samples WHERE id = ?",
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
     WHERE id = ? AND updated_at = ?`,
  ).bind(input.status, location, input.pinned ? 1 : 0, userEmail, mutationId, now, sampleId, input.expectedUpdatedAt)];
  if (body || assetKey) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ? FROM samples WHERE id = ? AND last_mutation_id = ?`,
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
    "SELECT id, kind, metadata_json FROM events WHERE id = ? AND sample_id = ?",
  ).bind(eventId, sampleId).first<{ id: string; kind: string; metadata_json: string }>();
  if (!event) throw new HTTPException(404, { message: "Sample record not found" });
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(event.metadata_json || "{}") as Record<string, unknown>; }
  catch { throw new HTTPException(409, { message: "This record cannot be safely deleted" }); }
  if (!isSampleRecordEvent(event.kind, metadata)) throw new HTTPException(400, { message: "Execution history cannot be deleted as a sample comment" });

  const sample = await c.env.DB.prepare(
    "SELECT updated_at FROM samples WHERE id = ?",
  ).bind(sampleId).first<{ updated_at: string }>();
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM events WHERE id = ? AND sample_id = ?",
    ).bind(eventId, sampleId),
    c.env.DB.prepare(
      "UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?",
    ).bind(userEmail, now, sampleId),
  ]);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "The sample record was already deleted" });
  return c.json({ ok: true, updatedAt: now });
});

app.post("/samples/:id/runs", async (c) => {
  const sampleId = c.req.param("id");
  const { templateVersionId } = await c.req.json<{ templateVersionId?: string }>();
  if (!templateVersionId) throw new HTTPException(400, { message: "Template version is required" });
  const [sample, template, templateStepRows, latestRun] = await Promise.all([
    c.env.DB.prepare("SELECT code FROM samples WHERE id = ?").bind(sampleId).first<{ code: string }>(),
    c.env.DB.prepare(
      `SELECT tv.name, tv.template_type, tv.version, tv.recipe_family_id
       FROM template_versions tv WHERE tv.id = ? AND tv.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first<{ name: string; template_type: "process" | "module" | "recipe"; version: number; recipe_family_id: string }>(),
    c.env.DB.prepare(
      `SELECT id, position, logical_step_key, definition_hash, expected_state_hash
       FROM template_steps WHERE template_version_id = ? ORDER BY position`,
    ).bind(templateVersionId).all<{ id: string; position: number; logical_step_key: string; definition_hash: string; expected_state_hash: string | null }>(),
    c.env.DB.prepare(
      `SELECT id, status, sequence_no FROM runs WHERE sample_id = ? ORDER BY sequence_no DESC LIMIT 1`,
    ).bind(sampleId).first<{ id: string; status: "active" | "complete" | "cancelled" | "superseded"; sequence_no: number }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  if (latestRun?.status === "active") throw new HTTPException(409, { message: "This sample already has an active run. Update its plan or finish it before starting a successor run." });
  const steps = templateStepRows.results;
  if (!steps.length) throw new HTTPException(422, { message: "This template has no mapped steps. Re-import it with a step column." });

  const runId = crypto.randomUUID();
  const planRevisionId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = new Map(steps.map((step) => [step.id, crypto.randomUUID()]));
  const anchor = latestRun ? await c.env.DB.prepare(
    `SELECT id FROM run_steps WHERE run_id = ? AND actualized_at IS NOT NULL
     ORDER BY position DESC LIMIT 1`,
  ).bind(latestRun.id).first<{ id: string }>() : null;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, current_plan_revision_id,
         predecessor_run_id, anchor_step_id, sequence_no, run_group_id,
         template_name_snapshot, template_type_snapshot, template_version_snapshot, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(runId, sampleId, template.recipe_family_id, templateVersionId, planRevisionId,
      latestRun?.id ?? null, anchor?.id ?? null, Number(latestRun?.sequence_no ?? 0) + 1, crypto.randomUUID(),
      template.name, template.template_type, template.version, userEmail, now),
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
    ).bind(eventId, sampleId, `${latestRun ? "Started successor run" : "Assigned"} ${template.name} v${template.version} (${steps.length} planned steps)`, JSON.stringify({ runId, templateVersionId, templateVersion: template.version, predecessorRunId: latestRun?.id ?? null, anchorStepId: anchor?.id ?? null }), userEmail, now),
    c.env.DB.prepare("UPDATE samples SET process_revision = process_revision + 1, updated_by = ?, updated_at = ? WHERE id = ?").bind(userEmail, now, sampleId),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This template is too large to assign on the current plan" });
  try { await c.env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("template version archived")) throw new HTTPException(409, { message: "This template was archived before assignment completed" });
    throw error;
  }
  return c.json({ id: runId }, 201);
});

app.post("/samples/:sampleId/runs/:runId/plan-update/preview", async (c) => {
  const { sampleId, runId } = c.req.param();
  const { templateVersionId } = await c.req.json<{ templateVersionId?: string }>();
  if (!templateVersionId) throw new HTTPException(400, { message: "A recipe version is required" });
  const context = await loadPlanContext(c.env.DB, sampleId, runId, templateVersionId);
  const sameFamily = context.run.recipe_family_id === context.nextTemplate.recipe_family_id;
  const alignment = sameFamily ? alignFuturePlan(context.existing, context.next) : {
    matches: [], additions: [], supersededStepIds: [], conflicts: [],
  };
  return c.json({
    compatible: sameFamily && alignment.conflicts.length === 0,
    currentTemplateVersionId: context.run.current_template_version_id,
    nextTemplateVersionId: templateVersionId,
    preservedCount: alignment.matches.length,
    additionCount: alignment.additions.length,
    supersededCount: alignment.supersededStepIds.length,
    conflicts: alignment.conflicts,
    familyMismatch: !sameFamily,
  });
});

app.post("/samples/:sampleId/runs/:runId/plan-update", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<{ templateVersionId?: string; reason?: string }>();
  if (!input.templateVersionId || (input.reason !== undefined && typeof input.reason !== "string")) {
    throw new HTTPException(400, { message: "A recipe version and optional reason are required" });
  }
  const context = await loadPlanContext(c.env.DB, sampleId, runId, input.templateVersionId);
  if (context.run.status !== "active") throw new HTTPException(409, { message: "Only an active run can receive a plan update" });
  if (context.run.recipe_family_id !== context.nextTemplate.recipe_family_id) {
    throw new HTTPException(409, { message: "A plan update must use another version of the same recipe. Finish this run before assigning a different recipe." });
  }
  const alignment = alignFuturePlan(context.existing, context.next);
  if (alignment.conflicts.length) {
    throw new HTTPException(409, { message: "This version changes already-executed history or inserts work before it. Start a successor run or revise the recipe alignment." });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const revisionId = crypto.randomUUID();
  const matchByTemplate = new Map(alignment.matches.map((match) => [match.templateStepId, match]));
  const existingById = new Map(context.existing.map((step) => [step.id, step]));
  const addedIds = new Map(alignment.additions.map((step) => [step.id, crypto.randomUUID()]));
  const executionHead = [...context.existing].filter((step) => step.actualized).sort((left, right) => right.position - left.position)[0] ?? null;
  let previousStepId = executionHead?.id ?? null;
  let futureIndex = 0;
  const futureMatches: Array<{
    id: string; position: number; previousStepId: string | null; templateStepId: string;
    logicalStepKey: string; definitionHash: string; expectedStateHash: string | null;
  }> = [];
  const newSteps: unknown[][] = [];
  for (const step of context.next) {
    const match = matchByTemplate.get(step.id);
    if (match && existingById.get(match.existingStepId)?.actualized) {
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
      newSteps.push([id, runId, previousStepId, position, "template", "current", step.id,
        step.logicalStepKey, step.definitionHash, step.expectedStateHash, now, userEmail, now]);
      previousStepId = id;
    }
  }

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO run_plan_revisions
       (id, run_id, revision_no, template_version_id, effective_after_step_id, reason, actor_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(revisionId, runId, Number(context.run.revision_no) + 1, input.templateVersionId,
      executionHead?.id ?? null, input.reason?.trim() || "Imported recipe version update", userEmail, now),
    c.env.DB.prepare(
      `UPDATE run_steps SET position = -1000000000 - (? * 1000000) - position
       WHERE run_id = ? AND origin = 'template' AND actualized_at IS NULL AND plan_status = 'current'`,
    ).bind(Number(context.run.revision_no) + 1, runId),
  ];
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
       WHERE id IN (SELECT id FROM changes)`,
    ).bind(...bindings, userEmail, now));
  }
  statements.push(...bulkInsertStatements(c.env.DB, "run_steps",
    ["id", "run_id", "previous_step_id", "position", "origin", "plan_status", "template_step_id", "logical_step_key", "definition_hash", "expected_state_hash", "created_at", "updated_by", "updated_at"],
    newSteps));
  if (alignment.supersededStepIds.length) {
    for (let index = 0; index < alignment.supersededStepIds.length; index += 80) {
      const ids = alignment.supersededStepIds.slice(index, index + 80);
      statements.push(c.env.DB.prepare(
        `UPDATE run_steps SET plan_status = 'superseded', updated_by = ?, updated_at = ?
         WHERE run_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
      ).bind(userEmail, now, runId, ...ids));
    }
  }
  const linkRows = context.next.map((step) => {
    const match = matchByTemplate.get(step.id);
    return [revisionId, step.id, match?.existingStepId ?? addedIds.get(step.id), match?.relation ?? "planned", now];
  });
  statements.push(
    ...bulkInsertStatements(c.env.DB, "run_step_plan_links",
      ["run_plan_revision_id", "template_step_id", "run_step_id", "relation", "created_at"], linkRows),
    c.env.DB.prepare(
      `UPDATE runs SET current_plan_revision_id = ?, template_version_id = ?,
              template_name_snapshot = ?, template_type_snapshot = ?, template_version_snapshot = ?,
              status = 'active', completed_at = NULL
       WHERE id = ? AND sample_id = ? AND status = 'active'`,
    ).bind(revisionId, input.templateVersionId, context.nextTemplate.name, context.nextTemplate.template_type,
      context.nextTemplate.version, runId, sampleId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       VALUES (?, ?, 'plan', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), sampleId,
      `Updated active plan to ${context.nextTemplate.name} v${context.nextTemplate.version}`,
      JSON.stringify({ runId, planRevisionId: revisionId, fromTemplateVersionId: context.run.current_template_version_id,
        toTemplateVersionId: input.templateVersionId, preserved: alignment.matches.length,
        added: alignment.additions.length, superseded: alignment.supersededStepIds.length }), userEmail, now),
    c.env.DB.prepare("UPDATE samples SET process_revision = process_revision + 1, updated_by = ?, updated_at = ? WHERE id = ?")
      .bind(userEmail, now, sampleId),
  );
  if (statements.length > 49) throw new HTTPException(413, { message: "This plan update is too large for one atomic operation" });
  await c.env.DB.batch(statements);
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
  const step = await c.env.DB.prepare(
    `SELECT COALESCE(rs.title, sd.name) AS title, rs.status, rs.notes,
            COALESCE(rs.tool_name, sd.tool_name) AS tool_name,
            COALESCE(rs.parameters_text, sd.parameters_text) AS parameters_text,
            COALESCE(rs.comments_text, sd.comments_text) AS comments_text,
            sd.name AS planned_title, sd.tool_name AS planned_tool_name,
            sd.parameters_text AS planned_parameters_text, sd.comments_text AS planned_comments_text,
            rs.deviation_note, rs.origin, rs.updated_at
     FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?`,
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
       WHERE id = ? AND updated_at = ?`,
    ).bind(input.status, titleOverride, toolOverride, parametersOverride, commentsOverride, deviationNote, notes, now, userEmail, mutationId, now, stepId, input.expectedUpdatedAt),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, r.sample_id, 'step', ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?`,
    ).bind(crypto.randomUUID(), `${title}: ${input.status.replace("_", " ")}${deviationNote ? ` — deviation: ${deviationNote}` : notes ? ` — ${notes}` : ""}`, JSON.stringify({
      runId, stepId, action: "updated", origin: step.origin,
      previous: { title: step.title, status: step.status, toolName: step.tool_name, parametersText: step.parameters_text, commentsText: step.comments_text, deviationNote: step.deviation_note, notes: step.notes },
      current: { title, status: input.status, toolName, parametersText, commentsText, deviationNote, notes },
    }), userEmail, now, stepId, runId, sampleId, mutationId),
  ];
  if (asset) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO run_step_assets (id, run_step_id, asset_id, role, position, actor_email, created_at)
     SELECT ?, ?, ?, 'execution',
            COALESCE((SELECT MAX(position) FROM run_step_assets WHERE run_step_id = ? AND role = 'execution'), -1) + 1,
            ?, ?
     WHERE EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
     )`,
  ).bind(crypto.randomUUID(), stepId, asset.id, stepId, userEmail, now, stepId, runId, sampleId, mutationId));
  if (asset) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, r.sample_id, 'image', ?, ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?`,
  ).bind(crypto.randomUUID(), `Execution diagram for step: ${title}`, asset.r2_key, JSON.stringify({ runId, stepId }), userEmail, now, stepId, runId, sampleId, mutationId));
  statements.push(c.env.DB.prepare(
    `UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ? AND EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
     )`,
  ).bind(userEmail, now, sampleId, stepId, runId, sampleId, mutationId));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
  if (!results[1].meta.changes || !results[results.length - 1].meta.changes) throw new Error("Atomic step record was not completed");
  return c.json({ ok: true });
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
    c.env.DB.prepare("SELECT id, anchor_step_id FROM runs WHERE id = ? AND sample_id = ? AND status = 'active'").bind(runId, sampleId).first<{ id: string; anchor_step_id: string | null }>(),
    c.env.DB.prepare("SELECT id, position FROM run_steps WHERE run_id = ? ORDER BY position").bind(runId).all<{ id: string; position: number }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id, r2_key FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; r2_key: string }>() : Promise.resolve(null),
  ]);
  if (!run) throw new HTTPException(404, { message: "Sample run not found" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const position = insertionPosition(stepRows.results, input.afterStepId);
  if (position === null) throw new HTTPException(404, { message: "Insertion point not found" });
  const stepId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const afterIndex = input.afterStepId ? stepRows.results.findIndex((step) => step.id === input.afterStepId) : -1;
  const previousStepId = input.afterStepId ?? run.anchor_step_id;
  const nextStepId = stepRows.results[afterIndex + 1]?.id ?? null;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO step_definitions
       (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
      definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
    c.env.DB.prepare(
      `INSERT INTO run_steps
        (id, run_id, previous_step_id, position, title, status, origin, logical_step_key, definition_hash,
         tool_name, parameters_text, comments_text, deviation_note, actualized_at, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 'ad_hoc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(stepId, runId, previousStepId, position, title, `ad-hoc:${stepId}`, definition.hash,
      input.toolName.trim() || null, input.parametersText.trim() || null, input.commentsText.trim() || null,
      input.deviationNote.trim() || null, now, now, userEmail, now),
  ];
  if (nextStepId) statements.push(c.env.DB.prepare(
    "UPDATE run_steps SET previous_step_id = ? WHERE id = ? AND run_id = ?",
  ).bind(stepId, nextStepId, runId));
  if (asset) statements.push(c.env.DB.prepare(
    "INSERT INTO run_step_assets (id, run_step_id, asset_id, role, position, actor_email, created_at) VALUES (?, ?, ?, 'execution', 0, ?, ?)",
  ).bind(crypto.randomUUID(), stepId, asset.id, userEmail, now));
  statements.push(
    c.env.DB.prepare("UPDATE runs SET status = 'active', completed_at = NULL WHERE id = ? AND sample_id = ?").bind(runId, sampleId),
    c.env.DB.prepare(
      "INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at) VALUES (?, ?, 'step', ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), sampleId, `Added ad hoc step: ${title}`, JSON.stringify({ runId, stepId, action: "added", afterStepId: input.afterStepId ?? null, deviationNote: input.deviationNote.trim() || null }), userEmail, now),
    c.env.DB.prepare("UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?").bind(userEmail, now, sampleId),
  );
  await c.env.DB.batch(statements);
  return c.json({ id: stepId }, 201);
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
     WHERE rs.updated_at = q.expected_updated_at`,
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
  const statements: D1PreparedStatement[] = input.targets.map((target) => c.env.DB.prepare(
    `INSERT INTO run_step_comments
       (id, run_step_id, scope, operation_group_id, body, asset_id, actor_email, created_at)
     SELECT ?, rs.id, ?, ?, ?, ?, ?, ?
     FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.updated_at = ?`,
  ).bind(
    crypto.randomUUID(), input.scope, operationGroupId, body, commentAsset?.id ?? null, userEmail, now,
    target.stepId, target.runId, target.sampleId, target.expectedUpdatedAt,
  ));
  for (const target of input.targets) statements.push(c.env.DB.prepare(
    `UPDATE run_steps SET actualized_at = COALESCE(actualized_at, ?), updated_by = ?, updated_at = ?
     WHERE id = ? AND run_id = ? AND updated_at = ?`,
  ).bind(now, userEmail, now, target.stepId, target.runId, target.expectedUpdatedAt));
  for (const sampleId of sampleIds) {
    const stepIds = input.targets.filter((target) => target.sampleId === sampleId).map((target) => target.stepId);
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
       VALUES (?, ?, 'step', ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), sampleId,
      input.scope === "common" ? `Common step comment: ${body || "Image attached"}` : `Step comment: ${body || "Image attached"}`,
      commentAsset?.r2_key ?? null,
      JSON.stringify({ action: "step_comment", scope: input.scope, operationGroupId, stepIds }),
      userEmail, now,
    ));
    statements.push(c.env.DB.prepare(
      "UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?",
    ).bind(userEmail, now, sampleId));
  }
  const results = await c.env.DB.batch(statements);
  if (results.slice(0, input.targets.length * 2).some((result) => !result.meta.changes)) {
    throw new HTTPException(409, { message: "One or more sample steps changed before the comment was saved" });
  }
  return c.json({ ok: true, operationGroupId }, 201);
});

app.delete("/run-step-comments/:id", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id
     FROM run_step_comments rsc
     JOIN run_steps rs ON rs.id = rsc.run_step_id
     JOIN runs r ON r.id = rs.run_id
     WHERE rsc.id = ?`,
  ).bind(commentId).first<{
    id: string; scope: "common" | "individual"; operation_group_id: string | null;
  }>();
  if (!comment) throw new HTTPException(404, { message: "Step comment not found" });

  const removeCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  const targets = removeCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ?`,
    ).bind(comment.operation_group_id).all<{ id: string; run_step_id: string; sample_id: string; updated_at: string; sample_updated_at: string }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsc.id = ?`,
    ).bind(comment.id).all<{ id: string; run_step_id: string; sample_id: string; updated_at: string; sample_updated_at: string }>();
  if (!targets.results.length) throw new HTTPException(404, { message: "Step comment not found" });

  const latestUpdate = Math.max(...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map((value) => Date.parse(value)).filter(Number.isFinite));
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")})`,
    ).bind(userEmail, now, ...stepIds),
    removeCommonGroup
      ? c.env.DB.prepare(
        "DELETE FROM run_step_comments WHERE scope = 'common' AND operation_group_id = ?",
      ).bind(comment.operation_group_id)
      : c.env.DB.prepare("DELETE FROM run_step_comments WHERE id = ?").bind(comment.id),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `DELETE FROM events
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?`,
  ).bind(comment.operation_group_id));
  for (const sampleId of sampleIds) statements.push(c.env.DB.prepare(
    "UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?",
  ).bind(userEmail, now, sampleId));

  const results = await c.env.DB.batch(statements);
  const deleted = results[1].meta.changes ?? 0;
  if (!deleted) throw new HTTPException(409, { message: "The comment was already deleted" });
  return c.json({ ok: true, deleted });
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
       WHERE rs.updated_at = q.expected_updated_at AND rs.status IN ('pending', 'in_progress')
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
       WHERE id = ? AND EXISTS (
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
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.plan_status = 'current'`,
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
       WHERE sv.sample_id = ? AND sv.status = 'valid'
       ORDER BY sv.created_at DESC, sv.id DESC LIMIT 1`,
    ).bind(sampleId).first<{ id: string; after_run_step_id: string }>(),
    c.env.DB.prepare(
      `SELECT rs.id, rs.status, rs.plan_status, rs.actualized_at, r.sequence_no, rs.position
       FROM runs r JOIN run_steps rs ON rs.run_id = r.id
       WHERE r.sample_id = ? ORDER BY r.sequence_no, rs.position`,
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
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_steps SET status = CASE WHEN ? THEN 'done' ELSE status END,
              actualized_at = COALESCE(actualized_at, ?), updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND updated_at = ?`,
    ).bind(input.completeStep ? 1 : 0, now, userEmail, now, stepId, runId, input.expectedUpdatedAt),
    c.env.DB.prepare(
      `INSERT INTO state_verifications
       (id, sample_id, after_run_step_id, previous_verification_id, run_plan_revision_id,
        expected_state_hash, result, evidence_asset_id, note, actor_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(verificationId, sampleId, stepId, previous?.id ?? null, target.current_plan_revision_id,
      target.expected_state_hash, input.result, evidence?.id ?? null, note, userEmail, now),
    ...bulkInsertStatements(c.env.DB, "state_verification_steps",
      ["verification_id", "run_step_id", "ordinal"],
      covered.map((step, index) => [verificationId, step.id, index])),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
       VALUES (?, ?, 'verification', ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), sampleId,
      `State ${input.result === "matched" ? "verified" : "mismatch recorded"} after ${covered.length} step${covered.length === 1 ? "" : "s"}`,
      evidence?.r2_key ?? null,
      JSON.stringify({ verificationId, runId, stepId, previousVerificationId: previous?.id ?? null, coveredStepIds: covered.map((step) => step.id), result: input.result }),
      userEmail, now),
    c.env.DB.prepare("UPDATE samples SET process_revision = process_revision + 1, updated_by = ?, updated_at = ? WHERE id = ?")
      .bind(userEmail, now, sampleId),
  ];
  if (input.result === "mismatched") statements.push(c.env.DB.prepare(
    `INSERT INTO recipe_change_proposals
     (id, recipe_family_id, source_template_version_id, source_verification_id, change_type, body, actor_email, created_at)
     VALUES (?, ?, ?, ?, 'expected_state', ?, ?, ?)`,
  ).bind(crypto.randomUUID(), target.recipe_family_id, target.template_version_id, verificationId,
    note || "Observed state did not match the recipe's expected state", userEmail, now));
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
  } as const;
  const names = Object.keys(tableQueries);
  const results = await c.env.DB.batch(Object.values(tableQueries).map((sql) => c.env.DB.prepare(sql)));
  const entries = names.map((name, index) => [name, results[index].results ?? []] as const);
  const tables = Object.fromEntries(entries) as Record<string, Array<Record<string, unknown>>>;
  return c.json({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    tables,
    assetKeys: collectExportAssetKeys(tables.assets, tables.imports),
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
    templateType: "process" | "module" | "recipe";
    recipeFamilyId?: string | null;
    source: { fileName: string; fileSha256: string; sheetName: string };
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
    warnings: unknown[];
  };
  if (manifest.schemaVersion !== 1 || typeof manifest.title !== "string" || !manifest.title.trim() || manifest.title.length > 200 || typeof manifest.source?.sheetName !== "string" || !manifest.source.sheetName || !Array.isArray(manifest.steps) || !manifest.steps.length || !Array.isArray(manifest.images) || !Array.isArray(manifest.warnings)) {
    throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  }
  if (!["process", "module", "recipe"].includes(manifest.templateType)) throw new HTTPException(400, { message: "Invalid template type" });
  if (manifest.recipeFamilyId !== undefined && manifest.recipeFamilyId !== null && typeof manifest.recipeFamilyId !== "string") {
    throw new HTTPException(400, { message: "Invalid recipe family" });
  }
  if (manifest.steps.length > 180 || manifest.images.length > 40) {
    throw new HTTPException(413, { message: "This import exceeds the 180-step or 40-image deployment limit" });
  }
  for (const image of manifest.images) {
    if (!(form.get(`image:${image.localId}`) instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
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
    : await c.env.DB.prepare("SELECT id, name, template_type FROM recipe_families WHERE name = ? AND template_type = ? AND archived_at IS NULL")
      .bind(manifest.title.trim(), manifest.templateType).first<{ id: string; name: string; template_type: string }>();
  if (manifest.recipeFamilyId && !existingFamily) throw new HTTPException(404, { message: "Recipe family not found" });
  if (existingFamily && existingFamily.template_type !== manifest.templateType) throw new HTTPException(409, { message: "The selected recipe family has a different type" });
  const recipeFamilyId = existingFamily?.id ?? crypto.randomUUID();
  const recipeName = existingFamily?.name ?? manifest.title.trim();
  const importId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  await c.env.DB.prepare(
    `INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type, recipe_family_id, warning_count, actor_email, created_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(importId, workbook.name, actualSha, manifest.source.sheetName, manifest.templateType, recipeFamilyId, manifest.warnings.length, userEmail, now).run();

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

    const numberedCounts = new Map<string, number>();
    for (const step of manifest.steps) if (step.stepNumber?.trim()) {
      const key = step.stepNumber.trim();
      numberedCounts.set(key, (numberedCounts.get(key) ?? 0) + 1);
    }
    const occurrences = new Map<string, number>();
    const definitions = new Map<string, Awaited<ReturnType<typeof hashStepDefinition>>>();
    const states = new Map<string, Awaited<ReturnType<typeof hashStateRepresentation>>>();
    const stateAssetRows = new Map<string, [string, string, number]>();
    let inheritedStateHash: string | null = null;
    const preparedSteps: Array<{
      source: typeof manifest.steps[number]; logicalKey: string; definitionHash: string; expectedStateHash: string | null;
    }> = [];
    for (const step of manifest.steps) {
      const occurrenceKey = step.stepNumber?.trim() ? `number:${step.stepNumber.trim()}` : `name:${step.name.trim().toLocaleLowerCase()}`;
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      const logicalKey = logicalStepKey(step, occurrence, Boolean(step.stepNumber?.trim() && (numberedCounts.get(step.stepNumber.trim()) ?? 0) > 1));
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
      ).bind(recipeFamilyId, recipeName, manifest.templateType, userEmail, now)] : []),
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
          state.hash, STATE_HASH_SCHEME, "diagram", stableJson(state.canonical), now,
        ])),
      ...bulkInsertStatements(c.env.DB, "state_representation_assets",
        ["state_hash", "asset_id", "position"],
        [...stateAssetRows.values()].filter(([stateHash]) => !existingStateHashes.has(stateHash))),
      c.env.DB.prepare(
        `INSERT INTO template_versions
          (id, recipe_family_id, name, template_type, version, manifest_hash, source_filename, source_asset_key, content_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(templateVersionId, recipeFamilyId, recipeName, manifest.templateType, version, manifestHash, workbook.name, workbookAsset.key, JSON.stringify({
        schemaVersion: manifest.schemaVersion,
        source: manifest.source,
        importedTitle: manifest.title,
        templateType: manifest.templateType,
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

app.get("/templates", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT tv.id, tv.recipe_family_id, tv.name, tv.template_type, tv.version, tv.manifest_hash, tv.source_filename, tv.created_at,
            tv.locked_at, tv.archived_at,
            (SELECT COUNT(*) FROM template_steps ts WHERE ts.template_version_id = tv.id) AS step_count
     FROM template_versions tv
     WHERE tv.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')
     ORDER BY tv.name, tv.template_type, tv.version DESC`,
  ).all<{
    id: string;
    recipe_family_id: string;
    name: string;
    template_type: "process" | "module" | "recipe";
    version: number;
    manifest_hash: string;
    source_filename: string | null;
    created_at: string;
    locked_at: string | null;
    archived_at: string | null;
    step_count: number;
  }>();
  return c.json({ templates: result.results.map((row) => ({
    id: row.id,
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    templateType: row.template_type,
    version: row.version,
    manifestHash: row.manifest_hash,
    sourceFilename: row.source_filename,
    stepCount: Number(row.step_count),
    locked: Boolean(row.locked_at),
    lockedAt: row.locked_at,
    createdAt: row.created_at,
  })) });
});

app.post("/templates/:id/clone", async (c) => {
  const sourceId = c.req.param("id");
  const [source, steps] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM template_versions WHERE id = ?").bind(sourceId).first<Record<string, unknown>>(),
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
        (id, recipe_family_id, name, template_type, version, manifest_hash, initial_state_hash,
         source_filename, source_asset_key, content_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, source.recipe_family_id, source.name, source.template_type, version, source.manifest_hash,
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
  const [template, stepRows, assetRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, recipe_family_id, name, template_type, version, manifest_hash, source_filename, locked_at, archived_at, created_at
       FROM template_versions WHERE id = ?`,
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
  ]);
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  const images = new Map<string, string[]>();
  for (const row of assetRows.results) images.set(row.template_step_id, [...(images.get(row.template_step_id) ?? []), row.r2_key]);
  return c.json({ template: {
    id: String(template.id), recipeFamilyId: String(template.recipe_family_id), name: String(template.name), templateType: String(template.template_type), version: Number(template.version),
    manifestHash: String(template.manifest_hash),
    sourceFilename: template.source_filename ? String(template.source_filename) : null,
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
  const current = await c.env.DB.prepare("SELECT locked_at, archived_at FROM template_versions WHERE id = ?").bind(id).first<{ locked_at: string | null; archived_at: string | null }>();
  if (!current) throw new HTTPException(404, { message: "Template version not found" });
  if (current.archived_at) throw new HTTPException(409, { message: "Archived templates cannot be edited" });
  if (current.locked_at) throw new HTTPException(409, { message: "This template was assigned and is now locked. Clone it to create an editable version." });
  try {
    const result = await c.env.DB.prepare("UPDATE template_versions SET name = ?, version = ? WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL").bind(name, input.version, id).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: "This template was assigned while you were editing it. Clone it to continue." });
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
    c.env.DB.prepare("SELECT locked_at, archived_at FROM template_versions WHERE id = ?").bind(templateId).first<{ locked_at: string | null; archived_at: string | null }>(),
    c.env.DB.prepare("SELECT logical_step_key, definition_hash, expected_state_hash, position FROM template_steps WHERE template_version_id = ? ORDER BY position")
      .bind(templateId).all<{ logical_step_key: string; definition_hash: string; expected_state_hash: string | null; position: number }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id, sha256 FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; sha256: string }>() : Promise.resolve(null),
  ]);
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
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
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL`,
  ).bind(stepId, logicalKey, Number(existingSteps.results.at(-1)?.position ?? -1) + 1, definition.hash, expectedStateHash, templateId));
  statements.push(c.env.DB.prepare(
    "UPDATE template_versions SET manifest_hash = ? WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL",
  ).bind(manifestHash, templateId));
  const results = await c.env.DB.batch(statements);
  if (!results[results.length - 2].meta.changes || !results.at(-1)?.meta.changes) throw new HTTPException(409, { message: "This template was assigned while you were editing it. Clone it to continue." });
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
    c.env.DB.prepare("SELECT locked_at, archived_at FROM template_versions WHERE id = ?").bind(templateId).first<{ locked_at: string | null; archived_at: string | null }>(),
    c.env.DB.prepare("SELECT id, logical_step_key, expected_state_hash FROM template_steps WHERE id = ? AND template_version_id = ?")
      .bind(stepId, templateId).first<{ id: string; logical_step_key: string; expected_state_hash: string | null }>(),
    c.env.DB.prepare("SELECT id, logical_step_key, definition_hash, expected_state_hash FROM template_steps WHERE template_version_id = ? ORDER BY position")
      .bind(templateId).all<{ id: string; logical_step_key: string; definition_hash: string; expected_state_hash: string | null }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id, sha256 FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; sha256: string }>() : Promise.resolve(null),
  ]);
  if (!template || !step) throw new HTTPException(404, { message: "Template step not found" });
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
       SELECT 1 FROM template_versions WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL
     )`,
  ).bind(definition.hash, expectedStateHash, stepId, templateId, templateId));
  statements.push(c.env.DB.prepare(
    "UPDATE template_versions SET manifest_hash = ? WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL",
  ).bind(manifestHash, templateId));
  const results = await c.env.DB.batch(statements);
  if (!results[results.length - 2].meta.changes || !results.at(-1)?.meta.changes) throw new HTTPException(409, { message: "This template was assigned while you were editing it. Clone it to continue." });
  return c.json({ ok: true });
});

app.delete("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    "UPDATE template_versions SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS NULL",
  ).bind(now, c.get("userEmail"), id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Active template version not found" });
  return c.json({ ok: true });
});

export default app;

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hashRecipeManifest, hashStateRepresentation, hashStepDefinition, stableJson, STATE_HASH_SCHEME, STEP_HASH_SCHEME } from "../../shared/content-addressing";
import { bulkInsertStatements } from "../d1-bulk";
import { contentLengthWithin } from "../request-guards";
import { BlobRegistrationAuthorityUnavailableError, registerR2Asset } from "../blob-lifecycle/registration";
import { publishedAssetSql, publishedTemplateVersionSql } from "../template-publication";
import { likeBindings, paginationMeta, readPagination, repeatedLikeSql, searchTokens } from "../directory-query";
import type { Env } from "../types";
import { parseInitialSubstrateStep } from "./substrate";
import { digestSha256, reusableR2Asset, safeObjectName } from "../application/r2-upload-support";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

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

async function requirePublishedTemplateVersion(db: D1Database, id: string) {
  const row = await db.prepare(`
    SELECT 1 AS published
    FROM template_versions tv
    WHERE tv.id = ? AND ${publishedTemplateVersionSql("tv")}
  `).bind(id).first<{ published: number }>();
  if (!row) throw new HTTPException(404, { message: "Template version not found" });
}

const visibleProcessTemplateSql = (alias: string) => `
  ${alias}.template_kind = 'process'
  AND ${alias}.archived_at IS NULL
  AND ${alias}.deleted_at IS NULL
  AND ${publishedTemplateVersionSql(alias)}`;

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
   WHERE sra.state_hash = tv.initial_state_hash
     AND ${publishedAssetSql("initial_asset")}) AS initial_asset_count`;

routes.get("/template-families/options", async (c) => {
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

routes.get("/template-families", async (c) => {
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

routes.get("/template-families/:id/versions", async (c) => {
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

routes.get("/metrology-templates", async (c) => {
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
      AND ${publishedTemplateVersionSql("tv")}
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

routes.get("/templates", async (c) => {
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
       AND ${publishedTemplateVersionSql("tv")}
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
         AND ${publishedTemplateVersionSql("tv")}
         AND ${publishedAssetSql("a")}
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

routes.post("/metrology-templates", async (c) => {
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

routes.patch("/metrology-templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
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

routes.patch("/metrology-templates/:id/notes", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
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

routes.post("/metrology-templates/:id/references", async (c) => {
  const templateId = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, templateId);
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
    `SELECT mtr.id, mtr.asset_id, mtr.display_name, mtr.created_at, mtr.deleted_at
     FROM metrology_template_references mtr
     JOIN assets a ON a.id = mtr.asset_id AND a.status = 'ready'
     WHERE mtr.template_version_id = ? AND a.sha256 = ?
       AND ${publishedAssetSql("a")}
     ORDER BY mtr.created_at DESC LIMIT 1`,
  ).bind(templateId, sha256).first<{
    id: string; asset_id: string; display_name: string;
    created_at: string; deleted_at: string | null;
  }>();

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const assetId = crypto.randomUUID();
  const key = `metrology/${templateId}/${assetId}-${safeObjectName(filename)}`;
  const registration = await registerR2Asset(c.env, {
      id: assetId,
      objectKey: key,
      originalName: filename,
      mimeType,
      byteSize: buffer.byteLength,
      sha256,
      actorEmail: userEmail,
      bytes: buffer,
      findWinner: () => reusableR2Asset(c.env, sha256),
    }).catch((error: unknown) => {
      if (error instanceof BlobRegistrationAuthorityUnavailableError) {
        throw new HTTPException(503, {
          message: error.publicMessage,
        });
      }
      throw error;
    });
  const asset = registration.asset;

  if (existingReference) {
    const displayName = existingReference.deleted_at ? filename : existingReference.display_name;
    if (existingReference.deleted_at || existingReference.asset_id !== asset.id) {
      try {
        const updated = await c.env.DB.prepare(
          `UPDATE metrology_template_references
           SET asset_id = ?, display_name = ?, deleted_at = NULL, deleted_by = NULL
           WHERE id = ? AND template_version_id = ?`,
        ).bind(asset.id, displayName, existingReference.id, templateId).run();
        if (!updated.meta.changes) throw new HTTPException(409, { message: "This reference file changed elsewhere" });
      } catch (error) {
        // A committed ready asset may already have been reused elsewhere.
        // Leave an unattached row to the shared registration-grace/GC path.
        throw error;
      }
    }
    return c.json({ reference: {
      id: existingReference.id,
      filename: displayName,
      mimeType: asset.mime_type,
      byteSize: Number(asset.byte_size),
      assetKey: asset.r2_key,
      createdAt: existingReference.created_at,
    } });
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
    // Once ready registration commits, route-local rollback no longer owns the
    // provider object. Unattached assets are reclaimed through shared GC.
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

routes.delete("/metrology-templates/:id/references/:referenceId", async (c) => {
  const { id, referenceId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, id);
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

routes.post("/metrology-templates/:id/references/:referenceId/restore", async (c) => {
  const { id, referenceId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, id);
  const result = await c.env.DB.prepare(
    `UPDATE metrology_template_references
     SET deleted_at = NULL, deleted_by = NULL
     WHERE id = ? AND template_version_id = ? AND deleted_at IS NOT NULL
       AND superseded_by_occurrence_id IS NULL
       AND EXISTS (
         SELECT 1 FROM template_versions
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL
       )`,
  ).bind(referenceId, id, id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Deleted template reference not found" });
  return c.json({ ok: true });
});

routes.post("/templates/:id/clone", async (c) => {
  const sourceId = c.req.param("id");
  const [source, steps] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM template_versions tv
       WHERE tv.id = ? AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}`,
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

routes.get("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const [template, stepRows, assetRows, initialAssetRows, referenceRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, recipe_family_id, name, template_type, template_kind, metrology_notes,
              version, manifest_hash, initial_state_hash,
              source_filename, content_json, locked_at, archived_at, created_at
       FROM template_versions tv
       WHERE tv.id = ? AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}`,
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
       WHERE ts.template_version_id = ?
         AND ${publishedAssetSql("a")}
       ORDER BY ts.id, sra.position, a.id`,
    ).bind(id).all<{ template_step_id: string; r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT a.r2_key
       FROM template_versions tv
       JOIN state_representation_assets sra ON sra.state_hash = tv.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE tv.id = ?
         AND ${publishedTemplateVersionSql("tv")}
         AND ${publishedAssetSql("a")}
       ORDER BY sra.position, a.id`,
    ).bind(id).all<{ r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT mtr.id, mtr.display_name, a.mime_type, a.byte_size, a.r2_key, mtr.created_at
       FROM metrology_template_references mtr
       JOIN assets a ON a.id = mtr.asset_id AND a.status = 'ready'
       WHERE mtr.template_version_id = ? AND mtr.deleted_at IS NULL
         AND ${publishedAssetSql("a")}
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

routes.patch("/templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
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

routes.post("/templates/:id/steps", async (c) => {
  const templateId = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, templateId);
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
    input.assetKey ? c.env.DB.prepare(
      `SELECT id, sha256 FROM assets a WHERE status = 'ready' AND r2_key = ?
         AND ${publishedAssetSql("a")}
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         )`,
    ).bind(input.assetKey).first<{ id: string; sha256: string }>() : Promise.resolve(null),
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

routes.patch("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, templateId);
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
    input.assetKey ? c.env.DB.prepare(
      `SELECT id, sha256 FROM assets a WHERE status = 'ready' AND r2_key = ?
         AND ${publishedAssetSql("a")}
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         )`,
    ).bind(input.assetKey).first<{ id: string; sha256: string }>() : Promise.resolve(null),
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

routes.delete("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, templateId);
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

routes.delete("/templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
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

routes.post("/templates/:id/restore", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
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

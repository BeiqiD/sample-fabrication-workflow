import { nativeAssetUrl } from "../../shared/contracts/r2-upload";
import { HTTPException } from "hono/http-exception";
import type { MetrologyTemplateReference, MetrologyTemplateSummary, ProcessTemplateFamilyOption,
  ProcessTemplateFamilySummary, ProcessTemplateVersionSummary, TemplateDetail, TemplateRecord, TemplateStepRecord } from "../../shared/contracts/template";
import { publishedAssetSql, publishedTemplateVersionSql } from "../template-publication";
import { likeBindings, paginationMeta, readPagination, repeatedLikeSql, searchTokens } from "../directory-query";
import { parseInitialSubstrateStep } from "./substrate";
import type { ReadSqlDatabase, ReadSqlRow } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import { readSqlFileAuthorityMode } from "../files/authority-mode";
import { templateReadDirectoryRow, templateReadFamilyOptionRow, templateReadMetrologyRow,
  templateReadListRow, templateReadAssetRow, templateReadReferenceRow } from "./read-decoding";

export type TemplateDirectoryInput = { query?: string; page?: string; pageSize?: string };
export type TemplateReadResponse<T> = { payload: T; serverTiming?: string };

function processTemplateVersionSummary(raw: ReadSqlRow): ProcessTemplateVersionSummary {
  const row = templateReadDirectoryRow(raw);
  return {
    id: row.id,
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    templateType: row.template_type,
    version: row.version,
    sourceFilename: row.source_filename,
    stepCount: row.step_count,
    initialStateHash: row.initial_state_hash,
    hasInitialSubstrateStep: Boolean(row.has_initial_substrate_step),
    initialStateImageCount: row.initial_asset_count,
    locked: Boolean(row.locked_at),
    createdAt: row.created_at,
  };
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

export async function templateFamilyOptions(db: ReadSqlDatabase) {
  const d1Started = performance.now();
  const result = await db.prepare(
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
  ).all();
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { families: result.results.map(templateReadFamilyOptionRow).map((row): ProcessTemplateFamilyOption => ({
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    latestVersion: row.version,
  })) };
  const serializeDuration = performance.now() - serializeStarted;
  return { payload, serverTiming: `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}` };
}

export async function templateFamilyDirectory(db: ReadSqlDatabase, input: TemplateDirectoryInput) {
  const query = input.query?.trim() ?? "";
  const { page, pageSize, offset } = readPagination(input.page, input.pageSize, 20);
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
    db.prepare(
      `SELECT ${processTemplateDirectoryColumns},
              (SELECT COUNT(*) FROM template_versions family_version
               WHERE family_version.recipe_family_id = tv.recipe_family_id
                 AND ${visibleProcessTemplateSql("family_version")}) AS version_count
       FROM template_versions tv
       WHERE ${latestWhere}
       ORDER BY tv.name, tv.template_type, tv.recipe_family_id
       LIMIT ? OFFSET ?`,
    ).bind(...search.bindings, pageSize, offset).all(),
    db.prepare(
      `SELECT COUNT(*) AS total
       FROM template_versions tv
       WHERE ${latestWhere}`,
    ).bind(...search.bindings).first(),
  ]);
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = {
    families: result.results.map(templateReadDirectoryRow).map((row): ProcessTemplateFamilySummary => ({
      recipeFamilyId: row.recipe_family_id,
      name: row.name,
      templateType: row.template_type,
      latestVersion: row.version,
      versionCount: row.version_count ?? 1,
      latest: processTemplateVersionSummary(row),
    })),
    pagination: paginationMeta(configurationSqlInteger(countRow?.total ?? 0, "templateDirectory.total"), page, pageSize),
  };
  const serializeDuration = performance.now() - serializeStarted;
  return { payload, serverTiming: `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}` };
}

export async function templateFamilyVersions(db: ReadSqlDatabase, recipeFamilyId: string, query: string) {
  const search = processTemplateFamilySearch(query.trim(), "tv");
  const d1Started = performance.now();
  const result = await db.prepare(
    `SELECT ${processTemplateDirectoryColumns}
     FROM template_versions tv
     WHERE tv.recipe_family_id = ?
       AND ${visibleProcessTemplateSql("tv")}
       AND ${search.sql}
     ORDER BY tv.version DESC, tv.created_at DESC`,
  ).bind(recipeFamilyId, ...search.bindings).all();
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { versions: result.results.map(processTemplateVersionSummary) };
  const serializeDuration = performance.now() - serializeStarted;
  return { payload, serverTiming: `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}` };
}

export async function metrologyTemplateDirectory(db: ReadSqlDatabase, input: TemplateDirectoryInput) {
  const query = input.query?.trim() ?? "";
  const { page, pageSize, offset } = readPagination(input.page, input.pageSize, 25);
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
    db.prepare(
      `SELECT tv.id, tv.name, tv.created_at, sd.tool_name,
              CASE WHEN NULLIF(TRIM(sd.parameters_text), '') IS NOT NULL
                     OR NULLIF(TRIM(sd.comments_text), '') IS NOT NULL
                   THEN 1 ELSE 0 END AS has_default_content
       ${fromSql}
       ORDER BY tv.name, tv.created_at DESC, tv.id
       LIMIT ? OFFSET ?`,
    ).bind(...search.bindings, pageSize, offset).all(),
    db.prepare(`SELECT COUNT(*) AS total ${fromSql}`)
      .bind(...search.bindings).first(),
  ]);
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = {
    templates: result.results.map(templateReadMetrologyRow).map((row): MetrologyTemplateSummary => ({
      id: row.id,
      name: row.name,
      toolName: row.tool_name,
      hasDefaultContent: Boolean(row.has_default_content),
      createdAt: row.created_at,
    })),
    pagination: paginationMeta(configurationSqlInteger(countRow?.total ?? 0, "templateDirectory.total"), page, pageSize),
  };
  const serializeDuration = performance.now() - serializeStarted;
  return { payload, serverTiming: `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}` };
}

export async function templateList(db: ReadSqlDatabase, pickerView: boolean, selectAuthorityDatabase: () => ReadSqlDatabase) {
  const d1Started = performance.now();
  const [result, initialAssetRows] = await Promise.all([
    db.prepare(
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
  ).all(),
    pickerView ? Promise.resolve({ results: [] as ReadSqlRow[] }) : db.prepare(
      `SELECT tv.id AS template_version_id, a.r2_key, a.id asset_id, ${await readSqlFileAuthorityMode(selectAuthorityDatabase) === "active" ? 'sra.file_id' : 'NULL'} file_id
       FROM template_versions tv
       JOIN state_representation_assets sra ON sra.state_hash = tv.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE tv.archived_at IS NULL AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}
         AND ${publishedAssetSql("a")}
       ORDER BY tv.id, sra.position, a.id`,
    ).all(),
  ]);
  const initialAssets = new Map<string, string[]>();
  const nativeInitialAssets = new Map<string, Array<{ assetId: string; fileId: string; url: string }>>();
  for (const row of initialAssetRows.results.map(templateReadAssetRow)) {
    if (row.r2_key !== null) initialAssets.set(row.template_version_id, [...(initialAssets.get(row.template_version_id) ?? []), row.r2_key]);
    else if (row.file_id) nativeInitialAssets.set(row.template_version_id, [...(nativeInitialAssets.get(row.template_version_id) ?? []),
      { assetId: row.asset_id, fileId: row.file_id, url: nativeAssetUrl(row.asset_id) }]);
  }
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { templates: result.results.map(templateReadListRow).map((row): TemplateRecord => ({
    id: row.id,
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    templateType: row.template_type,
    templateKind: row.template_kind,
    version: row.version,
    manifestHash: row.manifest_hash,
    sourceFilename: row.source_filename,
    stepCount: row.step_count,
    toolName: row.tool_name,
    parametersText: row.parameters_text,
    commentsText: row.comments_text,
    initialStateHash: row.initial_state_hash,
    initialStateImageKeys: initialAssets.get(row.id) ?? [],
    ...(nativeInitialAssets.has(row.id) ? { initialStateImages: nativeInitialAssets.get(row.id) } : {}),
    initialSubstrateStep: pickerView ? null : parseInitialSubstrateStep(row.content_json),
    locked: Boolean(row.locked_at),
    lockedAt: row.locked_at,
    createdAt: row.created_at,
  })) };
  const serializeDuration = performance.now() - serializeStarted;
  return { payload, serverTiming: `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}` };
}

export async function templateDetail(db: ReadSqlDatabase, id: string, selectAuthorityDatabase: () => ReadSqlDatabase) {
  const [template, stepRows, assetRows, initialAssetRows, referenceRows] = await Promise.all([
    db.prepare(
      `SELECT id, recipe_family_id, name, template_type, template_kind, metrology_notes,
              version, manifest_hash, initial_state_hash,
              source_filename, content_json, locked_at, archived_at, created_at
       FROM template_versions tv
       WHERE tv.id = ? AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}`,
    ).bind(id).first(),
    db.prepare(
      `SELECT ts.id, ts.logical_step_key, ts.definition_hash, ts.expected_state_hash,
              ts.position, ts.source_row, ts.step_number, ts.section_name,
              sd.name, sd.tool_name, sd.parameters_text, sd.comments_text
       FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
       WHERE ts.template_version_id = ? ORDER BY ts.position`,
    ).bind(id).all(),
    db.prepare(
      `SELECT ts.id AS template_step_id, a.r2_key, a.id asset_id, ${await readSqlFileAuthorityMode(selectAuthorityDatabase) === "active" ? 'sra.file_id' : 'NULL'} file_id
       FROM template_steps ts
       JOIN state_representation_assets sra ON sra.state_hash = ts.expected_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE ts.template_version_id = ?
         AND ${publishedAssetSql("a")}
       ORDER BY ts.id, sra.position, a.id`,
    ).bind(id).all(),
    db.prepare(
      `SELECT a.r2_key, a.id asset_id, ${await readSqlFileAuthorityMode(selectAuthorityDatabase) === "active" ? 'sra.file_id' : 'NULL'} file_id
       FROM template_versions tv
       JOIN state_representation_assets sra ON sra.state_hash = tv.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE tv.id = ?
         AND ${publishedTemplateVersionSql("tv")}
         AND ${publishedAssetSql("a")}
       ORDER BY sra.position, a.id`,
    ).bind(id).all(),
    db.prepare(
      `SELECT mtr.id, mtr.display_name, a.mime_type, a.byte_size, a.r2_key, mtr.created_at, a.id asset_id, ${await readSqlFileAuthorityMode(selectAuthorityDatabase) === "active" ? 'mtr.file_id' : 'NULL'} file_id
       FROM metrology_template_references mtr
       JOIN assets a ON a.id = mtr.asset_id AND a.status = 'ready'
       WHERE mtr.template_version_id = ? AND mtr.deleted_at IS NULL
         AND ${publishedAssetSql("a")}
       ORDER BY mtr.position, mtr.created_at, mtr.id`,
    ).bind(id).all(),
  ]);
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  const images = new Map<string, string[]>();
  const nativeImages = new Map<string, Array<{ assetId: string; fileId: string; url: string }>>();
  for (const row of assetRows.results.map(templateReadAssetRow)) {
    if (row.r2_key !== null) images.set(row.template_step_id, [...(images.get(row.template_step_id) ?? []), row.r2_key]);
    else if (row.file_id) nativeImages.set(row.template_step_id, [...(nativeImages.get(row.template_step_id) ?? []),
      { assetId: row.asset_id, fileId: row.file_id, url: nativeAssetUrl(row.asset_id) }]);
  }
  return { payload: { template: {
    id: String(template.id), recipeFamilyId: String(template.recipe_family_id), name: String(template.name),
    templateType: String(template.template_type) as TemplateDetail["templateType"],
    templateKind: String(template.template_kind) as TemplateDetail["templateKind"],
    version: configurationSqlInteger(template.version, "template.version", 1),
    manifestHash: String(template.manifest_hash),
    initialStateHash: template.initial_state_hash ? String(template.initial_state_hash) : null,
    initialStateImageKeys: initialAssetRows.results.map(templateReadAssetRow).flatMap(row => row.r2_key === null ? [] : [row.r2_key]),
    ...(initialAssetRows.results.map(templateReadAssetRow).some(row => row.r2_key === null) ? { initialStateImages: initialAssetRows.results.map(templateReadAssetRow).flatMap(row =>
      row.r2_key === null && row.file_id ? [{ assetId: row.asset_id, fileId: row.file_id, url: nativeAssetUrl(row.asset_id) }] : []) } : {}),
    initialSubstrateStep: parseInitialSubstrateStep(template.content_json ? String(template.content_json) : null),
    sourceFilename: template.source_filename ? String(template.source_filename) : null,
    metrologyNotes: template.metrology_notes ? String(template.metrology_notes) : null,
    referenceAttachments: referenceRows.results.map(templateReadReferenceRow).map((reference): MetrologyTemplateReference => ({
      id: reference.id,
      filename: reference.display_name,
      mimeType: reference.mime_type,
      byteSize: reference.byte_size,
      assetKey: reference.r2_key,
      ...(reference.r2_key === null ? { fileId: reference.file_id ?? undefined, url: nativeAssetUrl(reference.asset_id) } : {}),
      createdAt: reference.created_at,
    })),
    locked: Boolean(template.locked_at), lockedAt: template.locked_at ? String(template.locked_at) : null,
    archived: Boolean(template.archived_at), createdAt: String(template.created_at),
    steps: stepRows.results.map((step): TemplateStepRecord => ({
      id: String(step.id), logicalStepKey: String(step.logical_step_key), definitionHash: String(step.definition_hash),
      expectedStateHash: step.expected_state_hash ? String(step.expected_state_hash) : null,
      position: configurationSqlInteger(step.position, "templateStep.position"), sourceRow: step.source_row === null ? null : configurationSqlInteger(step.source_row, "templateStep.sourceRow", Number.MIN_SAFE_INTEGER),
      stepNumber: step.step_number ? String(step.step_number) : null, sectionName: step.section_name ? String(step.section_name) : null,
      name: String(step.name), toolName: step.tool_name ? String(step.tool_name) : null,
      parametersText: step.parameters_text ? String(step.parameters_text) : null,
      commentsText: step.comments_text ? String(step.comments_text) : null,
      imageKeys: images.get(String(step.id)) ?? [],
      ...(nativeImages.has(String(step.id)) ? { images: nativeImages.get(String(step.id)) } : {}),
    })),
  } satisfies TemplateDetail } };
}

/** Caller supplies genuine capabilities and its request-bound live admission.
 * Reads retain their original Promise.all/sequential timing, not a new global
 * snapshot guarantee; source projections never expose mutation or byte ports. */
export function createTemplateReadService(options: {
  database(): ReadSqlDatabase;
  authorityDatabase(): ReadSqlDatabase;
  admit(actor: string): Promise<void>;
}) {
  const admitted = async <T>(actor: string, operation: (database: ReadSqlDatabase) => Promise<T>): Promise<T> => {
    await options.admit(actor); const result = await operation(options.database()); await options.admit(actor); return result;
  };
  return {
    options: (actor: string) => admitted(actor, templateFamilyOptions),
    families: (input: TemplateDirectoryInput, actor: string) => admitted(actor, db => templateFamilyDirectory(db, input)),
    versions: (familyId: string, query: string, actor: string) => admitted(actor, db => templateFamilyVersions(db, familyId, query)),
    metrology: (input: TemplateDirectoryInput, actor: string) => admitted(actor, db => metrologyTemplateDirectory(db, input)),
    list: (picker: boolean, actor: string) => admitted(actor, db => templateList(db, picker, options.authorityDatabase)),
    detail: (id: string, actor: string) => admitted(actor, db => templateDetail(db, id, options.authorityDatabase)),
  };
}
export type TemplateReadService = ReturnType<typeof createTemplateReadService>;

import type {
  ReferenceContext,
  ReferenceContextSegment,
  ReferenceTargetType,
  ResolvedReferenceSource,
} from "../../shared/reference-types";

export interface ResolvedReferenceRecord {
  source: ResolvedReferenceSource;
  contexts: ReferenceContext[];
  consistent: boolean;
}

export type ReferenceAdapter = (
  db: D1Database,
  ids: readonly string[],
) => Promise<Map<string, ResolvedReferenceRecord>>;

type Row = Record<string, unknown>;

function text(value: unknown) {
  return typeof value === "string" ? value : null;
}

function requiredText(value: unknown) {
  return text(value) ?? "";
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function excerpt(value: unknown, maximum = 240) {
  const normalized = requiredText(value).trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function uniqueIds(ids: readonly string[]) {
  return [...new Set(ids)];
}

async function allRows(
  db: D1Database,
  sql: string,
  ids: readonly string[],
): Promise<Row[]> {
  if (!ids.length) return [];
  const result = await db.prepare(sql).bind(JSON.stringify(uniqueIds(ids))).all<Row>();
  return result.results;
}

function sampleLabel(row: Row, prefix = "") {
  const code = requiredText(row[`${prefix}sample_code`]);
  const title = requiredText(row[`${prefix}sample_title`]);
  return code && title ? `${code} · ${title}` : code || title || "Sample";
}

function runLabel(row: Row, prefix = "") {
  const name = requiredText(row[`${prefix}run_template_name`]);
  const version = numeric(row[`${prefix}run_template_version`]);
  return name ? `${name} v${version}` : `Run ${requiredText(row[`${prefix}run_id`])}`;
}

function recipeLabel(row: Row, prefix = "") {
  const name = requiredText(row[`${prefix}recipe_name`]);
  const version = numeric(row[`${prefix}recipe_version`]);
  return name ? `${name} v${version}` : `Recipe revision ${requiredText(row[`${prefix}recipe_id`])}`;
}

function sampleSegment(row: Row, prefix = ""): ReferenceContextSegment | null {
  const id = text(row[`${prefix}sample_id`]);
  if (!id) return null;
  return {
    type: "sample",
    id,
    label: sampleLabel(row, prefix),
    deletedAt: text(row[`${prefix}sample_deleted_at`]),
    archivedAt: null,
  };
}

function runSegment(row: Row, prefix = ""): ReferenceContextSegment | null {
  const id = text(row[`${prefix}run_id`]);
  if (!id) return null;
  return {
    type: "run",
    id,
    label: runLabel(row, prefix),
    deletedAt: text(row[`${prefix}run_deleted_at`]),
    archivedAt: null,
  };
}

function stepSegment(row: Row, prefix = ""): ReferenceContextSegment | null {
  const id = text(row[`${prefix}step_id`]);
  if (!id) return null;
  return {
    type: "run_step",
    id,
    label: requiredText(row[`${prefix}step_title`]) || `Step ${id}`,
    deletedAt: text(row[`${prefix}step_deleted_at`]),
    archivedAt: null,
  };
}

function recipeSegment(row: Row, prefix = ""): ReferenceContextSegment | null {
  const id = text(row[`${prefix}recipe_id`]);
  if (!id) return null;
  return {
    type: "recipe_revision",
    id,
    label: recipeLabel(row, prefix),
    deletedAt: text(row[`${prefix}recipe_deleted_at`]),
    archivedAt: text(row[`${prefix}recipe_archived_at`]),
  };
}

function executionContext(row: Row): ReferenceContext | null {
  const segments = [sampleSegment(row), runSegment(row), stepSegment(row)];
  return segments.every(Boolean)
    ? { segments: segments as ReferenceContextSegment[] }
    : null;
}

function contextsByOwner(rows: Row[], ownerColumn: string) {
  const contexts = new Map<string, ReferenceContext[]>();
  const inconsistent = new Set<string>();
  for (const row of rows) {
    const ownerId = text(row[ownerColumn]);
    if (!ownerId) continue;
    const context = executionContext(row);
    if (!context) {
      inconsistent.add(ownerId);
      continue;
    }
    const existing = contexts.get(ownerId) ?? [];
    existing.push(context);
    contexts.set(ownerId, existing);
  }
  return { contexts, inconsistent };
}

const sampleAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT id AS sample_id, code AS sample_code, title AS sample_title,
           description, status, location, updated_at, deleted_at AS sample_deleted_at
    FROM samples
    WHERE id IN (SELECT value FROM json_each(?))
    ORDER BY id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.sample_id);
    const segment = sampleSegment(row)!;
    return [id, {
      source: {
        title: requiredText(row.sample_title) || requiredText(row.sample_code),
        subtitle: text(row.sample_code),
        excerpt: excerpt(row.description),
        kind: "sample",
        state: text(row.status),
        updatedAt: text(row.updated_at),
        deletedAt: text(row.sample_deleted_at),
        archivedAt: null,
      },
      contexts: [{ segments: [segment] }],
      consistent: true,
    }];
  }));
};

const runAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT r.id AS run_id, r.template_name_snapshot AS run_template_name,
           r.template_version_snapshot AS run_template_version,
           r.run_kind, r.status, r.created_at, r.completed_at,
           r.deleted_at AS run_deleted_at,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at
    FROM runs r
    LEFT JOIN samples s ON s.id = r.sample_id
    WHERE r.id IN (SELECT value FROM json_each(?))
    ORDER BY r.id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.run_id);
    const sample = sampleSegment(row);
    const run = runSegment(row);
    return [id, {
      source: {
        title: runLabel(row),
        subtitle: sample ? sample.label : null,
        excerpt: null,
        kind: text(row.run_kind),
        state: text(row.status),
        updatedAt: text(row.completed_at) ?? text(row.created_at),
        deletedAt: text(row.run_deleted_at),
        archivedAt: null,
      },
      contexts: sample && run ? [{ segments: [sample, run] }] : [],
      consistent: Boolean(sample && run),
    }];
  }));
};

const runStepAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT rs.id AS step_id, COALESCE(rs.title, sd.name) AS step_title,
           rs.entry_kind, rs.status, rs.notes, rs.updated_at,
           rs.deleted_at AS step_deleted_at,
           r.id AS run_id, r.template_name_snapshot AS run_template_name,
           r.template_version_snapshot AS run_template_version,
           r.deleted_at AS run_deleted_at,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at
    FROM run_steps rs
    LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
    LEFT JOIN runs r ON r.id = rs.run_id
    LEFT JOIN samples s ON s.id = r.sample_id
    WHERE rs.id IN (SELECT value FROM json_each(?))
    ORDER BY rs.id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.step_id);
    const context = executionContext(row);
    return [id, {
      source: {
        title: requiredText(row.step_title) || `Step ${id}`,
        subtitle: text(row.run_template_name),
        excerpt: excerpt(row.notes),
        kind: text(row.entry_kind),
        state: text(row.status),
        updatedAt: text(row.updated_at),
        deletedAt: text(row.step_deleted_at),
        archivedAt: null,
      },
      contexts: context ? [context] : [],
      consistent: Boolean(context),
    }];
  }));
};

async function commentContexts(db: D1Database, ids: readonly string[]) {
  const sampleRows = await allRows(db, `
    SELECT cs.id AS owner_id,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at
    FROM comment_submissions cs
    LEFT JOIN samples s ON s.id = cs.sample_id
    WHERE cs.id IN (SELECT value FROM json_each(?))
      AND cs.context_kind = 'sample'
    ORDER BY cs.id`, ids);
  const stepRows = await allRows(db, `
    SELECT cst.submission_id AS owner_id,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at,
           r.id AS run_id, r.template_name_snapshot AS run_template_name,
           r.template_version_snapshot AS run_template_version,
           r.deleted_at AS run_deleted_at,
           rs.id AS step_id, COALESCE(rs.title, sd.name) AS step_title,
           rs.deleted_at AS step_deleted_at
    FROM comment_submission_targets cst
    LEFT JOIN samples s ON s.id = cst.sample_id
    LEFT JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
    LEFT JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
    LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
    WHERE cst.submission_id IN (SELECT value FROM json_each(?))
    ORDER BY cst.submission_id, s.code, r.sequence_no, rs.position, cst.run_step_id`, ids);

  const contexts = new Map<string, ReferenceContext[]>();
  const inconsistent = new Set<string>();
  for (const row of sampleRows) {
    const ownerId = requiredText(row.owner_id);
    const sample = sampleSegment(row);
    if (!sample) inconsistent.add(ownerId);
    else contexts.set(ownerId, [{ segments: [sample] }]);
  }
  const stepResult = contextsByOwner(stepRows, "owner_id");
  for (const [ownerId, ownerContexts] of stepResult.contexts) contexts.set(ownerId, ownerContexts);
  for (const ownerId of stepResult.inconsistent) inconsistent.add(ownerId);
  return { contexts, inconsistent };
}

const commentAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT id, context_kind, scope, body, status, updated_at, deleted_at
    FROM comment_submissions
    WHERE id IN (SELECT value FROM json_each(?)) AND status = 'ready'
    ORDER BY id`, ids);
  const resolvedIds = rows.map((row) => requiredText(row.id));
  const contextResult = await commentContexts(db, resolvedIds);
  return new Map(rows.map((row) => {
    const id = requiredText(row.id);
    const contexts = contextResult.contexts.get(id) ?? [];
    return [id, {
      source: {
        title: excerpt(row.body, 80) ?? "Comment",
        subtitle: text(row.scope),
        excerpt: excerpt(row.body),
        kind: text(row.context_kind),
        state: text(row.status),
        updatedAt: text(row.updated_at),
        deletedAt: text(row.deleted_at),
        archivedAt: null,
      },
      contexts,
      consistent: contexts.length > 0 && !contextResult.inconsistent.has(id),
    }];
  }));
};

const commentOccurrenceAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT rsc.id, rsc.scope, COALESCE(cs.body, rsc.body) AS body,
           COALESCE(cs.status, 'legacy') AS comment_state,
           COALESCE(rsc.updated_at, rsc.created_at) AS updated_at,
           COALESCE(rsc.deleted_at, cs.deleted_at) AS deleted_at,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at,
           r.id AS run_id, r.template_name_snapshot AS run_template_name,
           r.template_version_snapshot AS run_template_version,
           r.deleted_at AS run_deleted_at,
           rs.id AS step_id, COALESCE(rs.title, sd.name) AS step_title,
           rs.deleted_at AS step_deleted_at
    FROM run_step_comments rsc
    LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id
    LEFT JOIN run_steps rs ON rs.id = rsc.run_step_id
    LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
    LEFT JOIN runs r ON r.id = rs.run_id
    LEFT JOIN samples s ON s.id = r.sample_id
    WHERE rsc.id IN (SELECT value FROM json_each(?))
    ORDER BY rsc.id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.id);
    const context = executionContext(row);
    return [id, {
      source: {
        title: excerpt(row.body, 80) ?? "Step Comment",
        subtitle: text(row.scope),
        excerpt: excerpt(row.body),
        kind: "comment_occurrence",
        state: text(row.comment_state),
        updatedAt: text(row.updated_at),
        deletedAt: text(row.deleted_at),
        archivedAt: null,
      },
      contexts: context ? [context] : [],
      consistent: Boolean(context),
    }];
  }));
};

async function attachmentContexts(db: D1Database, itemIds: readonly string[]) {
  const sampleRows = await allRows(db, `
    SELECT csi.id AS owner_id,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at
    FROM comment_submission_items csi
    JOIN comment_submissions cs ON cs.id = csi.submission_id
    LEFT JOIN samples s ON s.id = cs.sample_id
    WHERE csi.id IN (SELECT value FROM json_each(?))
      AND cs.context_kind = 'sample'
    ORDER BY csi.id`, itemIds);
  const stepRows = await allRows(db, `
    SELECT csi.id AS owner_id,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at,
           r.id AS run_id, r.template_name_snapshot AS run_template_name,
           r.template_version_snapshot AS run_template_version,
           r.deleted_at AS run_deleted_at,
           rs.id AS step_id, COALESCE(rs.title, sd.name) AS step_title,
           rs.deleted_at AS step_deleted_at
    FROM comment_submission_items csi
    JOIN comment_submissions cs ON cs.id = csi.submission_id
    JOIN comment_submission_targets cst ON cst.submission_id = cs.id
    LEFT JOIN samples s ON s.id = cst.sample_id
    LEFT JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
    LEFT JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
    LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
    WHERE csi.id IN (SELECT value FROM json_each(?))
      AND cs.context_kind = 'run_steps'
    ORDER BY csi.id, s.code, r.sequence_no, rs.position, cst.run_step_id`, itemIds);

  const contexts = new Map<string, ReferenceContext[]>();
  const inconsistent = new Set<string>();
  for (const row of sampleRows) {
    const ownerId = requiredText(row.owner_id);
    const sample = sampleSegment(row);
    if (!sample) inconsistent.add(ownerId);
    else contexts.set(ownerId, [{ segments: [sample] }]);
  }
  const stepResult = contextsByOwner(stepRows, "owner_id");
  for (const [ownerId, ownerContexts] of stepResult.contexts) contexts.set(ownerId, ownerContexts);
  for (const ownerId of stepResult.inconsistent) inconsistent.add(ownerId);
  return { contexts, inconsistent };
}

const commentAttachmentAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT csi.id, csi.kind, csi.status, csi.filename, csi.original_filename,
           csi.title, csi.description, csi.mime_type, csi.updated_at,
           COALESCE(csi.deleted_at, cs.deleted_at) AS deleted_at
    FROM comment_submission_items csi
    JOIN comment_submissions cs ON cs.id = csi.submission_id
    WHERE csi.id IN (SELECT value FROM json_each(?))
      AND csi.status = 'ready' AND cs.status = 'ready'
    ORDER BY csi.id`, ids);
  const resolvedIds = rows.map((row) => requiredText(row.id));
  const contextResult = await attachmentContexts(db, resolvedIds);
  return new Map(rows.map((row) => {
    const id = requiredText(row.id);
    const title = text(row.title) ?? text(row.filename) ?? text(row.original_filename) ?? requiredText(row.kind);
    const contexts = contextResult.contexts.get(id) ?? [];
    return [id, {
      source: {
        title,
        subtitle: text(row.filename) ?? text(row.original_filename),
        excerpt: excerpt(row.description),
        kind: text(row.kind),
        state: text(row.status),
        updatedAt: text(row.updated_at),
        deletedAt: text(row.deleted_at),
        archivedAt: null,
      },
      contexts,
      consistent: contexts.length > 0 && !contextResult.inconsistent.has(id),
    }];
  }));
};

const executionImageAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT rsa.id, rsa.created_at, rsa.deleted_at,
           a.original_name, a.mime_type,
           s.id AS sample_id, s.code AS sample_code, s.title AS sample_title,
           s.deleted_at AS sample_deleted_at,
           r.id AS run_id, r.template_name_snapshot AS run_template_name,
           r.template_version_snapshot AS run_template_version,
           r.deleted_at AS run_deleted_at,
           rs.id AS step_id, COALESCE(rs.title, sd.name) AS step_title,
           rs.deleted_at AS step_deleted_at
    FROM run_step_assets rsa
    LEFT JOIN assets a ON a.id = rsa.asset_id
    LEFT JOIN run_steps rs ON rs.id = rsa.run_step_id
    LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
    LEFT JOIN runs r ON r.id = rs.run_id
    LEFT JOIN samples s ON s.id = r.sample_id
    WHERE rsa.id IN (SELECT value FROM json_each(?))
      AND rsa.role = 'execution'
    ORDER BY rsa.id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.id);
    const context = executionContext(row);
    return [id, {
      source: {
        title: text(row.original_name) ?? "Execution image",
        subtitle: text(row.mime_type),
        excerpt: null,
        kind: "execution",
        state: "ready",
        updatedAt: text(row.created_at),
        deletedAt: text(row.deleted_at),
        archivedAt: null,
      },
      contexts: context ? [context] : [],
      consistent: Boolean(context && text(row.original_name)),
    }];
  }));
};

const metrologyReferenceAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT mtr.id, mtr.display_name, mtr.created_at, mtr.deleted_at,
           a.original_name, a.mime_type,
           tv.id AS recipe_id, tv.name AS recipe_name, tv.version AS recipe_version,
           tv.deleted_at AS recipe_deleted_at, tv.archived_at AS recipe_archived_at
    FROM metrology_template_references mtr
    LEFT JOIN assets a ON a.id = mtr.asset_id
    LEFT JOIN template_versions tv ON tv.id = mtr.template_version_id
    WHERE mtr.id IN (SELECT value FROM json_each(?))
    ORDER BY mtr.id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.id);
    const recipe = recipeSegment(row);
    return [id, {
      source: {
        title: requiredText(row.display_name) || text(row.original_name) || "Metrology reference",
        subtitle: text(row.original_name) ?? text(row.mime_type),
        excerpt: null,
        kind: "metrology_reference",
        state: "ready",
        updatedAt: text(row.created_at),
        deletedAt: text(row.deleted_at),
        archivedAt: null,
      },
      contexts: recipe ? [{ segments: [recipe] }] : [],
      consistent: Boolean(recipe && text(row.original_name)),
    }];
  }));
};

const recipeRevisionAdapter: ReferenceAdapter = async (db, ids) => {
  const rows = await allRows(db, `
    SELECT id AS recipe_id, name AS recipe_name, version AS recipe_version,
           template_kind, template_type, locked_at, archived_at AS recipe_archived_at,
           deleted_at AS recipe_deleted_at, created_at, source_filename
    FROM template_versions
    WHERE id IN (SELECT value FROM json_each(?))
    ORDER BY id`, ids);
  return new Map(rows.map((row) => {
    const id = requiredText(row.recipe_id);
    const recipe = recipeSegment(row)!;
    return [id, {
      source: {
        title: recipeLabel(row),
        subtitle: text(row.source_filename),
        excerpt: null,
        kind: text(row.template_kind) ?? text(row.template_type),
        state: text(row.locked_at) ? "locked" : "editable",
        updatedAt: text(row.created_at),
        deletedAt: text(row.recipe_deleted_at),
        archivedAt: text(row.recipe_archived_at),
      },
      contexts: [{ segments: [recipe] }],
      consistent: true,
    }];
  }));
};

export const REFERENCE_ADAPTERS = {
  sample: sampleAdapter,
  run: runAdapter,
  run_step: runStepAdapter,
  comment: commentAdapter,
  comment_occurrence: commentOccurrenceAdapter,
  comment_attachment: commentAttachmentAdapter,
  execution_image: executionImageAdapter,
  metrology_reference: metrologyReferenceAdapter,
  recipe_revision: recipeRevisionAdapter,
} as const satisfies Record<ReferenceTargetType, ReferenceAdapter>;

import type { ProjectListResponse, ProjectSnapshot } from "../../shared/project-api";
import { MAX_REFERENCE_RESOLUTION_TARGETS, type ReferenceResolution, type ReferenceTarget } from "../../shared/reference-types";
import { PROJECT_SCHEMA_VERSION } from "../../shared/project-types";
import { referenceTargetKey, resolveReferencesReadOnly } from "../references/read-resolver";
import { ProjectServiceError } from "./errors";
import type { ProjectReadDatabase } from "./read-sql";
import { projectReadProjectRow, projectReadContentRow, projectReadAttachmentRow, projectReadItemRow, projectReadPlacementRow, projectReadEdgeRow, projectReadRegistryRow } from "./read-decoding";
import { serializeProject, serializeProjectContent, serializeProjectAttachment, serializeProjectItem, serializeProjectPlacement, serializeProjectEdge } from "./serializers";

function notFound(message: string): never { throw new ProjectServiceError("not_found", message); }

export async function listProjects(
  db: ProjectReadDatabase,
  includeDeleted = false,
): Promise<ProjectListResponse> {
  const result = await db.prepare(`
    SELECT * FROM projects
    WHERE (? = 1 OR deleted_at IS NULL)
    ORDER BY (deleted_at IS NOT NULL), updated_at DESC, id
  `).bind(includeDeleted ? 1 : 0).all();
  return { projects: result.results.map(row => serializeProject(projectReadProjectRow(row))) };
}

export async function readProjectSnapshot(
  db: ProjectReadDatabase,
  projectId: string,
  includeDeleted = false,
): Promise<ProjectSnapshot> {
  const results = await db.readBatch([
    db.prepare(`
      SELECT * FROM projects
      WHERE id = ? AND (? = 1 OR deleted_at IS NULL)
      LIMIT 1
    `).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT pc.*
      FROM project_contents pc
      JOIN project_items pi ON pi.project_content_id = pc.id
      WHERE pc.project_id = ?
    AND (? = 1 OR (pc.deleted_at IS NULL AND pi.deleted_at IS NULL))
  ORDER BY pi.created_sequence, pc.id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT pca.*, pc.project_id
      FROM project_content_attachments pca
      JOIN project_contents pc ON pc.id = pca.project_content_id
      JOIN project_items pi ON pi.project_content_id = pc.id
      WHERE pc.project_id = ?
    AND (? = 1 OR (pc.deleted_at IS NULL AND pi.deleted_at IS NULL))
  ORDER BY pi.created_sequence, pca.project_content_id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT * FROM project_items
  WHERE project_id = ? AND (? = 1 OR deleted_at IS NULL)
  ORDER BY created_sequence, id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT pmp.*
      FROM project_map_placements pmp
      JOIN project_items pi ON pi.id = pmp.project_item_id
      WHERE pi.project_id = ? AND (? = 1 OR pi.deleted_at IS NULL)
  ORDER BY pi.created_sequence, pmp.id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT pe.*
      FROM project_edges pe
      JOIN project_items source ON source.id = pe.source_item_id
      JOIN project_items target ON target.id = pe.target_item_id
      WHERE pe.project_id = ?
    AND (? = 1 OR (
      pe.deleted_at IS NULL
      AND source.deleted_at IS NULL
      AND target.deleted_at IS NULL
    ))
  ORDER BY pe.created_at, pe.id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT DISTINCT rt.id, rt.target_type, rt.target_id
      FROM project_items pi
      JOIN reference_targets rt ON rt.id = pi.reference_target_id
      WHERE pi.project_id = ? AND (? = 1 OR pi.deleted_at IS NULL)
  ORDER BY rt.target_type, rt.target_id
`).bind(projectId, includeDeleted ? 1 : 0),
  ]);

  const project = results[0]?.results[0];
  if (!project) notFound("Project not found");
  const registryRows = (results[6]?.results ?? []).map(projectReadRegistryRow);
  const targets: ReferenceTarget[] = registryRows.map((row) => ({
    type: row.target_type,
    id: row.target_id,
  }));
  const resolutionsByTarget = new Map<string, ReferenceResolution>();
  // A Project, including accumulated Trash, can exceed one resolver batch.
  // Resolve sequentially to keep source queries bounded without changing the
  // public resolver limit or the snapshot's stable registry ordering.
  for (let offset = 0; offset < targets.length; offset += MAX_REFERENCE_RESOLUTION_TARGETS) {
    const resolutions = await resolveReferencesReadOnly(
      db,
      targets.slice(offset, offset + MAX_REFERENCE_RESOLUTION_TARGETS),
    );
    for (const resolution of resolutions) {
      resolutionsByTarget.set(referenceTargetKey(resolution.target), resolution);
    }
  }

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project: serializeProject(projectReadProjectRow(project)),
    contents: (results[1]?.results ?? []).map(row => serializeProjectContent(projectReadContentRow(row))),
    attachments: (results[2]?.results ?? []).map(row => serializeProjectAttachment(projectReadAttachmentRow(row))),
    items: (results[3]?.results ?? []).map(row => serializeProjectItem(projectReadItemRow(row))),
    placements: (results[4]?.results ?? []).map(row => serializeProjectPlacement(projectReadPlacementRow(row))),
    edges: (results[5]?.results ?? []).map(row => serializeProjectEdge(projectReadEdgeRow(row))),
    references: registryRows.map(row => {
      const resolution = resolutionsByTarget.get(referenceTargetKey({ type: row.target_type, id: row.target_id }));
      if (!resolution) throw new Error("Project reference resolution is unavailable");
      return { registryId: row.id, resolution };
    }),
  };
}

export interface ProjectReadDependencies {
  database(): ProjectReadDatabase;
  /** Request-bound current identity/read fence, supplied by its actual runtime. */
  admit(actor: string): Promise<void>;
}
export function createProjectReadService(dependencies: ProjectReadDependencies) {
  return {
    async list(includeDeleted: boolean, actor: string) {
      await dependencies.admit(actor);
      const result = await listProjects(dependencies.database(), includeDeleted);
      await dependencies.admit(actor); return result;
    },
    async snapshot(projectId: string, includeDeleted: boolean, actor: string) {
      await dependencies.admit(actor);
      const result = await readProjectSnapshot(dependencies.database(), projectId, includeDeleted);
      await dependencies.admit(actor); return result;
    },
  };
}
export type ProjectReadService = ReturnType<typeof createProjectReadService>;

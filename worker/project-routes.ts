import { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  isCreateAttachmentProjectItemInput,
  isCreateMarkdownProjectItemInput,
  isCreateProjectEdgeInput,
  isCreateProjectInput,
  isCreateReferenceProjectItemInput,
  isProjectApiId,
  isProjectEdgeLifecycleInput,
  isProjectItemLifecycleInput,
  isProjectLifecycleInput,
  isRenameProjectInput,
  isUpdateProjectAttachmentInput,
  isUpdateProjectEdgeInput,
  isUpdateProjectMarkdownInput,
  isUpdateProjectPlacementInput,
} from "../shared/project-api";
import { isCopyAttachmentProjectItemInput } from "../shared/project-copy-paste-api";
import { getBlob } from "./blob-lifecycle/storage";
import { safeMediaResponseHeaders } from "./media-response";
import { routes as projectFoundationRoutes } from "./project-foundation-routes";
import { copyAttachmentProjectItem } from "./projects/attachment-copy";
import {
  createAttachmentProjectItem,
  createMarkdownProjectItem,
  createProject,
  createProjectEdge,
  createReferenceProjectItem,
  deleteProject,
  deleteProjectEdge,
  listProjects,
  ProjectServiceError,
  readProjectAttachmentMediaSource,
  readProjectSnapshot,
  removeProjectItem,
  renameProject,
  restoreProject,
  restoreProjectEdge,
  restoreProjectItem,
  updateProjectAttachment,
  updateProjectEdge,
  updateProjectMarkdown,
  updateProjectPlacement,
} from "./projects/service";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };
type AppContext = Context<AppBindings>;
type InputGuard<T> = (value: unknown) => value is T;
type SettlementProof = () => Promise<boolean>;

class ProjectMutationHttpException extends HTTPException {
  constructor(
    status: 404 | 409,
    message: string,
    readonly authoritativeRejection = false,
  ) {
    super(status, { message });
  }
}

const MONOTONIC_PROJECT_CONFLICT_MESSAGES = new Set([
  "Project revision conflict",
  "Content revision conflict",
  "Placement revision conflict",
  "Item revision conflict",
  "Edge revision conflict",
  "Item or content revision conflict",
  "Project revision or identity conflict",
  "A Project identity or operation ID was already used for different content",
  "A Project identity or operation ID was already used for a different reference",
  "A Project identity or operation ID was already used for a different attachment",
  "The edge ID or operation ID is already in use",
]);

export const routes = new Hono<AppBindings>();

routes.onError((error, c) => {
  if (error instanceof ProjectMutationHttpException && error.authoritativeRejection) {
    c.header("x-project-mutation-disposition", "authoritative-rejection");
  }
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  throw error;
});

// Project owns complete export and persistence under one aggregate. The core
// Worker mounts this aggregate directly beside Comment and Reference routes.
routes.route("/", projectFoundationRoutes);

function requireRouteId(value: string, label: string) {
  if (!isProjectApiId(value)) {
    throw new HTTPException(400, { message: `A valid ${label} ID is required` });
  }
  return value;
}

async function requireJson<T>(
  c: AppContext,
  guard: InputGuard<T>,
  message: string,
): Promise<T> {
  let input: unknown;
  try {
    input = await c.req.json<unknown>();
  } catch {
    throw new HTTPException(400, { message: "A valid JSON request body is required" });
  }
  if (!guard(input)) throw new HTTPException(400, { message });
  return input;
}

function isDatabaseConflict(error: unknown) {
  return /(SQLITE_CONSTRAINT|constraint failed|UNIQUE constraint|FOREIGN KEY constraint|project item deletion requires|project item restore requires|project edge endpoints|reference target is unavailable|blob locator is unavailable|blob locator is quarantined)/i
    .test(String(error));
}

function serviceConflictHasMonotonicProof(error: ProjectServiceError) {
  return error.code === "conflict" && MONOTONIC_PROJECT_CONFLICT_MESSAGES.has(error.message);
}

function projectRevisionSettlementProof(
  db: D1Database,
  projectId: string,
  expectedRevision: number,
): SettlementProof {
  return async () => {
    const row = await db.prepare(`
      SELECT revision FROM projects WHERE id = ? LIMIT 1
    `).bind(projectId).first<{ revision: number }>();
    return Boolean(row && Number(row.revision) !== expectedRevision);
  };
}

function edgeEndpointRevisionSettlementProof(
  db: D1Database,
  projectId: string,
  input: {
    sourceItemId: string;
    targetItemId: string;
    expectedSourceItemRevision: number;
    expectedTargetItemRevision: number;
  },
): SettlementProof {
  return async () => {
    const result = await db.prepare(`
      SELECT id, revision
      FROM project_items
      WHERE project_id = ? AND id IN (?, ?)
    `).bind(projectId, input.sourceItemId, input.targetItemId).all<{
      id: string;
      revision: number;
    }>();
    const revisions = new Map(result.results.map((row) => [row.id, Number(row.revision)]));
    const sourceRevision = revisions.get(input.sourceItemId);
    const targetRevision = revisions.get(input.targetItemId);
    return (sourceRevision !== undefined && sourceRevision !== input.expectedSourceItemRevision)
      || (targetRevision !== undefined && targetRevision !== input.expectedTargetItemRevision);
  };
}

async function projectCall<T>(
  operation: () => Promise<T>,
  settlementProof?: SettlementProof,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProjectServiceError) {
      if (error.code === "not_found") {
        throw new ProjectMutationHttpException(404, error.message);
      }
      let authoritativeRejection = serviceConflictHasMonotonicProof(error);
      if (!authoritativeRejection && settlementProof) {
        try {
          authoritativeRejection = await settlementProof();
        } catch {
          // Settlement metadata is safety-only. Failure to prove monotonic rejection
          // must leave the caller uncertain rather than weakening the mutation result.
          authoritativeRejection = false;
        }
      }
      throw new ProjectMutationHttpException(409, error.message, authoritativeRejection);
    }
    if (isDatabaseConflict(error)) {
      throw new ProjectMutationHttpException(
        409,
        "Project state changed before the operation could commit",
      );
    }
    throw error;
  }
}

routes.get("/projects", async (c) => {
  const includeDeleted = c.req.query("includeDeleted") === "1";
  return c.json(await projectCall(() => listProjects(c.env.DB, includeDeleted)));
});

routes.post("/projects", async (c) => {
  const input = await requireJson(c, isCreateProjectInput, "Invalid Project creation request");
  const result = await projectCall(() => createProject(
    c.env.DB,
    input,
    c.get("userEmail"),
  ));
  return c.json(result, result.replayed ? 200 : 201);
});

routes.get("/projects/:projectId", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const includeDeleted = c.req.query("includeDeleted") === "1";
  return c.json(await projectCall(() => readProjectSnapshot(
    c.env.DB,
    projectId,
    includeDeleted,
  )));
});

routes.patch("/projects/:projectId", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const input = await requireJson(c, isRenameProjectInput, "Invalid Project update request");
  return c.json(await projectCall(() => renameProject(
    c.env.DB,
    projectId,
    input,
    c.get("userEmail"),
  )));
});

routes.delete("/projects/:projectId", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const input = await requireJson(c, isProjectLifecycleInput, "Invalid Project deletion request");
  return c.json(await projectCall(() => deleteProject(
    c.env.DB,
    projectId,
    input,
    c.get("userEmail"),
  )));
});

routes.post("/projects/:projectId/restore", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const input = await requireJson(c, isProjectLifecycleInput, "Invalid Project restore request");
  return c.json(await projectCall(() => restoreProject(
    c.env.DB,
    projectId,
    input,
    c.get("userEmail"),
  )));
});

routes.post("/projects/:projectId/items/markdown", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const input = await requireJson(
    c,
    isCreateMarkdownProjectItemInput,
    "Invalid Project Markdown creation request",
  );
  const result = await projectCall(() => createMarkdownProjectItem(
    c.env.DB,
    projectId,
    input,
    c.get("userEmail"),
  ), projectRevisionSettlementProof(c.env.DB, projectId, input.expectedProjectRevision));
  return c.json(result, result.replayed ? 200 : 201);
});

routes.post("/projects/:projectId/items/reference", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const input = await requireJson(
    c,
    isCreateReferenceProjectItemInput,
    "Invalid Project reference insertion request",
  );
  const result = await projectCall(() => createReferenceProjectItem(
    c.env.DB,
    projectId,
    input,
    c.get("userEmail"),
  ), projectRevisionSettlementProof(c.env.DB, projectId, input.expectedProjectRevision));
  return c.json(result, result.replayed ? 200 : 201);
});

routes.post("/projects/:projectId/items/attachment/copy", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const input = await requireJson(
    c,
    isCopyAttachmentProjectItemInput,
    "Invalid Project attachment copy request",
  );
  const result = await projectCall(() => copyAttachmentProjectItem(
    c.env.DB,
    projectId,
    input,
    c.get("userEmail"),
  ), projectRevisionSettlementProof(c.env.DB, projectId, input.expectedProjectRevision));
  return c.json(result, result.replayed ? 200 : 201);
});

routes.post("/projects/:projectId/items/attachment", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const input = await requireJson(
    c,
    isCreateAttachmentProjectItemInput,
    "Invalid Project attachment creation request",
  );
  const result = await projectCall(() => createAttachmentProjectItem(
    c.env.DB,
    projectId,
    input,
    c.get("userEmail"),
  ), projectRevisionSettlementProof(c.env.DB, projectId, input.expectedProjectRevision));
  return c.json(result, result.replayed ? 200 : 201);
});

routes.delete("/projects/:projectId/items/:itemId", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const itemId = requireRouteId(c.req.param("itemId"), "Project item");
  const input = await requireJson(c, isProjectItemLifecycleInput, "Invalid Project item deletion request");
  return c.json(await projectCall(() => removeProjectItem(
    c.env.DB,
    projectId,
    itemId,
    input,
    c.get("userEmail"),
  )));
});

routes.post("/projects/:projectId/items/:itemId/restore", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const itemId = requireRouteId(c.req.param("itemId"), "Project item");
  const input = await requireJson(c, isProjectItemLifecycleInput, "Invalid Project item restore request");
  return c.json(await projectCall(() => restoreProjectItem(
    c.env.DB,
    projectId,
    itemId,
    input,
    c.get("userEmail"),
  )));
});

routes.patch("/projects/:projectId/contents/:contentId/markdown", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const contentId = requireRouteId(c.req.param("contentId"), "Project content");
  const input = await requireJson(c, isUpdateProjectMarkdownInput, "Invalid Project Markdown update request");
  return c.json(await projectCall(() => updateProjectMarkdown(
    c.env.DB,
    projectId,
    contentId,
    input,
    c.get("userEmail"),
  )));
});

routes.patch("/projects/:projectId/contents/:contentId/attachment", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const contentId = requireRouteId(c.req.param("contentId"), "Project content");
  const input = await requireJson(
    c,
    isUpdateProjectAttachmentInput,
    "Invalid Project attachment update request",
  );
  return c.json(await projectCall(() => updateProjectAttachment(
    c.env.DB,
    projectId,
    contentId,
    input,
    c.get("userEmail"),
  )));
});

routes.get("/projects/:projectId/contents/:contentId/file", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const contentId = requireRouteId(c.req.param("contentId"), "Project content");
  const visibleOccurrence = await c.env.DB.prepare(`
    SELECT 1 AS visible
    FROM project_items pi
    JOIN project_contents pc ON pc.id = pi.project_content_id
    JOIN projects p ON p.id = pi.project_id
    WHERE pi.project_id = ? AND pc.id = ?
      AND pi.deleted_at IS NULL AND pc.deleted_at IS NULL AND p.deleted_at IS NULL
    LIMIT 1
  `).bind(projectId, contentId).first<{ visible: number }>();
  if (!visibleOccurrence) {
    throw new HTTPException(404, { message: "Project attachment not found" });
  }
  const source = await projectCall(() => readProjectAttachmentMediaSource(
    c.env.DB,
    projectId,
    contentId,
  ));
  const blob = await getBlob(c.env, source.locator);
  if (blob.outcome === "missing") {
    throw new HTTPException(404, { message: "Project attachment bytes are unavailable" });
  }
  if (blob.outcome === "provider_unavailable") {
    throw new HTTPException(503, { message: blob.message });
  }
  const headers = safeMediaResponseHeaders({
    mimeType: source.mimeType || blob.contentType,
    filename: source.originalName,
    cacheControl: "private, no-store",
    etag: blob.etag,
  });
  return new Response(blob.body, { headers });
});

routes.patch("/projects/:projectId/placements/:placementId", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const placementId = requireRouteId(c.req.param("placementId"), "Project placement");
  const input = await requireJson(c, isUpdateProjectPlacementInput, "Invalid Project placement update request");
  return c.json(await projectCall(() => updateProjectPlacement(
    c.env.DB,
    projectId,
    placementId,
    input,
    c.get("userEmail"),
  )));
});

routes.post("/projects/:projectId/edges", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const input = await requireJson(c, isCreateProjectEdgeInput, "Invalid Project edge creation request");
  const result = await projectCall(() => createProjectEdge(
    c.env.DB,
    projectId,
    input,
    c.get("userEmail"),
  ), edgeEndpointRevisionSettlementProof(c.env.DB, projectId, input));
  return c.json(result, result.replayed ? 200 : 201);
});

routes.patch("/projects/:projectId/edges/:edgeId", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const edgeId = requireRouteId(c.req.param("edgeId"), "Project edge");
  const input = await requireJson(c, isUpdateProjectEdgeInput, "Invalid Project edge update request");
  return c.json(await projectCall(() => updateProjectEdge(
    c.env.DB,
    projectId,
    edgeId,
    input,
    c.get("userEmail"),
  )));
});

routes.delete("/projects/:projectId/edges/:edgeId", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const edgeId = requireRouteId(c.req.param("edgeId"), "Project edge");
  const input = await requireJson(c, isProjectEdgeLifecycleInput, "Invalid Project edge deletion request");
  return c.json(await projectCall(() => deleteProjectEdge(
    c.env.DB,
    projectId,
    edgeId,
    input,
    c.get("userEmail"),
  )));
});

routes.post("/projects/:projectId/edges/:edgeId/restore", async (c) => {
  const projectId = requireRouteId(c.req.param("projectId"), "Project");
  const edgeId = requireRouteId(c.req.param("edgeId"), "Project edge");
  const input = await requireJson(c, isProjectEdgeLifecycleInput, "Invalid Project edge restore request");
  return c.json(await projectCall(() => restoreProjectEdge(
    c.env.DB,
    projectId,
    edgeId,
    input,
    c.get("userEmail"),
  )));
});
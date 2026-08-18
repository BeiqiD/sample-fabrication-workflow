import type {
  CreateAttachmentProjectItemInput,
  CreateMarkdownProjectItemInput,
  CreateProjectEdgeInput,
  CreateProjectInput,
  CreateReferenceProjectItemInput,
  ProjectContentRecord,
  ProjectEdgeLifecycleInput,
  ProjectEdgeRecord,
  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
  ProjectLifecycleInput,
  ProjectListResponse,
  ProjectMutationResponse,
  ProjectPlacementRecord,
  ProjectRowMutationResponse,
  ProjectSnapshot,
  UpdateProjectAttachmentInput,
  UpdateProjectEdgeInput,
  UpdateProjectMarkdownInput,
  UpdateProjectPlacementInput,
} from "../../shared/project-api";
import type { CopyAttachmentProjectItemInput } from "../../shared/project-copy-paste-api";

export type ProjectMutationDisposition = "authoritative-rejection";

export class ProjectApiError extends Error {
  readonly status: number;
  readonly mutationDisposition: ProjectMutationDisposition | null;

  constructor(
    message: string,
    status: number,
    mutationDisposition: ProjectMutationDisposition | null = null,
  ) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
    this.mutationDisposition = mutationDisposition;
  }
}

async function projectRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
    };
    const mutationDisposition = response.headers.get("x-project-mutation-disposition")
      === "authoritative-rejection"
      ? "authoritative-rejection"
      : null;
    throw new ProjectApiError(
      payload.error || `Project request failed (${response.status})`,
      response.status,
      mutationDisposition,
    );
  }
  return response.json() as Promise<T>;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function createProjectApiId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export const projectApi = {
  list: (signal?: AbortSignal) => projectRequest<ProjectListResponse>(
    "/projects",
    signal ? { signal } : undefined,
  ),
  create: (input: CreateProjectInput) => projectRequest<ProjectMutationResponse>(
    "/projects",
    jsonRequest("POST", input),
  ),
  read: (projectId: string, signal?: AbortSignal) => projectRequest<ProjectSnapshot>(
    `/projects/${encodeURIComponent(projectId)}`,
    signal ? { signal } : undefined,
  ),
  deleteProject: (
    projectId: string,
    input: ProjectLifecycleInput,
  ) => projectRequest<ProjectMutationResponse>(
    `/projects/${encodeURIComponent(projectId)}`,
    jsonRequest("DELETE", input),
  ),
  createMarkdownItem: (
    projectId: string,
    input: CreateMarkdownProjectItemInput,
  ) => projectRequest<ProjectItemMutationResponse>(
    `/projects/${encodeURIComponent(projectId)}/items/markdown`,
    jsonRequest("POST", input),
  ),
  createAttachmentItem: (
    projectId: string,
    input: CreateAttachmentProjectItemInput,
  ) => projectRequest<ProjectItemMutationResponse>(
    `/projects/${encodeURIComponent(projectId)}/items/attachment`,
    jsonRequest("POST", input),
  ),
  copyAttachmentItem: (
    projectId: string,
    input: CopyAttachmentProjectItemInput,
  ) => projectRequest<ProjectItemMutationResponse>(
    `/projects/${encodeURIComponent(projectId)}/items/attachment/copy`,
    jsonRequest("POST", input),
  ),
  uploadAttachmentAsset: (file: File) => projectRequest<{ id: string; key: string; deduplicated: boolean }>(
    "/project-assets",
    {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-project-filename-uri": encodeURIComponent(file.name),
      },
      body: file,
    },
  ),
  createReferenceItem: (
    projectId: string,
    input: CreateReferenceProjectItemInput,
  ) => projectRequest<ProjectItemMutationResponse>(
    `/projects/${encodeURIComponent(projectId)}/items/reference`,
    jsonRequest("POST", input),
  ),
  removeItem: (
    projectId: string,
    itemId: string,
    input: ProjectItemLifecycleInput,
  ) => projectRequest<ProjectItemMutationResponse>(
    `/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
    jsonRequest("DELETE", input),
  ),
  updateMarkdown: (
    projectId: string,
    contentId: string,
    input: UpdateProjectMarkdownInput,
  ) => projectRequest<ProjectRowMutationResponse<ProjectContentRecord>>(
    `/projects/${encodeURIComponent(projectId)}/contents/${encodeURIComponent(contentId)}/markdown`,
    jsonRequest("PATCH", input),
  ),
  updateAttachment: (
    projectId: string,
    contentId: string,
    input: UpdateProjectAttachmentInput,
  ) => projectRequest<ProjectRowMutationResponse<ProjectContentRecord>>(
    `/projects/${encodeURIComponent(projectId)}/contents/${encodeURIComponent(contentId)}/attachment`,
    jsonRequest("PATCH", input),
  ),
  updatePlacement: (
    projectId: string,
    placementId: string,
    input: UpdateProjectPlacementInput,
  ) => projectRequest<ProjectRowMutationResponse<ProjectPlacementRecord>>(
    `/projects/${encodeURIComponent(projectId)}/placements/${encodeURIComponent(placementId)}`,
    jsonRequest("PATCH", input),
  ),
  createEdge: (
    projectId: string,
    input: CreateProjectEdgeInput,
  ) => projectRequest<ProjectRowMutationResponse<ProjectEdgeRecord>>(
    `/projects/${encodeURIComponent(projectId)}/edges`,
    jsonRequest("POST", input),
  ),
  updateEdge: (
    projectId: string,
    edgeId: string,
    input: UpdateProjectEdgeInput,
  ) => projectRequest<ProjectRowMutationResponse<ProjectEdgeRecord>>(
    `/projects/${encodeURIComponent(projectId)}/edges/${encodeURIComponent(edgeId)}`,
    jsonRequest("PATCH", input),
  ),
  deleteEdge: (
    projectId: string,
    edgeId: string,
    input: ProjectEdgeLifecycleInput,
  ) => projectRequest<ProjectRowMutationResponse<ProjectEdgeRecord>>(
    `/projects/${encodeURIComponent(projectId)}/edges/${encodeURIComponent(edgeId)}`,
    jsonRequest("DELETE", input),
  ),
  restoreEdge: (
    projectId: string,
    edgeId: string,
    input: ProjectEdgeLifecycleInput,
  ) => projectRequest<ProjectRowMutationResponse<ProjectEdgeRecord>>(
    `/projects/${encodeURIComponent(projectId)}/edges/${encodeURIComponent(edgeId)}/restore`,
    jsonRequest("POST", input),
  ),
};

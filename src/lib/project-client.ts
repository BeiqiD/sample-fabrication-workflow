import type {
  CreateAttachmentProjectItemInput,
  CreateMarkdownProjectItemInput,
  CreateProjectInput,
  CreateReferenceProjectItemInput,
  ProjectAttachmentIntrinsicMetadataInput,
  ProjectContentRecord,
  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
  ProjectListResponse,
  ProjectMutationResponse,
  ProjectPlacementRecord,
  ProjectRowMutationResponse,
  ProjectSnapshot,
  UpdateProjectAttachmentInput,
  UpdateProjectMarkdownInput,
  UpdateProjectPlacementInput,
} from "../../shared/project-api";

export class ProjectApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
  }
}

async function projectRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
    };
    throw new ProjectApiError(
      payload.error || `Project request failed (${response.status})`,
      response.status,
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

const attachmentMetadataByAssetId = new Map<string, ProjectAttachmentIntrinsicMetadataInput>();

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
  createMarkdownItem: (
    projectId: string,
    input: CreateMarkdownProjectItemInput,
  ) => projectRequest<ProjectItemMutationResponse>(
    `/projects/${encodeURIComponent(projectId)}/items/markdown`,
    jsonRequest("POST", input),
  ),
  createAttachmentItem: async (
    projectId: string,
    input: CreateAttachmentProjectItemInput,
  ) => {
    const intrinsicMetadata = "assetId" in input.locator
      ? attachmentMetadataByAssetId.get(input.locator.assetId)
      : undefined;
    const requestInput = intrinsicMetadata ? { ...input, intrinsicMetadata } : input;
    const result = await projectRequest<ProjectItemMutationResponse>(
      `/projects/${encodeURIComponent(projectId)}/items/attachment`,
      jsonRequest("POST", requestInput),
    );
    if ("assetId" in input.locator) attachmentMetadataByAssetId.delete(input.locator.assetId);
    return result;
  },
  uploadAttachmentAsset: async (file: File) => {
    const result = await projectRequest<{ id: string; key: string; deduplicated: boolean }>(
      "/project-assets",
      {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-project-filename-uri": encodeURIComponent(file.name),
        },
        body: file,
      },
    );
    attachmentMetadataByAssetId.set(result.id, {
      originalName: file.name,
      mimeType: file.type || "application/octet-stream",
      byteSize: file.size,
    });
    return result;
  },
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
};
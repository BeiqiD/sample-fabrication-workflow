import type {
  CreateProjectInput,
  CreateReferenceProjectItemInput,
  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
  ProjectListResponse,
  ProjectMutationResponse,
  ProjectRowMutationResponse,
  ProjectSnapshot,
  ProjectPlacementRecord,
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
  updatePlacement: (
    projectId: string,
    placementId: string,
    input: UpdateProjectPlacementInput,
  ) => projectRequest<ProjectRowMutationResponse<ProjectPlacementRecord>>(
    `/projects/${encodeURIComponent(projectId)}/placements/${encodeURIComponent(placementId)}`,
    jsonRequest("PATCH", input),
  ),
};

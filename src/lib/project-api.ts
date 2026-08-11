import type {
  CreateProjectInput,
  ProjectListResponse,
  ProjectMutationResponse,
  ProjectPlacementRecord,
  ProjectRowMutationResponse,
  ProjectSnapshot,
  UpdateProjectPlacementInput,
} from "../../shared/project-api";

export class ProjectApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
  }
}

async function projectRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new ProjectApiError(
      response.status,
      payload?.error || payload?.message || `Project request failed (${response.status})`,
    );
  }
  return response.json() as Promise<T>;
}

function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
}

export const projectApi = {
  listProjects: (signal?: AbortSignal) =>
    projectRequest<ProjectListResponse>("/projects", signal ? { signal } : undefined),

  getProject: (projectId: string, signal?: AbortSignal) =>
    projectRequest<ProjectSnapshot>(
      `/projects/${encodeURIComponent(projectId)}`,
      signal ? { signal } : undefined,
    ),

  createProject: (input: CreateProjectInput, signal?: AbortSignal) =>
    projectRequest<ProjectMutationResponse>("/projects", jsonInit("POST", input, signal)),

  updatePlacement: (
    projectId: string,
    placementId: string,
    input: UpdateProjectPlacementInput,
    signal?: AbortSignal,
  ) => projectRequest<ProjectRowMutationResponse<ProjectPlacementRecord>>(
    `/projects/${encodeURIComponent(projectId)}/placements/${encodeURIComponent(placementId)}`,
    jsonInit("PATCH", input, signal),
  ),
};

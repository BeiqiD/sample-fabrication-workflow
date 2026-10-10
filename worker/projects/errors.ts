export type ProjectServiceErrorCode =
  | "not_found"
  | "conflict"
  | "reference_unavailable"
  | "blob_unavailable";

export class ProjectServiceError extends Error {
  constructor(
    readonly code: ProjectServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectServiceError";
  }
}

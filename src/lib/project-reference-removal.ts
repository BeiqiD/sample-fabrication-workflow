import { ProjectApiError } from "./project-client";

export function projectReferenceRemovalNeedsReconciliation(caught: unknown) {
  return caught instanceof ProjectApiError
    && caught.status >= 400
    && caught.status < 500
    && caught.status !== 408
    && caught.status !== 429;
}

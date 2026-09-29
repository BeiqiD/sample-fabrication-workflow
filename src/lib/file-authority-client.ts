export interface FileAuthorityStatus {
  mode: "legacy" | "overlap" | "active";
  updated_at: string;
  activated_at: string | null;
  epoch: number;
  incarnation: string | null;
  enabled: 0 | 1;
  enabled_by: string | null;
  runtime_updated_at: string;
  shadow_enabled: 0 | 1;
  shadow_incarnation: string | null;
  current_count: number;
  resolved_count: number;
  unfinished_attempts: number;
  pending_receipts: number;
  unfinished_failed_imports: number;
  unattached_ready_uploads: number;
  unpublished_candidates: number;
  legacy_deleting: number;
  file_deleting: number;
}

export interface ActivateFileAuthorityInput {
  requestId: string;
  expectedEpoch: number;
  expectedShadowIncarnation: string | null;
}
export interface EnableRecoveredFileAuthorityInput {
  requestId: string;
  expectedIncarnation: string | null;
  previousInstallationStopped: true;
}

export class FileAuthorityAccessError extends Error {}

async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(`/api/files/${path}`, {
    method: input === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", redirect: "error",
    ...(input === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
  });
  if (response.status === 401 || response.status === 403) throw new FileAuthorityAccessError("File operator access is required.");
  if (!response.ok) throw new Error("File authority is unavailable or has changed.");
  return response.json() as Promise<T>;
}

export const fileAuthorityClient = {
  capabilities: () => request<{ canAdjudicate: boolean }>("shadow/evidence/capabilities"),
  status: () => request<FileAuthorityStatus>("authority/status"),
  activate: (input: ActivateFileAuthorityInput) => request<FileAuthorityStatus>("authority/activate", input),
  enableRecovered: (input: EnableRecoveredFileAuthorityInput) => request<FileAuthorityStatus>("authority/enable-recovered", input),
};

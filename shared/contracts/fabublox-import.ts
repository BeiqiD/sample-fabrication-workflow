export const FABUBLOX_IMPORT_REQUEST_HEADER = "X-Import-Request-Id";
export const MAX_FABUBLOX_REQUEST_INPUT_BYTES = 128 * 1024;

export interface FabubloxImportResult {
  id: string;
  templateVersionId: string;
  version: number;
}

export type FabubloxImportRequestState =
  | { requestId: string; importId: string; status: "pending"; leaseExpiresAt: string | null }
  | { requestId: string; importId: string; status: "failed" }
  | { requestId: string; importId: string; status: "ready"; result: FabubloxImportResult };

export function normalizeFabubloxImportRequestId(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

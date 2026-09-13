import {
  FABUBLOX_IMPORT_REQUEST_HEADER,
  normalizeFabubloxImportRequestId,
  type FabubloxImportRequestState,
  type FabubloxImportResult,
} from "../../shared/contracts/fabublox-import";
import type { FabubloxImportPreview } from "../../shared/types";
import { compressLayerStackImage } from "./images";

export interface PreparedFabubloxImport {
  readonly requestId: string;
  readonly title: string;
  readonly form: FormData;
}

export interface SavedFabubloxImport {
  requestId: string;
  title: string;
}

export const FABUBLOX_IMPORT_SESSION_KEY = "fabublox-import-request-v1";

export class FabubloxImportRequestError extends Error {
  constructor(message: string, readonly request?: FabubloxImportRequestState) {
    super(message);
    this.name = "FabubloxImportRequestError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function importResult(value: unknown): value is FabubloxImportResult {
  return record(value) && identifier(value.id) && identifier(value.templateVersionId)
    && Number.isSafeInteger(value.version) && (value.version as number) > 0;
}

function requestState(value: unknown, requestId: string): value is FabubloxImportRequestState {
  if (!record(value) || value.requestId !== requestId || !identifier(value.importId)) return false;
  if (value.status === "ready") return importResult(value.result);
  if (value.status === "failed") return true;
  return value.status === "pending" && (value.leaseExpiresAt === null || typeof value.leaseExpiresAt === "string");
}

export async function prepareFabubloxImport(
  file: File,
  preview: FabubloxImportPreview,
  recipeFamilyId?: string,
  existingRequestId?: string,
): Promise<PreparedFabubloxImport> {
  // This body and request identity belong to one attempt, including every retry.
  const requestId = existingRequestId === undefined ? crypto.randomUUID() : normalizeFabubloxImportRequestId(existingRequestId);
  if (!requestId) throw new Error("The saved import request identity is invalid.");
  const form = new FormData();
  form.append("workbook", file, file.name);
  const manifest = { ...preview, images: preview.images.map(({ data: _data, ...image }) => image), recipeFamilyId: recipeFamilyId || null };
  form.append("manifest", new Blob([JSON.stringify(manifest)], { type: "application/json" }), "manifest.json");
  for (const image of preview.images) {
    const sourceName = image.sourcePart.split("/").pop() || `${image.localId}.png`;
    const source = new File([new Uint8Array(image.data)], sourceName, { type: image.mimeType });
    const compressed = await compressLayerStackImage(source);
    form.append(`image:${image.localId}`, compressed, compressed.name);
  }
  return { requestId, title: preview.title.trim(), form };
}

export async function submitFabubloxImport(prepared: PreparedFabubloxImport): Promise<FabubloxImportResult> {
  const response = await fetch("/api/imports/fabublox", {
    method: "POST",
    headers: { [FABUBLOX_IMPORT_REQUEST_HEADER]: prepared.requestId },
    body: prepared.form,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok && importResult(payload)) return payload;
  const state = record(payload) && requestState(payload.request, prepared.requestId) ? payload.request : undefined;
  const message = record(payload) && typeof payload.error === "string" ? payload.error
    : response.ok ? "The import response could not be read. Check its status before retrying."
      : `Import request failed (${response.status}). Check its status before retrying.`;
  throw new FabubloxImportRequestError(message, state);
}

export async function getFabubloxImportRequest(requestId: string, signal?: AbortSignal): Promise<FabubloxImportRequestState | null> {
  const response = await fetch(`/api/imports/fabublox/requests/${encodeURIComponent(requestId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
  if (response.status === 404) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok && requestState(payload, requestId)) return payload;
  throw new Error(record(payload) && typeof payload.error === "string" ? payload.error : "The import status could not be checked. Try checking again.");
}

export function loadSavedFabubloxImport(): SavedFabubloxImport | null {
  try {
    const stored = sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY);
    if (!stored || stored.length > 2048) return null;
    const value: unknown = JSON.parse(stored);
    if (!record(value) || typeof value.requestId !== "string" || normalizeFabubloxImportRequestId(value.requestId) !== value.requestId
      || typeof value.title !== "string" || value.title.length > 256) return null;
    return { requestId: value.requestId, title: value.title };
  } catch { return null; }
}

export function saveFabubloxImport(prepared: Pick<PreparedFabubloxImport, "requestId" | "title">): void {
  try {
    const value = JSON.stringify({ requestId: prepared.requestId, title: prepared.title.slice(0, 256) });
    sessionStorage.setItem(FABUBLOX_IMPORT_SESSION_KEY, value);
    if (sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY) !== value) throw new Error("Checkpoint unavailable");
  } catch {
    throw new Error("This browser could not save the import request for recovery. Enable session storage before importing.");
  }
}

export function clearSavedFabubloxImport(): void {
  sessionStorage.removeItem(FABUBLOX_IMPORT_SESSION_KEY);
}

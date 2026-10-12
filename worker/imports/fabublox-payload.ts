import { HTTPException } from "hono/http-exception";
import type { InitialSubstrateStep } from "../../shared/types";
import { stableJson, sha256Hex } from "../../shared/content-addressing.ts";
import { MAX_FABUBLOX_REQUEST_INPUT_BYTES } from "../../shared/contracts/fabublox-import.ts";
import type { FabubloxImportInput } from "../../shared/contracts/fabublox-import-input";
import { normalizedSubstrateStepName } from "../process-definition/substrate.ts";

export const MAX_FABUBLOX_IMPORT_STEPS = 180;
export const MAX_FABUBLOX_IMPORT_IMAGES = MAX_FABUBLOX_IMPORT_STEPS;
export const MAX_FABUBLOX_IMPORT_BODY_BYTES = 50 * 1024 * 1024;

// Exact original shared upload digest wrapper, without its unrelated R2 imports.
async function digestSha256(buffer: ArrayBuffer) {
  return sha256Hex(buffer);
}

/** Promise observation only. No bytes, actor, grant, receipt, profile or SQL
 * enters through this interface, and a returned value is never consulted. */
export interface FabubloxPayloadPromiseObserver {
  retain(original: Promise<unknown>): void;
}

/** Complete original server manifest/accepted-file fingerprint algorithm.
 * It validates actual uploaded bytes against the supplied manifest. It does
 * not parse OOXML, prove derivation, or grant a Template/File capability.
 * Worker omits the observer and keeps its original Request.formData boundary. */
export async function prepareFabubloxPayloadFromForm(form: FormData, observer?: FabubloxPayloadPromiseObserver) {
  function observe<T>(original: Promise<T>): Promise<T> {
    observer?.retain(original);
    return original;
  }
  const workbook = form.get("workbook");
  const manifestFile = form.get("manifest");
  if (!(workbook instanceof File) || !(manifestFile instanceof File)) throw new HTTPException(400, { message: "Workbook and manifest files are required" });
  let parsedManifest: unknown;
  try { parsedManifest = JSON.parse(await observe(manifestFile.text())); }
  catch { throw new HTTPException(400, { message: "The FabuBlox manifest is not valid JSON" }); }
  if (!parsedManifest || typeof parsedManifest !== "object") throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  const manifest = parsedManifest as {
    schemaVersion: number;
    title: string;
    recipeFamilyId?: string | null;
    source: { fileName: string; fileSha256: string; sheetName: string };
    initialSubstrateStep: InitialSubstrateStep | null;
    steps: Array<{
      localId: string; sourceRow: number; position: number; stepNumber: string | null;
      sectionName: string | null; name: string; toolName: string | null;
      parametersText: string | null; commentsText: string | null;
      imageIds: string[]; rawCells: Record<string, unknown>;
    }>;
    images: Array<{
      localId: string; sourcePart: string; mimeType: string;
      assignedStepLocalId: string | null;
      anchor: Record<string, unknown>;
    }>;
    initialStateImageIds: string[];
    warnings: unknown[];
  };
  if (manifest.schemaVersion !== 2 || typeof manifest.title !== "string" || !manifest.title.trim() || manifest.title.length > 200 || typeof manifest.source?.sheetName !== "string" || !manifest.source.sheetName || !Array.isArray(manifest.steps) || !manifest.steps.length || !Array.isArray(manifest.images) || !Array.isArray(manifest.initialStateImageIds) || !Array.isArray(manifest.warnings)
    || (manifest.initialSubstrateStep !== null && (typeof manifest.initialSubstrateStep !== "object"
      || manifest.initialSubstrateStep.stepNumber !== "0"
      || typeof manifest.initialSubstrateStep.name !== "string"
      || normalizedSubstrateStepName(manifest.initialSubstrateStep.name) !== "substrate stack"
      || !Array.isArray(manifest.initialSubstrateStep.imageIds)))) {
    throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  }
  if (manifest.recipeFamilyId !== undefined && manifest.recipeFamilyId !== null && typeof manifest.recipeFamilyId !== "string") {
    throw new HTTPException(400, { message: "Invalid process-template family" });
  }
  if (manifest.steps.length > MAX_FABUBLOX_IMPORT_STEPS || manifest.images.length > MAX_FABUBLOX_IMPORT_IMAGES) {
    throw new HTTPException(413, { message: `This import exceeds the ${MAX_FABUBLOX_IMPORT_STEPS}-step or ${MAX_FABUBLOX_IMPORT_IMAGES}-image deployment limit` });
  }
  for (const image of manifest.images) {
    if (!(form.get(`image:${image.localId}`) instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
  }
  const imageIds = new Set(manifest.images.map((image) => image.localId));
  if (imageIds.size !== manifest.images.length || manifest.images.some((image) => typeof image.localId !== "string" || !image.localId)) {
    throw new HTTPException(400, { message: "Imported image identifiers must be unique" });
  }
  const expectedFields = new Set(["workbook", "manifest", ...manifest.images.map((image) => `image:${image.localId}`)]);
  const observedFields = new Set<string>();
  for (const key of form.keys()) {
    if (!expectedFields.has(key) || observedFields.has(key)) {
      throw new HTTPException(400, { message: "Unexpected or duplicate import field" });
    }
    observedFields.add(key);
  }
  if (new Set(manifest.initialStateImageIds).size !== manifest.initialStateImageIds.length
    || manifest.initialStateImageIds.some((id) => typeof id !== "string" || !imageIds.has(id))) {
    throw new HTTPException(400, { message: "Invalid initial substrate image selection" });
  }
  if (manifest.initialSubstrateStep) {
    const declared = new Set(manifest.initialSubstrateStep.imageIds);
    if (manifest.initialStateImageIds.some((id) => !declared.has(id))
      || manifest.initialSubstrateStep.imageIds.some((id) => !manifest.initialStateImageIds.includes(id))
      || manifest.steps.some((step) => step.localId === manifest.initialSubstrateStep?.localId)) {
      throw new HTTPException(400, { message: "Step 0 must be represented only as the initial substrate" });
    }
  } else if (manifest.initialStateImageIds.length) {
    throw new HTTPException(400, { message: "Initial substrate images require Step 0: Substrate Stack" });
  }
  const processStepIds = new Set(manifest.steps.map((step) => step.localId));
  if (processStepIds.size !== manifest.steps.length
    || (manifest.initialSubstrateStep && processStepIds.has(manifest.initialSubstrateStep.localId))) {
    throw new HTTPException(400, { message: "Process and substrate step identifiers must be unique" });
  }
  const allowedStepIds = new Set([
    ...processStepIds,
    ...(manifest.initialSubstrateStep ? [manifest.initialSubstrateStep.localId] : []),
  ]);
  for (const image of manifest.images) {
    if (image.assignedStepLocalId !== null && !allowedStepIds.has(image.assignedStepLocalId)) {
      throw new HTTPException(400, { message: `Image ${image.localId} refers to an unknown process row` });
    }
  }
  const payloadBytes = workbook.size + manifestFile.size + manifest.images.reduce((sum, image) => {
    const file = form.get(`image:${image.localId}`);
    return sum + (file instanceof File ? file.size : 0);
  }, 0);
  if (payloadBytes > 50 * 1024 * 1024) throw new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
  const workbookBuffer = await observe(workbook.arrayBuffer());
  const actualSha = await observe(digestSha256(workbookBuffer));
  if (actualSha !== manifest.source.fileSha256) throw new HTTPException(400, { message: "Workbook checksum does not match the preview" });

  const manifestBytes = new TextEncoder().encode(stableJson(manifest));
  const manifestBuffer = manifestBytes.buffer.slice(manifestBytes.byteOffset, manifestBytes.byteOffset + manifestBytes.byteLength) as ArrayBuffer;
  const imageInputs: Array<{
    image: typeof manifest.images[number]; file: File; buffer: ArrayBuffer; sha256: string;
  }> = [];
  for (let index = 0; index < manifest.images.length; index += 5) {
    const prepared = await observe(Promise.all(manifest.images.slice(index, index + 5).map((image) => observe((async () => {
      const value = form.get(`image:${image.localId}`);
      if (!(value instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
      const mimeType = value.type || image.mimeType;
      if (!mimeType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: `Imported asset ${image.localId} is not an image` });
      const buffer = await observe(value.arrayBuffer());
      return { image, file: value, buffer, sha256: await observe(digestSha256(buffer)) };
    })()))));
    imageInputs.push(...prepared);
  }

  const manifestSha256 = await observe(digestSha256(manifestBuffer));
  const workbookMimeType = workbook.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const requestInput: FabubloxImportInput = {
    schema: "fabublox-import-request/1",
    workbook: { sha256: actualSha, byteSize: workbookBuffer.byteLength, mimeType: workbookMimeType, originalName: workbook.name, purpose: "provenance" },
    manifest: { sha256: manifestSha256, byteSize: manifestBuffer.byteLength, mimeType: "application/json", originalName: "manifest.json", purpose: "provenance" },
    images: imageInputs.map(({ image, file, buffer, sha256 }) => ({ localId: image.localId, sha256, byteSize: buffer.byteLength, mimeType: file.type || image.mimeType, originalName: file.name, purpose: "embedded_content" })),
  };
  const requestInputJson = stableJson(requestInput);
  const requestInputBytes = new TextEncoder().encode(requestInputJson);
  if (requestInputBytes.byteLength > MAX_FABUBLOX_REQUEST_INPUT_BYTES) throw new HTTPException(413, { message: "Import request metadata is too large" });
  const requestSha256 = await observe(digestSha256(requestInputBytes.buffer as ArrayBuffer));
  return { workbook, manifest, workbookBuffer, actualSha, manifestBuffer, imageInputs,
    manifestSha256, workbookMimeType, requestInput, requestInputJson, requestSha256 };
}
export type PreparedFabubloxPayload = Awaited<ReturnType<typeof prepareFabubloxPayloadFromForm>>;

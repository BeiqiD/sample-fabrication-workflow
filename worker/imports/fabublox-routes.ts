import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { InitialSubstrateStep } from "../../shared/types";
import { hashInitialSubstrateRepresentation, hashRecipeManifest, hashStateRepresentation, hashStepDefinition, logicalStepKey, normalizedStepName, stableJson, STEP_HASH_SCHEME } from "../../shared/content-addressing";
import { bulkInsertStatements } from "../d1-bulk";
import { primaryD1 } from "../d1-primary";
import { contentLengthWithin } from "../request-guards";
import { resolveAssetReferences } from "../asset-dedupe";
import { fabubloxImportLeaseExpiresAt, queueFabubloxImportCleanup, readFabubloxImportState } from "../fabublox-import-recovery";
import type { Env } from "../types";
import { normalizedSubstrateStepName } from "../process-definition/substrate";
import { digestSha256, reusableR2Asset, safeObjectName } from "../application/r2-upload-support";
import { verifyR2Bytes, writeR2Bytes } from "../files/legacy-byte-writer";
import { ByteVerificationError } from "../files/byte-verification";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

const MAX_FABUBLOX_IMPORT_STEPS = 180;
const MAX_FABUBLOX_IMPORT_IMAGES = MAX_FABUBLOX_IMPORT_STEPS;

routes.post("/imports/fabublox", async (c) => {
  if (!contentLengthWithin(c.req.raw, 50 * 1024 * 1024)) throw new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
  const form = await c.req.raw.formData();
  const workbook = form.get("workbook");
  const manifestFile = form.get("manifest");
  if (!(workbook instanceof File) || !(manifestFile instanceof File)) throw new HTTPException(400, { message: "Workbook and manifest files are required" });
  let parsedManifest: unknown;
  try { parsedManifest = JSON.parse(await manifestFile.text()); }
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
  const workbookBuffer = await workbook.arrayBuffer();
  const actualSha = await digestSha256(workbookBuffer);
  if (actualSha !== manifest.source.fileSha256) throw new HTTPException(400, { message: "Workbook checksum does not match the preview" });

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const manifestBuffer = manifestBytes.buffer.slice(manifestBytes.byteOffset, manifestBytes.byteOffset + manifestBytes.byteLength) as ArrayBuffer;
  const imageInputs: Array<{
    image: typeof manifest.images[number]; file: File; buffer: ArrayBuffer; sha256: string;
  }> = [];
  for (let index = 0; index < manifest.images.length; index += 5) {
    const prepared = await Promise.all(manifest.images.slice(index, index + 5).map(async (image) => {
      const value = form.get(`image:${image.localId}`);
      if (!(value instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
      const mimeType = value.type || image.mimeType;
      if (!mimeType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: `Imported asset ${image.localId} is not an image` });
      const buffer = await value.arrayBuffer();
      return { image, file: value, buffer, sha256: await digestSha256(buffer) };
    }));
    imageInputs.push(...prepared);
  }

  const existingFamily = manifest.recipeFamilyId
    ? await c.env.DB.prepare("SELECT id, name, template_type FROM recipe_families WHERE id = ? AND archived_at IS NULL")
      .bind(manifest.recipeFamilyId).first<{ id: string; name: string; template_type: string }>()
    : await c.env.DB.prepare("SELECT id, name, template_type FROM recipe_families WHERE name = ? AND template_type = 'process' AND archived_at IS NULL")
      .bind(manifest.title.trim()).first<{ id: string; name: string; template_type: string }>();
  if (manifest.recipeFamilyId && !existingFamily) throw new HTTPException(404, { message: "Process-template family not found" });
  const internalTemplateType = existingFamily?.template_type ?? "process";
  const recipeFamilyId = existingFamily?.id ?? crypto.randomUUID();
  const recipeName = existingFamily?.name ?? manifest.title.trim();
  const importId = crypto.randomUUID();
  const importOperationId = crypto.randomUUID();
  const finalizationId = crypto.randomUUID();
  const startedAt = new Date();
  const now = startedAt.toISOString();
  const leaseExpiresAt = fabubloxImportLeaseExpiresAt(startedAt);
  const userEmail = c.get("userEmail");
  const importDb = primaryD1(c.env.DB);
  await importDb.prepare(
    `INSERT INTO imports (
       id, status, source_filename, source_sha256, sheet_name, template_type,
       recipe_family_id, warning_count, actor_email, created_at,
       operation_id, lease_expires_at
     ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    importId,
    workbook.name,
    actualSha,
    manifest.source.sheetName,
    internalTemplateType,
    recipeFamilyId,
    manifest.warnings.length,
    userEmail,
    now,
    importOperationId,
    leaseExpiresAt,
  ).run();

  let completedTemplateVersionId: string | null = null;
  let completedVersion: number | null = null;
  try {
    const prefix = `imports/${importId}`;
    type Candidate = {
      kind: "workbook" | "manifest" | "image";
      localId: string;
      originalName: string;
      mimeType: string;
      buffer: ArrayBuffer;
      sha256: string;
      image?: typeof manifest.images[number];
    };
    const candidates: Candidate[] = [
      { kind: "workbook", localId: "workbook", originalName: workbook.name, mimeType: workbook.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: workbookBuffer, sha256: actualSha },
      { kind: "manifest", localId: "manifest", originalName: "manifest.json", mimeType: "application/json", buffer: manifestBuffer, sha256: await digestSha256(manifestBuffer) },
      ...imageInputs.map(({ image, file, buffer, sha256 }) => ({ kind: "image" as const, localId: image.localId, originalName: file.name, mimeType: file.type || image.mimeType, buffer, sha256, image })),
    ];
    const hashes = [...new Set(candidates.map((candidate) => candidate.sha256))];
    const existingByHash = new Map<string, { assetId: string; key: string }>();
    for (let index = 0; index < hashes.length; index += 5) {
      const verified = await Promise.all(hashes.slice(index, index + 5).map(async (hash) => {
        const asset = await reusableR2Asset(c.env, hash);
        if (asset) {
          // Legacy ready/stat is not whole-content evidence. Check the exact
          // selected bytes before this import adopts an existing location.
          await verifyR2Bytes(c.env, {
            objectKey: asset.r2_key,
            byteSize: candidates.find((candidate) => candidate.sha256 === hash)!.buffer.byteLength,
            sha256: hash,
          });
        }
        return { hash, asset };
      }));
      for (const candidate of verified) {
        if (candidate.asset) {
          existingByHash.set(candidate.hash, {
            assetId: candidate.asset.id,
            key: candidate.asset.r2_key,
          });
        }
      }
    }
    const resolved = resolveAssetReferences(candidates, existingByHash, (candidate) => {
      const suffix = candidate.kind === "workbook" ? `source/${safeObjectName(candidate.originalName)}`
        : candidate.kind === "manifest" ? "manifest.json"
          : `images/${candidate.localId}-${safeObjectName(candidate.originalName)}`;
      return { assetId: crypto.randomUUID(), key: `${prefix}/${suffix}` };
    });
    const newAssets = [...new Map(resolved.filter((asset) => asset.isNew)
      .map((asset) => [asset.assetId, asset])).values()];
    const stagedAssets: typeof newAssets = [];
    for (const asset of newAssets) {
      let registered = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const registrationDb = primaryD1(c.env.DB);
          await registrationDb.prepare(
            `INSERT INTO assets
             (id, import_id, r2_key, original_name, mime_type, byte_size,
              status, actor_email, created_at, sha256)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          ).bind(
            asset.assetId,
            importId,
            asset.key,
            asset.originalName,
            asset.mimeType,
            asset.buffer.byteLength,
            userEmail,
            now,
            asset.sha256,
          ).run();
          stagedAssets.push(asset);
          registered = true;
          break;
        } catch (error) {
          const ownRegistration = await primaryD1(c.env.DB).prepare(`
            SELECT id
            FROM assets
            WHERE id = ? AND import_id = ? AND r2_key = ?
              AND original_name = ? AND mime_type = ? AND byte_size = ?
              AND status = 'pending' AND sha256 = ?
          `).bind(
            asset.assetId,
            importId,
            asset.key,
            asset.originalName,
            asset.mimeType,
            asset.buffer.byteLength,
            asset.sha256,
          ).first<{ id: string }>();
          if (ownRegistration) {
            stagedAssets.push(asset);
            registered = true;
            break;
          }
          const winner = await reusableR2Asset(c.env, asset.sha256);
          if (winner) {
            await verifyR2Bytes(c.env, {
              objectKey: winner.r2_key,
              byteSize: asset.buffer.byteLength,
              sha256: asset.sha256,
            });
            for (const candidate of resolved) {
              if (candidate.sha256 !== asset.sha256) continue;
              candidate.assetId = winner.id;
              candidate.key = winner.r2_key;
              candidate.isNew = false;
            }
            registered = true;
            break;
          }
          if (attempt === 1) throw error;
        }
      }
      if (!registered) {
        throw new HTTPException(409, {
          message: "Imported asset registration could not be reconciled",
        });
      }
    }

    // Every provider write now has a durable pending asset row first. A lost or
    // failed PUT can therefore be recovered by the lease reaper and GC queue.
    for (let index = 0; index < stagedAssets.length; index += 5) {
      const uploadResults = await Promise.allSettled(
        stagedAssets.slice(index, index + 5).map((asset) =>
          writeR2Bytes(c.env, {
            objectKey: asset.key,
            bytes: asset.buffer,
            originalName: asset.originalName,
            mimeType: asset.mimeType,
            byteSize: asset.buffer.byteLength,
            sha256: asset.sha256,
          })),
      );
      const failedUpload = uploadResults.find((result) => result.status === "rejected");
      if (failedUpload?.status === "rejected") throw failedUpload.reason;
    }

    const workbookAsset = resolved.find((asset) => asset.kind === "workbook")!;
    const manifestAsset = resolved.find((asset) => asset.kind === "manifest")!;
    const imageAssets = resolved.filter((asset) => asset.kind === "image");
    const latest = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE recipe_family_id = ?",
    ).bind(recipeFamilyId).first<{ version: number }>();
    const version = (latest?.version ?? 0) + 1;
    const templateVersionId = crypto.randomUUID();
    completedVersion = version;
    completedTemplateVersionId = templateVersionId;
    const stepIds = new Map(manifest.steps.map((step) => [step.localId, crypto.randomUUID()]));

    const occurrences = new Map<string, number>();
    const definitions = new Map<string, Awaited<ReturnType<typeof hashStepDefinition>>>();
    const states = new Map<string, { hash: string; canonical: Record<string, unknown> }>();
    const stateAssetRows = new Map<string, [string, string, number]>();
    const initialStateAssets = imageAssets.filter((asset) => manifest.initialStateImageIds.includes(asset.localId));
    let initialStateHash: string | null = null;
    if (manifest.initialSubstrateStep) {
      const initialState = await hashInitialSubstrateRepresentation(
        manifest.initialSubstrateStep,
        initialStateAssets.map((asset) => asset.sha256),
      );
      states.set(initialState.hash, initialState);
      initialStateHash = initialState.hash;
      initialStateAssets.forEach((asset, index) =>
        stateAssetRows.set(`${initialState.hash}:${asset.assetId}`, [initialState.hash, asset.assetId, index]));
    }
    let inheritedStateHash: string | null = initialStateHash;
    const preparedSteps: Array<{
      source: typeof manifest.steps[number]; logicalKey: string; definitionHash: string; expectedStateHash: string | null;
    }> = [];
    for (const step of manifest.steps) {
      const occurrenceKey = normalizedStepName(step.name);
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      const logicalKey = logicalStepKey(step, occurrence);
      const definition = await hashStepDefinition(step);
      definitions.set(definition.hash, definition);
      const assignedAssets = imageAssets.filter((asset) => asset.image?.assignedStepLocalId === step.localId);
      if (assignedAssets.length) {
        const state = await hashStateRepresentation(assignedAssets.map((asset) => asset.sha256));
        states.set(state.hash, state);
        inheritedStateHash = state.hash;
        assignedAssets.forEach((asset, index) => stateAssetRows.set(`${state.hash}:${asset.assetId}`, [state.hash, asset.assetId, index]));
      }
      preparedSteps.push({ source: step, logicalKey, definitionHash: definition.hash, expectedStateHash: inheritedStateHash });
    }
    const manifestHash = await hashRecipeManifest(preparedSteps.map((step) => ({
      logicalStepKey: step.logicalKey, definitionHash: step.definitionHash, expectedStateHash: step.expectedStateHash,
    })));

    const existingDefinitionHashes = new Set<string>();
    const definitionHashes = [...definitions.keys()];
    for (let index = 0; index < definitionHashes.length; index += 90) {
      const chunk = definitionHashes.slice(index, index + 90);
      const rows = await c.env.DB.prepare(`SELECT hash FROM step_definitions WHERE hash IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk).all<{ hash: string }>();
      rows.results.forEach((row) => existingDefinitionHashes.add(row.hash));
    }
    const stateHashes = [...states.keys()];
    const existingStateHashes = new Set<string>();
    if (stateHashes.length) {
      const rows = await c.env.DB.prepare(
        "SELECT hash FROM state_representations WHERE hash IN (SELECT value FROM json_each(?))",
      ).bind(JSON.stringify(stateHashes)).all<{ hash: string }>();
      rows.results.forEach((row) => existingStateHashes.add(row.hash));
    }

    const metadataStatements: D1PreparedStatement[] = [
      ...(!existingFamily ? [c.env.DB.prepare(
        `INSERT INTO recipe_families (id, name, template_type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(recipeFamilyId, recipeName, internalTemplateType, userEmail, now)] : []),
      c.env.DB.prepare(
        `UPDATE imports SET template_version_id = ?
         WHERE id = ? AND status = 'pending' AND operation_id = ?
           AND finalization_id IS NULL AND lease_expires_at > ?`,
      ).bind(templateVersionId, importId, importOperationId, now),
      ...bulkInsertStatements(c.env.DB, "step_definitions",
        ["hash", "hash_scheme", "name", "tool_name", "parameters_text", "comments_text", "canonical_json", "created_at"],
        [...definitions.values()].filter((definition) => !existingDefinitionHashes.has(definition.hash)).map((definition) => [
          definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
          definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now,
        ])),
      ...bulkInsertStatements(c.env.DB, "state_representations",
        ["hash", "hash_scheme", "representation_type", "content_json", "created_at"],
        [...states.values()].filter((state) => !existingStateHashes.has(state.hash)).map((state) => [
          state.hash, String(state.canonical.schema), String(state.canonical.type), stableJson(state.canonical), now,
        ])),
      c.env.DB.prepare(
        `INSERT INTO template_versions
          (id, recipe_family_id, name, template_type, version, manifest_hash, initial_state_hash,
           source_filename, source_asset_key, content_json, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM imports owning_import
         WHERE owning_import.id = ? AND owning_import.status = 'pending'
           AND owning_import.operation_id = ? AND owning_import.finalization_id IS NULL
           AND owning_import.template_version_id = ? AND owning_import.lease_expires_at > ?`,
      ).bind(templateVersionId, recipeFamilyId, recipeName, internalTemplateType, version, manifestHash, initialStateHash, workbook.name, workbookAsset.key, JSON.stringify({
        schemaVersion: manifest.schemaVersion,
        source: manifest.source,
        importedTitle: manifest.title,
        objectKind: "process_template",
        initialSubstrateStep: manifest.initialSubstrateStep,
        warningCount: manifest.warnings.length,
      }), userEmail, now, importId, importOperationId, templateVersionId, now),
      ...bulkInsertStatements(c.env.DB, "template_steps",
        ["id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json"],
        preparedSteps.map((step) => [stepIds.get(step.source.localId), templateVersionId, step.logicalKey, step.source.position,
          step.source.sourceRow, step.source.stepNumber, step.source.sectionName, step.definitionHash, step.expectedStateHash, JSON.stringify(step.source.rawCells)])),
    ];
    for (let index = 0; index < metadataStatements.length; index += 45) {
      await c.env.DB.batch(metadataStatements.slice(index, index + 45));
    }

    const completedAt = new Date().toISOString();
    const finalizationDb = primaryD1(c.env.DB);
    const finalizationAssetRows = JSON.stringify([...stateAssetRows.values()]);
    const [finalizationResult] = await finalizationDb.batch([
      finalizationDb.prepare(`
        UPDATE imports
        SET status = 'ready', workbook_asset_key = ?, manifest_asset_key = ?,
            finalization_id = ?, completed_at = ?, lease_expires_at = NULL
        WHERE id = ? AND status = 'pending' AND operation_id = ?
          AND template_version_id = ? AND lease_expires_at > ?
      `).bind(
        workbookAsset.key,
        manifestAsset.key,
        finalizationId,
        completedAt,
        importId,
        importOperationId,
        templateVersionId,
        completedAt,
      ),
      finalizationDb.prepare(`
        INSERT INTO state_representation_assets (state_hash, asset_id, position)
        SELECT CAST(json_extract(entry.value, '$[0]') AS TEXT),
               CAST(json_extract(entry.value, '$[1]') AS TEXT),
               CAST(json_extract(entry.value, '$[2]') AS INTEGER)
        FROM json_each(?) entry
        WHERE EXISTS (
          SELECT 1 FROM imports owning_import
          WHERE owning_import.id = ? AND owning_import.status = 'ready'
            AND owning_import.operation_id = ?
            AND owning_import.finalization_id = ?
            AND owning_import.template_version_id = ?
        )
        ON CONFLICT(state_hash, asset_id) DO UPDATE SET
          position = excluded.position
      `).bind(
        finalizationAssetRows,
        importId,
        importOperationId,
        finalizationId,
        templateVersionId,
      ),
    ]);
    if (!finalizationResult.meta.changes) {
      throw new HTTPException(409, {
        message: "The import lease changed before finalization",
      });
    }
    return c.json({ id: importId, templateVersionId, version }, 201);
  } catch (error) {
    let authoritative;
    try {
      authoritative = await readFabubloxImportState(c.env.DB, importId);
    } catch (readError) {
      console.error("Could not determine FabuBlox finalization outcome", readError);
      throw new HTTPException(503, {
        message: "Import finalization outcome is unknown; persistent recovery will reconcile it",
      });
    }

    if (authoritative?.status === "ready"
      && authoritative.operation_id === importOperationId
      && authoritative.finalization_id === finalizationId
      && authoritative.template_version_id === completedTemplateVersionId
      && completedTemplateVersionId !== null
      && completedVersion !== null) {
      return c.json({
        id: importId,
        templateVersionId: completedTemplateVersionId,
        version: completedVersion,
      }, 201);
    }

    if (authoritative?.status === "pending"
      && authoritative.operation_id === importOperationId
      && authoritative.finalization_id === null) {
      try {
        await queueFabubloxImportCleanup(c.env, {
          importId,
          operationId: importOperationId,
          error,
        });
      } catch (recoveryError) {
        // Provider bytes remain untouched. The persisted lease allows the
        // scheduled reaper to retry this metadata-only recovery safely.
        console.error("Could not queue failed FabuBlox import recovery", recoveryError);
      }
    }
    if (error instanceof ByteVerificationError) {
      const badSource = error.phase === "source"
        && (error.reason === "size_mismatch" || error.reason === "hash_mismatch");
      throw new HTTPException(badSource ? 400 : 503, {
        message: error.message,
      });
    }
    throw error;
  }
});

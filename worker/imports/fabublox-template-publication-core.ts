import { hashInitialSubstrateRepresentation, hashRecipeManifest, hashStateRepresentation, hashStepDefinition, logicalStepKey, normalizedStepName } from "../../shared/content-addressing";
import type { PreparedFabubloxPayload } from "./fabublox-payload";

/** Selected descriptors supplied by the genuine publication issuer. This
 * algorithm grants no Request, File, Template, SQL or provider authority. */
export interface FabubloxTemplatePublicationAsset {
  kind: "workbook" | "manifest" | "image";
  localId: string;
  assetId: string;
  key: string;
  legacyKey: string | null;
  isNew: boolean;
  fileId: string;
  sha256: string;
  image?: PreparedFabubloxPayload["manifest"]["images"][number];
}

/** Complete original ordered template-content derivation. The issuer validates
 * descriptor shape and supplies the existing per-step identities. This function
 * performs no request parsing, UUID creation, persistence or provider I/O. */
export async function deriveFabubloxTemplatePublication(
  manifest: PreparedFabubloxPayload["manifest"],
  resolved: readonly FabubloxTemplatePublicationAsset[],
  stepIds: ReadonlyMap<string, string>,
) {
    const workbookAsset = resolved.find((asset) => asset.kind === "workbook")!;
    const manifestAsset = resolved.find((asset) => asset.kind === "manifest")!;
    const workbookLegacyKey = workbookAsset.legacyKey === undefined ? workbookAsset.key : workbookAsset.legacyKey;
    const manifestLegacyKey = manifestAsset.legacyKey === undefined ? manifestAsset.key : manifestAsset.legacyKey;
    const imageAssets = resolved.filter((asset) => asset.kind === "image");
    const occurrences = new Map<string, number>();
    const definitions = new Map<string, Awaited<ReturnType<typeof hashStepDefinition>>>();
    const states = new Map<string, { hash: string; canonical: Record<string, unknown> }>();
    const stateAssetRows = new Map<string, [string, string, number, string?]>();
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
        stateAssetRows.set(`${initialState.hash}:${asset.assetId}`, [initialState.hash, asset.assetId, index, asset.fileId]));
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
        assignedAssets.forEach((asset, index) => stateAssetRows.set(`${state.hash}:${asset.assetId}`, [state.hash, asset.assetId, index, asset.fileId]));
      }
      preparedSteps.push({ source: step, logicalKey, definitionHash: definition.hash, expectedStateHash: inheritedStateHash });
    }
    const manifestHash = await hashRecipeManifest(preparedSteps.map((step) => ({
      logicalStepKey: step.logicalKey, definitionHash: step.definitionHash, expectedStateHash: step.expectedStateHash,
    })));

    return { workbookAsset, manifestAsset, workbookLegacyKey, manifestLegacyKey,
      definitions, states, stateAssetRows, initialStateHash, preparedSteps, manifestHash, stepIds };
}

// ../../../workspace/phase5f-file-current2d07-start202-mobile-native-private-attempt1/copy/shared/domain/content-addressing.ts
var STEP_HASH_SCHEME = "step-definition/v1";
var STATE_HASH_SCHEME = "state-diagram/v1";
var SUBSTRATE_STATE_HASH_SCHEME = "substrate-state/v1";
var MANIFEST_HASH_SCHEME = "recipe-manifest/v1";
function normalizedText(value) {
  const normalized = (value ?? "").normalize("NFC").replace(/\r\n?/g, "\n");
  return normalized.split("\n").map((line) => line.trimEnd()).join("\n").trim() || null;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)])
  );
  return value;
}
function stableJson(value) {
  return JSON.stringify(stableValue(value));
}
async function sha256Hex(value) {
  const buffer = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalStepDefinition(source) {
  return {
    schema: STEP_HASH_SCHEME,
    name: normalizedText(source.name) ?? "",
    toolName: normalizedText(source.toolName),
    parametersText: normalizedText(source.parametersText),
    commentsText: normalizedText(source.commentsText)
  };
}
async function hashStepDefinition(source) {
  const canonical = canonicalStepDefinition(source);
  return { hash: await sha256Hex(stableJson(canonical)), canonical };
}
async function hashStateRepresentation(assetHashes) {
  const canonical = { schema: STATE_HASH_SCHEME, type: "diagram", assetHashes: [...assetHashes] };
  return { hash: await sha256Hex(stableJson(canonical)), canonical };
}
async function hashInitialSubstrateRepresentation(source, assetHashes) {
  const definition = canonicalStepDefinition(source);
  const canonical = {
    ...definition,
    schema: SUBSTRATE_STATE_HASH_SCHEME,
    type: "substrate",
    stepNumber: normalizedText(source.stepNumber),
    rawCells: stableValue(source.rawCells ?? {}),
    assetHashes: [...assetHashes]
  };
  return { hash: await sha256Hex(stableJson(canonical)), canonical };
}
function normalizedStepName(name) {
  return name.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}
function logicalStepKey(input, occurrence) {
  return `name:${encodeURIComponent(normalizedStepName(input.name) || "step")}:${occurrence}`;
}
async function hashRecipeManifest(steps) {
  return sha256Hex(stableJson({ schema: MANIFEST_HASH_SCHEME, steps }));
}
export {
  STATE_HASH_SCHEME,
  STEP_HASH_SCHEME,
  SUBSTRATE_STATE_HASH_SCHEME,
  hashInitialSubstrateRepresentation,
  hashRecipeManifest,
  hashStateRepresentation,
  hashStepDefinition,
  logicalStepKey,
  normalizedStepName,
  sha256Hex,
  stableJson
};

export const STEP_HASH_SCHEME = "step-definition/v1";
export const STATE_HASH_SCHEME = "state-diagram/v1";
export const MANIFEST_HASH_SCHEME = "recipe-manifest/v1";

function normalizedText(value: string | null | undefined) {
  const normalized = (value ?? "").normalize("NFC").replace(/\r\n?/g, "\n");
  return normalized.split("\n").map((line) => line.trimEnd()).join("\n").trim() || null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
  return value;
}

export function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export async function sha256Hex(value: string | ArrayBuffer) {
  const buffer = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface StepDefinitionSource {
  name: string;
  toolName?: string | null;
  parametersText?: string | null;
  commentsText?: string | null;
}

export function canonicalStepDefinition(source: StepDefinitionSource) {
  return {
    schema: STEP_HASH_SCHEME,
    name: normalizedText(source.name) ?? "",
    toolName: normalizedText(source.toolName),
    parametersText: normalizedText(source.parametersText),
    commentsText: normalizedText(source.commentsText),
  };
}

export async function hashStepDefinition(source: StepDefinitionSource) {
  const canonical = canonicalStepDefinition(source);
  return { hash: await sha256Hex(stableJson(canonical)), canonical };
}

export async function hashStateRepresentation(assetHashes: string[]) {
  const canonical = { schema: STATE_HASH_SCHEME, type: "diagram", assetHashes: [...assetHashes] };
  return { hash: await sha256Hex(stableJson(canonical)), canonical };
}

export function logicalStepKey(input: { stepNumber?: string | null; name: string }, occurrence: number, duplicateNumber = false) {
  const stepNumber = normalizedText(input.stepNumber);
  if (stepNumber) return `number:${stepNumber}${duplicateNumber ? `:${occurrence}` : ""}`;
  const slug = (normalizedText(input.name) ?? "step").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "step";
  return `name:${slug}:${occurrence}`;
}

export async function hashRecipeManifest(steps: Array<{ logicalStepKey: string; definitionHash: string; expectedStateHash: string | null }>) {
  return sha256Hex(stableJson({ schema: MANIFEST_HASH_SCHEME, steps }));
}

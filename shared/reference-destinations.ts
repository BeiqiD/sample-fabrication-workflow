import {
  isReferenceTarget,
  isReferenceTargetType,
  type ReferenceContext,
  type ReferenceContextSegment,
  type ReferenceDestination,
  type ReferenceResolutionStatus,
  type ReferenceTarget,
  type ResolvedReferenceSource,
} from "./reference-types";

export interface ReferenceDestinationInput {
  target: ReferenceTarget;
  resolution: ReferenceResolutionStatus;
  source: ResolvedReferenceSource | null;
  contexts: ReferenceContext[];
}

export const REFERENCE_ROUTE_PATTERN = "/references/:type/:encodedId" as const;
export const REFERENCE_ROUTE_ID_CODEC_PREFIX = "r1_" as const;
export const REFERENCE_SOURCE_FOCUS_QUERY_PARAM = "focus" as const;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const EXISTING_SOURCE_PATH_ID = /^[A-Za-z0-9_-]+$/;

function encodeBase64Url(bytes: Uint8Array) {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET[first >>> 2];
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)];
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET[third & 0x3f];
  }
  return encoded;
}

function base64UrlValue(character: string | undefined) {
  if (character === undefined) return null;
  const value = BASE64URL_ALPHABET.indexOf(character);
  return value < 0 ? null : value;
}

function decodeBase64Url(encoded: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) return null;
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 4) {
    const first = base64UrlValue(encoded[index]);
    const second = base64UrlValue(encoded[index + 1]);
    const thirdCharacter = encoded[index + 2];
    const fourthCharacter = encoded[index + 3];
    const third = base64UrlValue(thirdCharacter);
    const fourth = base64UrlValue(fourthCharacter);
    if (first === null || second === null) return null;
    if (thirdCharacter !== undefined && third === null) return null;
    if (fourthCharacter !== undefined && fourth === null) return null;

    bytes.push((first << 2) | (second >>> 4));
    if (third !== null) bytes.push(((second & 0x0f) << 4) | (third >>> 2));
    if (fourth !== null) {
      if (third === null) return null;
      bytes.push(((third & 0x03) << 6) | fourth);
    }
  }
  const decoded = Uint8Array.from(bytes);
  return encodeBase64Url(decoded) === encoded ? decoded : null;
}

export function encodeReferenceRouteId(id: string) {
  const bytes = new Uint8Array(id.length * 2);
  for (let index = 0; index < id.length; index += 1) {
    const codeUnit = id.charCodeAt(index);
    bytes[index * 2] = codeUnit >>> 8;
    bytes[index * 2 + 1] = codeUnit & 0xff;
  }
  return `${REFERENCE_ROUTE_ID_CODEC_PREFIX}${encodeBase64Url(bytes)}`;
}

export function decodeReferenceRouteId(encodedId: string) {
  if (!encodedId.startsWith(REFERENCE_ROUTE_ID_CODEC_PREFIX)) return null;
  const bytes = decodeBase64Url(encodedId.slice(REFERENCE_ROUTE_ID_CODEC_PREFIX.length));
  if (!bytes || bytes.length % 2 !== 0) return null;
  let id = "";
  for (let index = 0; index < bytes.length; index += 2) {
    id += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
  }
  return encodeReferenceRouteId(id) === encodedId ? id : null;
}

export function encodeReferenceSourceFocus(target: ReferenceTarget) {
  return `${target.type}:${encodeReferenceRouteId(target.id)}`;
}

export function decodeReferenceSourceFocus(value: unknown): ReferenceTarget | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) return null;
  const type = value.slice(0, separator);
  if (!isReferenceTargetType(type)) return null;
  const id = decodeReferenceRouteId(value.slice(separator + 1));
  if (id === null) return null;
  const target = { type, id };
  return isReferenceTarget(target) && id.trim() === id ? target : null;
}

export function referenceUrlForTarget(target: ReferenceTarget) {
  return `/references/${target.type}/${encodeReferenceRouteId(target.id)}`;
}

function existingSourcePathSegment(value: string) {
  return EXISTING_SOURCE_PATH_ID.test(value) ? value : null;
}

function segment(
  context: ReferenceContext,
  type: ReferenceContextSegment["type"],
) {
  return context.segments.find((candidate) => candidate.type === type) ?? null;
}

function contextHasArchivedLifecycle(context: ReferenceContext) {
  return context.segments.some((candidate) => candidate.deletedAt || candidate.archivedAt);
}

function withQuery(path: string, entries: Array<[string, string | null]>) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function processingDestination(
  target: ReferenceTarget,
  context: ReferenceContext,
  requireRunIdentity = false,
  requireStepIdentity = false,
) {
  const sample = segment(context, "sample");
  const run = segment(context, "run");
  const step = segment(context, "run_step");
  if (!sample || !run) return null;
  if (requireRunIdentity && run.id !== target.id) return null;
  if (requireStepIdentity && (!step || step.id !== target.id)) return null;
  const samplePath = existingSourcePathSegment(sample.id);
  if (!samplePath) return null;

  return withQuery(`/processing/${samplePath}`, [
    ["run", run.id],
    ["step", step?.id ?? null],
    [
      REFERENCE_SOURCE_FOCUS_QUERY_PARAM,
      requireRunIdentity ? null : encodeReferenceSourceFocus(target),
    ],
  ]);
}

function contextSourceUrl(target: ReferenceTarget, context: ReferenceContext) {
  const sample = segment(context, "sample");
  const recipe = segment(context, "recipe_revision");

  switch (target.type) {
    case "sample": {
      const samplePath = sample?.id === target.id
        ? existingSourcePathSegment(sample.id)
        : null;
      return samplePath ? `/samples/${samplePath}` : null;
    }
    case "run":
      return processingDestination(target, context, true, false);
    case "run_step":
      return processingDestination(target, context, false, true);
    case "comment":
    case "comment_attachment": {
      if (segment(context, "run")) return processingDestination(target, context);
      const samplePath = sample ? existingSourcePathSegment(sample.id) : null;
      return samplePath
        ? withQuery(`/samples/${samplePath}`, [
          [REFERENCE_SOURCE_FOCUS_QUERY_PARAM, encodeReferenceSourceFocus(target)],
        ])
        : null;
    }
    case "comment_occurrence":
    case "execution_image":
      return processingDestination(target, context);
    case "metrology_reference": {
      const recipePath = recipe ? existingSourcePathSegment(recipe.id) : null;
      return recipePath
        ? withQuery(`/templates/metrology/${recipePath}`, [
          [REFERENCE_SOURCE_FOCUS_QUERY_PARAM, encodeReferenceSourceFocus(target)],
        ])
        : null;
    }
    case "recipe_revision": {
      const recipePath = recipe?.id === target.id
        ? existingSourcePathSegment(recipe.id)
        : null;
      return recipePath ? `/templates/${recipePath}` : null;
    }
  }
}

export function buildReferenceDestination({
  target,
  resolution,
  source,
  contexts,
}: ReferenceDestinationInput): ReferenceDestination {
  const referenceUrl = referenceUrlForTarget(target);
  const sourceAvailable = resolution === "resolved"
    && source !== null
    && !source.deletedAt
    && !source.archivedAt;

  const contextOpenSourceUrls = contexts.map((context) => {
    if (!sourceAvailable || contextHasArchivedLifecycle(context)) return null;
    return contextSourceUrl(target, context);
  });
  const uniqueOpenSourceUrls = [...new Set(
    contextOpenSourceUrls.filter((value): value is string => value !== null),
  )];
  const mode = sourceAvailable && uniqueOpenSourceUrls.length > 0
    ? "source"
    : "archived";

  return {
    referenceUrl,
    mode,
    openSourceUrl: mode === "source" && uniqueOpenSourceUrls.length === 1
      ? uniqueOpenSourceUrls[0]
      : null,
    contextOpenSourceUrls: mode === "source"
      ? contextOpenSourceUrls
      : contexts.map(() => null),
  };
}

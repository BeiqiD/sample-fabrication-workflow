const MIME_TOKEN = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";
const CANONICAL_MIME_TYPE_PATTERN = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}$`);

export function isCanonicalMimeType(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= 200
    && value.trim() === value
    && CANONICAL_MIME_TYPE_PATTERN.test(value);
}

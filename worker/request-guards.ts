export function escapedLikePattern(value: string) {
  let escaped = "";
  const encoder = new TextEncoder();
  for (const character of value.trim()) {
    const next = escaped + (character === "%" || character === "_" ? `\\${character}` : character);
    if (encoder.encode(next).byteLength > 48) break;
    escaped = next;
  }
  return `%${escaped}%`;
}

export function contentLengthWithin(request: Request, maximumBytes: number) {
  const raw = request.headers.get("content-length");
  if (!raw) return true;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 && length <= maximumBytes;
}

export function sameOriginOrNonBrowser(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

/** Memoize only a pure string derivation. Keys are exact input strings; the
 * finite limits account for retained UTF-16 string bytes, not engine overhead. */
export function boundedStringMemo(derive: (input: string) => string, limits: {
  maxEntries: number; maxStringBytes: number;
}) {
  const { maxEntries, maxStringBytes } = limits;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0
    || !Number.isSafeInteger(maxStringBytes) || maxStringBytes < 0) throw new Error("Invalid string memo limits");
  const entries = new Map<string, { value: string; bytes: number }>();
  let retainedBytes = 0;
  return (input: string): string => {
    if (typeof input !== "string") return derive(input);
    const cached = entries.get(input);
    if (cached !== undefined) {
      entries.delete(input);
      entries.set(input, cached);
      return cached.value;
    }
    // Failed derivations are not retained. Oversized inputs still take the
    // original derivation path and never displace useful small entries.
    const value = derive(input);
    const bytes = (input.length + value.length) * 2;
    if (maxEntries <= 0 || bytes > maxStringBytes) return value;
    while (entries.size >= maxEntries || retainedBytes + bytes > maxStringBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      retainedBytes -= entries.get(oldest)!.bytes;
      entries.delete(oldest);
    }
    entries.set(input, { value, bytes });
    retainedBytes += bytes;
    return value;
  };
}

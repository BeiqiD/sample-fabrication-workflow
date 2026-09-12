const DEFAULT_EXCERPT_LIMIT = 240;

// This is a conservative boundary check, not a Markdown parser. It only decides
// whether a complete-paragraph prefix could stop inside TeX or a code fence.
function previewBoundaryIsClosed(source: string) {
  let fence: { marker: string; length: number } | null = null;
  const outsideFence: string[] = [];
  for (const line of source.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length
        && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = { marker: marker[1][0], length: marker[1].length };
      continue;
    }
    outsideFence.push(line);
  }
  if (fence) return false;
  source = outsideFence.join("\n");
  let math: "$" | "$$" | "\\(" | "\\[" | null = null;
  const backtickRuns = new Map<number, number>();
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      const next = source[index + 1];
      if (next === "(" || next === "[") {
        if (math !== null) return false;
        math = next === "(" ? "\\(" : "\\[";
      } else if (next === ")" || next === "]") {
        if (math !== (next === ")" ? "\\(" : "\\[")) return false;
        math = null;
      }
      index += 1;
      continue;
    }
    if (character === "`") {
      let length = 1;
      while (source[index + length] === "`") length += 1;
      backtickRuns.set(length, (backtickRuns.get(length) ?? 0) + 1);
      index += length - 1;
      continue;
    }
    if (character !== "$" || math === "\\(" || math === "\\[") continue;
    const delimiter = source[index + 1] === "$" ? "$$" : "$";
    if (math === null) math = delimiter;
    else if (math === delimiter) math = null;
    else if (math !== "$$") return false;
    if (delimiter === "$$") index += 1;
  }
  return math === null
    && [...backtickRuns.values()].every((count) => count % 2 === 0);
}

/** Preserve complete short comments, or a closed paragraph prefix within budget. */
export function referenceCommentExcerpt(value: unknown, maximum = DEFAULT_EXCERPT_LIMIT): string | null {
  if (typeof value !== "string" || !Number.isInteger(maximum) || maximum < 1) return null;
  const source = value.replace(/\r\n?/g, "\n").trim();
  if (!source) return null;
  if (source.length <= maximum) return source;
  const boundaries = [...source.slice(0, maximum + 1).matchAll(/\n[\t ]*\n/g)]
    .map((match) => match.index);
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const prefix = source.slice(0, boundaries[index]).trimEnd();
    if (prefix && previewBoundaryIsClosed(prefix)) return prefix;
  }
  return null;
}

/** A comment has no authored title; use its first textual line, never TeX source. */
export function referenceCommentTitle(value: unknown, fallback = "Comment", maximum = 80) {
  if (typeof value !== "string") return fallback;
  const firstLine = value.trim().split(/\r?\n/, 1)[0]
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "");
  if (/^(?:`{3,}|~{3,})/.test(firstLine)) return fallback;
  const mathStart = firstLine.search(/\$|\\(?:[()[\]]|[A-Za-z])/);
  const text = (mathStart < 0 ? firstLine : firstLine.slice(0, mathStart)).trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return fallback;
  const characters = Array.from(text);
  return characters.length <= maximum ? text : `${characters.slice(0, maximum - 1).join("")}…`;
}

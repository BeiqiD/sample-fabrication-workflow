const DEFAULT_EXCERPT_LIMIT = 240;

function hasNestedFenceMarker(line: string) {
  // Lists, quotes and indented code require a block parser to distinguish. A
  // suspicious fence in one of those containers must not license truncation.
  let remainder = line;
  let prefix: RegExpExecArray | null;
  while ((prefix = /^(?:[\t ]+|>[\t ]?|(?:[-+*]|\d+[.)])[\t ]+)/.exec(remainder))) {
    remainder = remainder.slice(prefix[0].length);
  }
  return remainder !== line && /^(?:`{3,}|~{3,})/.test(remainder);
}

function closingCodeSpanEnd(source: string, start: number, openingLength: number) {
  // A later line can start another Markdown block even without a blank line.
  // Keep complete short source, but do not infer cross-block code spans while
  // choosing a truncated prefix without a full block parser.
  const newline = source.indexOf("\n", start);
  const end = newline < 0 ? source.length : newline;
  for (let index = start; index < end;) {
    const next = source.indexOf("`", index);
    if (next < 0 || next >= end) return -1;
    let length = 1;
    while (source[next + length] === "`") length += 1;
    if (length === openingLength) return next + length;
    index = next + length;
  }
  return -1;
}

function ambiguousLinkMath(source: string, index: number) {
  // Link destinations and titles may cross lines. Definitions are deliberately
  // conservative through the end of this bounded candidate prefix.
  if (source.startsWith("]:", index)) return /\$|\\[()[\]]/.test(source.slice(index + 2));
  if (source[index] === "<") {
    // Raw HTML is rendered as escaped text, potentially including an entire
    // multiline block. Do not treat its contents as mathematical delimiters.
    if (/^<(?:\/?[A-Za-z][\w:-]*(?:\s|\/?>)|[!?])/.test(source.slice(index))) return true;
    const closing = source.indexOf(">", index + 1);
    return /\$|\\[()[\]]/.test(source.slice(index + 1, closing < 0 ? source.length : closing));
  }
  if (!source.startsWith("](", index)) return false;
  let depth = 1;
  for (let cursor = index + 2; cursor < source.length; cursor += 1) {
    if (/\$|\\/.test(source[cursor])) return true;
    if (source[cursor] === "(") depth += 1;
    if (source[cursor] === ")" && --depth === 0) break;
  }
  return false;
}

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
    if (hasNestedFenceMarker(line)) return false;
    outsideFence.push(line);
  }
  if (fence) return false;
  source = outsideFence.join("\n");
  let math: "$" | "$$" | "\\(" | "\\[" | null = null;
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
    if (character === "`" && math === null) {
      let length = 1;
      while (source[index + length] === "`") length += 1;
      const end = closingCodeSpanEnd(source, index + length, length);
      if (end < 0) return false;
      index = end - 1;
      continue;
    }
    // Link destinations, titles, autolinks and definitions do not render their
    // delimiters as math. Without parsing those constructs, omit an ambiguous
    // prefix instead of allowing their dollars to close a later real formula.
    if (math === null && (character === "]" || character === "<")
      && ambiguousLinkMath(source, index)) return false;
    if (character !== "$" || math === "\\(" || math === "\\[") continue;
    const delimiter = source[index + 1] === "$" ? "$$" : "$";
    if (math === null) {
      // Display math is a block extension. Dollars in ordinary prose, code
      // indentation or a container we have not parsed cannot open a block.
      const lineStart = source.lastIndexOf("\n", index - 1) + 1;
      if (delimiter === "$$" && !/^ {0,3}$/.test(source.slice(lineStart, index))) return false;
      math = delimiter;
    } else if (math === delimiter) math = null;
    else if (math !== "$$") return false;
    if (delimiter === "$$") index += 1;
  }
  return math === null;
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

import { Marked, Renderer, type TokenizerAndRendererExtension, type Tokens } from "marked";
import Temml from "temml";

export type RichTextMode = "document" | "comment";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const RICH_TEXT_BASE_URL = new URL("https://rich-text.invalid/");

type RichTextMathToken = Tokens.Generic & {
  text: string;
  displayMode: boolean;
};

type SafeRichTextUrl = {
  value: string;
  externalHttp: boolean;
};

export function escapeRichTextHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

function hasUnsafeUrlCharacters(value: string) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function safeRichTextUrl(value: string, protocols: Set<string>): SafeRichTextUrl | null {
  const trimmed = value.trim();
  if (!trimmed
    || hasUnsafeUrlCharacters(trimmed)
    || trimmed.includes("\\")
    || trimmed.startsWith("//")) return null;
  try {
    const parsed = new URL(trimmed, RICH_TEXT_BASE_URL);
    const sameOrigin = parsed.origin === RICH_TEXT_BASE_URL.origin;
    if (!sameOrigin && !protocols.has(parsed.protocol)) return null;
    return {
      value: trimmed,
      externalHttp: !sameOrigin && (parsed.protocol === "http:" || parsed.protocol === "https:"),
    };
  } catch {
    return null;
  }
}

export function richTextSafeHref(value: string) {
  return safeRichTextUrl(value, SAFE_LINK_PROTOCOLS)?.value ?? null;
}

export function richTextSafeImageSrc(value: string) {
  return safeRichTextUrl(value, SAFE_IMAGE_PROTOCOLS)?.value ?? null;
}

function renderRichTextMath(source: string, displayMode: boolean) {
  const expression = source.trim();
  if (!expression) return "";
  try {
    const math = Temml.renderToString(expression, {
      annotate: true,
      displayMode,
      maxExpand: 1_000,
      maxSize: [20, 200],
      strict: false,
      throwOnError: true,
      trust: false,
    });
    const tag = displayMode ? "div" : "span";
    const mode = displayMode ? "block" : "inline";
    return `<${tag} class="rich-text-math rich-text-math-${mode}">${math}</${tag}>`;
  } catch {
    return `<code class="rich-text-math-error">${escapeRichTextHtml(source)}</code>`;
  }
}

// Each lexer owns its budget, including nested Markdown blocks and inline
// passes. Source-only fallback below preserves the entire document if malformed
// markers would otherwise repeatedly scan large suffixes on the UI thread.
const mathScanBudgets = new WeakMap<object, number>();

function mathClosingIndex(source: string, delimiter: string, offset: number, multiline: boolean, lexer: object) {
  let remaining = mathScanBudgets.get(lexer) ?? 0;
  const record = (closing: number) => {
    mathScanBudgets.set(lexer, remaining);
    return closing;
  };
  for (let index = offset; index < source.length; index += 1) {
    if (--remaining < 0) throw new Error("Math delimiter scan budget exhausted");
    if (!multiline && source[index] === "\n") return record(-1);
    if (source.startsWith(delimiter, index)) {
      // A display delimiter must not close a single-dollar expression.
      if (delimiter === "$" && source[index + 1] === "$") {
        index += 1;
        continue;
      }
      return record(index);
    }
    // Skip escaped delimiters, respecting paired backslashes in TeX.
    if (source[index] === "\\") {
      if (!multiline && source[index + 1] === "\n") return record(-1);
      index += 1;
    }
  }
  return record(-1);
}

function blockMathToken(source: string, lexer: object): RichTextMathToken | undefined {
  const opening = source.match(/^ {0,3}(\$\$|\\\[)/);
  if (!opening) return undefined;
  const delimiter = opening[1] === "$$" ? "$$" : "\\]";
  const closing = mathClosingIndex(source, delimiter, opening[0].length, true, lexer);
  if (closing < 0) return undefined;
  const end = closing + delimiter.length;
  const trailing = source.slice(end).match(/^[ \t]*(?:\n|$)/);
  const expression = source.slice(opening[0].length, closing);
  if (!trailing || !expression.trim()) return undefined;
  return {
    type: "richTextMathBlock",
    raw: source.slice(0, end + trailing[0].length),
    text: expression,
    displayMode: true,
  };
}

const blockMathExtension: TokenizerAndRendererExtension = {
  name: "richTextMathBlock",
  level: "block",
  start(source) {
    // Marked passes source.slice(1) here. Only interrupt a paragraph at a
    // subsequent line, and only when the tokenizer can consume a complete block.
    let starts = /\n {0,3}(\$\$|\\\[)/g;
    // Candidate openings before the same closing delimiter share its result.
    // In particular, an unmatched marker must scan the remaining paragraph
    // once, rather than once for every following unmatched opening.
    const closings = new Map<string, number>();
    let match: RegExpExecArray | null;
    while ((match = starts.exec(source))) {
      const index = match.index + 1;
      const offset = match.index + match[0].length;
      const delimiter = match[1] === "$$" ? "$$" : "\\]";
      let closing = closings.get(delimiter);
      if (closing === undefined || (closing >= 0 && closing < offset)) {
        closing = mathClosingIndex(source, delimiter, offset, true, this.lexer);
        closings.set(delimiter, closing);
      }
      if (closing < 0) {
        // No later opening of this kind can form a block in this source.
        // Search only for the other kind, including across Markdown headings.
        const other = delimiter === "$$" ? "\\]" : "$$";
        if (closings.get(other) === -1) return undefined;
        starts = other === "$$" ? /\n {0,3}(\$\$)/g : /\n {0,3}(\\\[)/g;
        starts.lastIndex = offset;
        continue;
      }
      const end = closing + delimiter.length;
      if (/^[ \t]*(?:\n|$)/.test(source.slice(end)) && source.slice(offset, closing).trim()) return index;
    }
    return undefined;
  },
  tokenizer(source) {
    if (!mathScanBudgets.has(this.lexer)) {
      // Marked invokes this first on the complete source, before descending
      // into lists/quotes or running the inline queue. Ordinary delimiters get
      // generous repeated passes; the minimum also covers short nested input.
      mathScanBudgets.set(this.lexer, Math.max(100_000, source.length * 16));
    }
    return blockMathToken(source, this.lexer);
  },
  renderer(token) {
    const math = token as RichTextMathToken;
    return renderRichTextMath(math.text, true);
  },
};

const inlineMathExtension: TokenizerAndRendererExtension = {
  name: "richTextMathInline",
  level: "inline",
  start(source) {
    // Marked already stops inline text at a backslash, so explicit TeX
    // parentheses reach our tokenizer without an additional suffix search.
    const index = source.indexOf("$");
    return index < 0 ? undefined : index;
  },
  tokenizer(source) {
    const bracket = source.startsWith("\\(");
    if (!bracket && (!source.startsWith("$") || source.startsWith("$$"))) return undefined;
    const offset = bracket ? 2 : 1;
    const delimiter = bracket ? "\\)" : "$";
    const closing = mathClosingIndex(source, delimiter, offset, bracket, this.lexer);
    if (closing < 0) return undefined;
    const expression = source.slice(offset, closing);
    // Dollar delimiters retain their currency/whitespace guard. Explicit TeX
    // parentheses are unambiguous and accept surrounding whitespace and newlines.
    if (!expression.trim() || (!bracket && /^\s|\s$/.test(expression))) return undefined;
    return {
      type: "richTextMathInline",
      raw: source.slice(0, closing + delimiter.length),
      text: expression,
      displayMode: false,
    } as RichTextMathToken;
  },
  renderer(token) {
    const math = token as RichTextMathToken;
    return renderRichTextMath(math.text, false);
  },
};

function linkAttributes(link: SafeRichTextUrl, title: string | null | undefined) {
  const titleAttribute = title ? ` title="${escapeRichTextHtml(title)}"` : "";
  const external = link.externalHttp
    ? ' target="_blank" rel="noopener noreferrer"'
    : "";
  return `${titleAttribute}${external}`;
}

function createRichTextRenderer(mode: RichTextMode) {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeRichTextHtml(text);
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const safeLink = safeRichTextUrl(href, SAFE_LINK_PROTOCOLS);
    if (!safeLink) return text;
    return `<a href="${escapeRichTextHtml(safeLink.value)}"${linkAttributes(safeLink, title)}>${text}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    const safeImage = safeRichTextUrl(href, SAFE_IMAGE_PROTOCOLS);
    if (!safeImage) return escapeRichTextHtml(text);
    if (mode === "comment") {
      const label = text.trim() ? `Image: ${text.trim()}` : "Open image";
      return `<a class="rich-text-image-link" href="${escapeRichTextHtml(safeImage.value)}"${linkAttributes(safeImage, title)}>${escapeRichTextHtml(label)}</a>`;
    }
    const titleAttribute = title ? ` title="${escapeRichTextHtml(title)}"` : "";
    return `<img src="${escapeRichTextHtml(safeImage.value)}" alt="${escapeRichTextHtml(text)}"${titleAttribute} loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  };
  if (mode === "comment") {
    renderer.heading = function ({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      return `<p class="rich-text-comment-heading" data-heading-level="${depth}">${text}</p>`;
    };
  }
  return renderer;
}

function createRichTextParser(mode: RichTextMode) {
  return new Marked({
    async: false,
    breaks: mode === "comment",
    gfm: true,
    pedantic: false,
    renderer: createRichTextRenderer(mode),
    extensions: [blockMathExtension, inlineMathExtension],
  });
}

const documentRichText = createRichTextParser("document");
const commentRichText = createRichTextParser("comment");

export function richTextStartsWithHeading(source: string | null | undefined) {
  if (!source?.trim()) return false;
  try {
    const firstToken = documentRichText.lexer(source).find((token) => token.type !== "space");
    return firstToken?.type === "heading";
  } catch {
    return false;
  }
}

export function renderRichText(source: string, mode: RichTextMode = "document") {
  if (!source.trim()) return "";
  try {
    const output = (mode === "comment" ? commentRichText : documentRichText).parse(source);
    return typeof output === "string"
      ? output
      : `<pre><code>${escapeRichTextHtml(source)}</code></pre>`;
  } catch {
    return `<pre class="rich-text-fallback"><code>${escapeRichTextHtml(source)}</code></pre>`;
  }
}

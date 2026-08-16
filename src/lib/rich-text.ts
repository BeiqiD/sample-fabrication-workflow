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
      throwOnError: false,
      trust: false,
    });
    const tag = displayMode ? "div" : "span";
    const mode = displayMode ? "block" : "inline";
    return `<${tag} class="rich-text-math rich-text-math-${mode}">${math}</${tag}>`;
  } catch {
    return `<code class="rich-text-math-error">${escapeRichTextHtml(source)}</code>`;
  }
}

function firstIndex(source: string, needles: string[]) {
  const matches = needles.map((needle) => source.indexOf(needle)).filter((index) => index >= 0);
  return matches.length ? Math.min(...matches) : undefined;
}

const blockMathExtension: TokenizerAndRendererExtension = {
  name: "richTextMathBlock",
  level: "block",
  start(source) {
    return firstIndex(source, ["$$", "\\["]);
  },
  tokenizer(source) {
    const dollarMatch = source.match(/^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/);
    const bracketMatch = source.match(/^\\\[[ \t]*\n?([\s\S]+?)\n?[ \t]*\\\](?:[ \t]*(?:\n|$))/);
    const match = dollarMatch ?? bracketMatch;
    if (!match || !match[1].trim()) return undefined;
    return {
      type: "richTextMathBlock",
      raw: match[0],
      text: match[1],
      displayMode: true,
    } as RichTextMathToken;
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
    return firstIndex(source, ["$", "\\("]);
  },
  tokenizer(source) {
    const dollarMatch = source.match(/^\$(?!\$)([^$\n]+?)\$(?!\$)/);
    const bracketMatch = source.match(/^\\\((.+?)\\\)/);
    const match = dollarMatch ?? bracketMatch;
    if (!match || !match[1].trim() || /^\s|\s$/.test(match[1])) return undefined;
    return {
      type: "richTextMathInline",
      raw: match[0],
      text: match[1],
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

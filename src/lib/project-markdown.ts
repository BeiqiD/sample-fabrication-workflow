import { Marked, Renderer, type TokenizerAndRendererExtension, type Tokens } from "marked";
import Temml from "temml";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const PROJECT_MARKDOWN_BASE_URL = new URL("https://project.invalid/");

type ProjectMathToken = Tokens.Generic & {
  text: string;
  displayMode: boolean;
};

export function escapeProjectMarkdownHtml(value: string) {
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

type SafeProjectUrl = {
  value: string;
  externalHttp: boolean;
};

function safeProjectUrl(value: string, protocols: Set<string>): SafeProjectUrl | null {
  const trimmed = value.trim();
  if (!trimmed
    || hasUnsafeUrlCharacters(trimmed)
    || trimmed.includes("\\")
    || trimmed.startsWith("//")) return null;
  try {
    const parsed = new URL(trimmed, PROJECT_MARKDOWN_BASE_URL);
    const sameOrigin = parsed.origin === PROJECT_MARKDOWN_BASE_URL.origin;
    if (!sameOrigin && !protocols.has(parsed.protocol)) return null;
    return {
      value: trimmed,
      externalHttp: !sameOrigin && (parsed.protocol === "http:" || parsed.protocol === "https:"),
    };
  } catch {
    return null;
  }
}

export function projectMarkdownSafeHref(value: string) {
  return safeProjectUrl(value, SAFE_LINK_PROTOCOLS)?.value ?? null;
}

export function projectMarkdownSafeImageSrc(value: string) {
  return safeProjectUrl(value, SAFE_IMAGE_PROTOCOLS)?.value ?? null;
}

function renderProjectMath(source: string, displayMode: boolean) {
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
    return `<${tag} class="project-markdown-math project-markdown-math-${mode}">${math}</${tag}>`;
  } catch {
    return `<code class="project-markdown-math-error">${escapeProjectMarkdownHtml(source)}</code>`;
  }
}

function firstIndex(source: string, needles: string[]) {
  const matches = needles.map((needle) => source.indexOf(needle)).filter((index) => index >= 0);
  return matches.length ? Math.min(...matches) : undefined;
}

const blockMathExtension: TokenizerAndRendererExtension = {
  name: "projectMathBlock",
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
      type: "projectMathBlock",
      raw: match[0],
      text: match[1],
      displayMode: true,
    } as ProjectMathToken;
  },
  renderer(token) {
    const math = token as ProjectMathToken;
    return renderProjectMath(math.text, true);
  },
};

const inlineMathExtension: TokenizerAndRendererExtension = {
  name: "projectMathInline",
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
      type: "projectMathInline",
      raw: match[0],
      text: match[1],
      displayMode: false,
    } as ProjectMathToken;
  },
  renderer(token) {
    const math = token as ProjectMathToken;
    return renderProjectMath(math.text, false);
  },
};

const renderer = new Renderer();
renderer.html = ({ text }) => escapeProjectMarkdownHtml(text);
renderer.link = function ({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  const safeLink = safeProjectUrl(href, SAFE_LINK_PROTOCOLS);
  if (!safeLink) return text;
  const titleAttribute = title ? ` title="${escapeProjectMarkdownHtml(title)}"` : "";
  const external = safeLink.externalHttp
    ? ' target="_blank" rel="noopener noreferrer"'
    : "";
  return `<a href="${escapeProjectMarkdownHtml(safeLink.value)}"${titleAttribute}${external}>${text}</a>`;
};
renderer.image = ({ href, title, text }) => {
  const safeSrc = projectMarkdownSafeImageSrc(href);
  if (!safeSrc) return escapeProjectMarkdownHtml(text);
  const titleAttribute = title ? ` title="${escapeProjectMarkdownHtml(title)}"` : "";
  return `<img src="${escapeProjectMarkdownHtml(safeSrc)}" alt="${escapeProjectMarkdownHtml(text)}"${titleAttribute} loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
};

const projectMarkdown = new Marked({
  async: false,
  breaks: false,
  gfm: true,
  pedantic: false,
  renderer,
  extensions: [blockMathExtension, inlineMathExtension],
});

export function projectMarkdownStartsWithHeading(source: string | null | undefined) {
  if (!source?.trim()) return false;
  try {
    const firstToken = projectMarkdown.lexer(source).find((token) => token.type !== "space");
    return firstToken?.type === "heading";
  } catch {
    return false;
  }
}

export function renderProjectMarkdown(source: string) {
  if (!source.trim()) return "";
  try {
    const output = projectMarkdown.parse(source);
    return typeof output === "string"
      ? output
      : `<pre><code>${escapeProjectMarkdownHtml(source)}</code></pre>`;
  } catch {
    return `<pre class="project-markdown-fallback"><code>${escapeProjectMarkdownHtml(source)}</code></pre>`;
  }
}

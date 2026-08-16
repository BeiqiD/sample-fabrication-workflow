import type { ProjectNodeDescriptor } from "./project-map-model";
import { projectMarkdownSafeHref } from "./project-markdown";

export const MAX_PROJECT_READABLE_EXPORT_ATTACHMENT_BYTES = 50_000_000;

export interface ProjectReadableExportWarning {
  itemId: string;
  title: string;
  reason: string;
}

export interface ProjectReadableExportManifestItem {
  itemId: string;
  kind: ProjectNodeDescriptor["kind"];
  title: string;
  createdSequence: number;
  contentId: string | null;
  relativeAttachmentPath: string | null;
  mimeType: string | null;
  caption: string | null;
  sourceUrl: string | null;
  referenceUrl: string | null;
}

export interface ProjectReadableExportManifest {
  format: "sample-fabrication-project-reading";
  version: 1;
  generatedAt: string;
  projectTitle: string;
  ordering: "created_sequence";
  items: ProjectReadableExportManifestItem[];
  warnings: ProjectReadableExportWarning[];
}

export interface BuildProjectReadableArchiveOptions {
  projectTitle?: string;
  generatedAt?: string;
  fetcher?: typeof fetch;
  maxAttachmentBytes?: number;
}

function markdownText(value: string) {
  return value.replace(/([\\`*_[\]{}()#+\-.!?|>])/g, "\\$1");
}

function markdownHeadingText(value: string) {
  return markdownText(value.replace(/\s+/g, " ").trim());
}

function markdownRelativePath(value: string) {
  return value.split("/").map((segment) => encodeURIComponent(segment)
    .replace(/[!\'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function safeFilename(value: string, fallback: string) {
  const normalized = value.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const candidate = normalized || fallback;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(candidate)
    ? `_${candidate}`
    : candidate;
  return Array.from(reserved).slice(0, 120).join("");
}

function uniqueAttachmentPath(
  node: ProjectNodeDescriptor,
  usedPaths: Set<string>,
) {
  const prefix = String(node.createdSequence).padStart(4, "0");
  const base = safeFilename(node.title, `attachment-${prefix}`);
  let path = `attachments/${prefix}-${base}`;
  let suffix = 2;
  while (usedPaths.has(path.toLowerCase())) {
    path = `attachments/${prefix}-${suffix}-${base}`;
    suffix += 1;
  }
  usedPaths.add(path.toLowerCase());
  return path;
}

function markdownUrlDestination(value: string) {
  return encodeURI(value).replace(/[()]/g, (character) => character === "(" ? "%28" : "%29");
}

function orderedNodes(nodes: ProjectNodeDescriptor[]) {
  return [...nodes].sort((left, right) => left.createdSequence - right.createdSequence
    || left.itemId.localeCompare(right.itemId));
}

function referenceMarkdown(node: ProjectNodeDescriptor) {
  const lines = [node.excerpt
    ? `> ${markdownText(node.excerpt).replace(/\n/g, "\n> ")}`
    : "> Referenced source record."];
  const safeUrl = node.openReferenceUrl ? projectMarkdownSafeHref(node.openReferenceUrl) : null;
  if (safeUrl) lines.push("", `[Open reference](${markdownUrlDestination(safeUrl)})`);
  return lines.join("\n");
}

function attachmentMarkdown(node: ProjectNodeDescriptor, relativePath: string | null) {
  const lines: string[] = [];
  if (node.attachmentCaption) lines.push(markdownText(node.attachmentCaption), "");
  if (relativePath) {
    const label = markdownHeadingText(node.attachmentCaption || node.title);
    lines.push(node.mimeType?.startsWith("image/")
      ? `![${label}](${markdownRelativePath(relativePath)})`
      : `[Open ${markdownHeadingText(node.title)}](${markdownRelativePath(relativePath)})`);
  } else {
    lines.push("_Attachment bytes were unavailable while this archive was generated._");
  }
  const safeSourceUrl = node.attachmentSourceUrl
    ? projectMarkdownSafeHref(node.attachmentSourceUrl)
    : null;
  if (safeSourceUrl) lines.push("", `[Source URL](${markdownUrlDestination(safeSourceUrl)})`);
  return lines.join("\n");
}

export async function buildProjectReadableArchive(
  nodes: ProjectNodeDescriptor[],
  options: BuildProjectReadableArchiveOptions = {},
) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const projectTitle = options.projectTitle?.trim() || "Project Reading";
  const generatedAt = options.generatedAt || new Date().toISOString();
  const fetcher = options.fetcher || fetch;
  const maxAttachmentBytes = options.maxAttachmentBytes
    ?? MAX_PROJECT_READABLE_EXPORT_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(maxAttachmentBytes) || maxAttachmentBytes < 0) {
    throw new TypeError("maxAttachmentBytes must be a non-negative safe integer");
  }
  const warnings: ProjectReadableExportWarning[] = [];
  const manifestItems: ProjectReadableExportManifestItem[] = [];
  const readingSections: string[] = [
    `# ${markdownHeadingText(projectTitle)}`,
    "",
    "This export follows the Project's immutable creation order. Markdown remains source-compatible, while attachments use relative paths under `attachments/`.",
  ];
  const usedPaths = new Set<string>();
  let packagedAttachmentBytes = 0;

  for (const node of orderedNodes(nodes)) {
    let relativeAttachmentPath: string | null = null;
    if (node.kind === "attachment" && node.fileUrl) {
      const declaredByteSize = node.attachmentByteSize;
      if (typeof declaredByteSize !== "number"
        || !Number.isSafeInteger(declaredByteSize)
        || declaredByteSize < 0) {
        warnings.push({
          itemId: node.itemId,
          title: node.title,
          reason: "Attachment byte-size metadata is unavailable",
        });
      } else if (declaredByteSize > maxAttachmentBytes - packagedAttachmentBytes) {
        warnings.push({
          itemId: node.itemId,
          title: node.title,
          reason: `Skipped because the ${maxAttachmentBytes}-byte client-side attachment limit would be exceeded`,
        });
      } else {
        try {
          const response = await fetcher(node.fileUrl, { credentials: "same-origin" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > maxAttachmentBytes - packagedAttachmentBytes) {
            warnings.push({
              itemId: node.itemId,
              title: node.title,
              reason: `Skipped because the ${maxAttachmentBytes}-byte client-side attachment limit would be exceeded`,
            });
          } else {
            const proposedPath = uniqueAttachmentPath(node, usedPaths);
            zip.file(proposedPath, bytes);
            relativeAttachmentPath = proposedPath;
            packagedAttachmentBytes += bytes.byteLength;
          }
        } catch (error) {
          warnings.push({
            itemId: node.itemId,
            title: node.title,
            reason: error instanceof Error ? error.message : "Attachment download failed",
          });
        }
      }
    } else if (node.kind === "attachment") {
      warnings.push({
        itemId: node.itemId,
        title: node.title,
        reason: "No attachment file route is available",
      });
    }

    manifestItems.push({
      itemId: node.itemId,
      kind: node.kind,
      title: node.title,
      createdSequence: node.createdSequence,
      contentId: node.contentId,
      relativeAttachmentPath,
      mimeType: node.mimeType,
      caption: node.attachmentCaption,
      sourceUrl: node.attachmentSourceUrl,
      referenceUrl: node.openReferenceUrl,
    });

    readingSections.push("", `## ${node.createdSequence} — ${markdownHeadingText(node.title)}`, "");
    if (node.kind === "markdown") {
      readingSections.push(node.markdownSource?.trim() || "_Empty Markdown block._");
    } else if (node.kind === "attachment") {
      readingSections.push(attachmentMarkdown(node, relativeAttachmentPath));
    } else {
      readingSections.push(referenceMarkdown(node));
    }
  }

  const manifest: ProjectReadableExportManifest = {
    format: "sample-fabrication-project-reading",
    version: 1,
    generatedAt,
    projectTitle,
    ordering: "created_sequence",
    items: manifestItems,
    warnings,
  };
  zip.file("reading.md", `${readingSections.join("\n").trim()}\n`);
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  if (warnings.length) {
    zip.file("WARNINGS.md", `# Export warnings\n\n${warnings.map((warning) => `- ${markdownHeadingText(warning.title)}: ${markdownHeadingText(warning.reason)}`).join("\n")}\n`);
  }

  const archive = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { archive, manifest };
}

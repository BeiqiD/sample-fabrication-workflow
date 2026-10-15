import type { SampleDetail } from "../../shared/types";

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function assetPath(key: string) {
  return `assets/${key.split("/").map(safeName).join("/")}`;
}

function attachmentPath(id: string, filename: string) {
  return `attachments/${safeName(id)}-${safeName(filename)}`;
}

export async function exportSample(sample: SampleDetail) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const assetPaths = new Map<string, string>();
  const nativeAssetPaths = new Map<string, string>();
  const attachmentPaths = new Map<string, string>();
  const nativeUrls = new Set<string>();
  const addNative = (url: string | undefined) => { if (url?.startsWith("/api/file-assets/")) nativeUrls.add(url); };
  const imagePath = (image: { assetKey?: string | null; assetUrl?: string }) => image.assetUrl
    ? nativeAssetPaths.get(image.assetUrl) : image.assetKey ? assetPaths.get(image.assetKey) : undefined;

  const keys = new Set<string>();
  for (const event of sample.events) {
    if (event.assetKey) keys.add(event.assetKey);
    addNative(event.assetUrl); addNative(event.thumbnailUrl);
    if (typeof event.metadata.thumbnailKey === "string") keys.add(event.metadata.thumbnailKey);
  }
  for (const run of sample.runs) {
    for (const key of run.initialStateImageKeys) keys.add(key);
    for (const image of run.initialStateImages ?? []) addNative(image.url);
    for (const step of run.steps) {
      for (const key of [...step.plannedImageKeys, ...step.executionImageKeys]) keys.add(key);
      for (const image of [...(step.plannedImages ?? []), ...(step.executionImages ?? [])]) addNative(image.url);
      for (const comment of step.comments) {
        if (comment.assetKey) keys.add(comment.assetKey);
        addNative(comment.assetUrl);
        for (const image of comment.images ?? []) { if (image.assetKey) keys.add(image.assetKey); addNative(image.assetUrl); }
      }
    }
  }
  for (const comment of sample.comments ?? []) {
    for (const image of comment.images) { if (image.assetKey) keys.add(image.assetKey); addNative(image.assetUrl); }
  }
  for (const key of keys) {
    const response = await fetch(`/api/assets/${key}`);
    if (!response.ok) throw new Error(`Could not export asset ${key}`);
    const path = assetPath(key);
    zip.file(path, await response.blob());
    assetPaths.set(key, path);
  }
  for (const url of nativeUrls) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Could not export a native File asset");
    const path = `assets/native/${safeName(decodeURIComponent(url.slice("/api/file-assets/".length)))}`;
    zip.file(path, await response.blob()); nativeAssetPaths.set(url, path);
  }
  const comments = [
    ...(sample.comments ?? []),
    ...sample.runs.flatMap((run) => run.steps.flatMap((step) => step.comments.map((comment) => ({
      id: comment.submissionId || comment.id,
      attachments: comment.attachments ?? [],
    })))),
  ];
  const seenAttachments = new Set<string>();
  for (const comment of comments) {
    for (const attachment of comment.attachments) {
      if (attachment.kind !== "file" || !attachment.downloadUrl || seenAttachments.has(attachment.id)) continue;
      seenAttachments.add(attachment.id);
      const response = await fetch(attachment.downloadUrl);
      if (!response.ok) throw new Error(`Could not export attachment ${attachment.filename}`);
      const path = attachmentPath(attachment.id, attachment.filename);
      zip.file(path, await response.blob());
      attachmentPaths.set(attachment.id, path);
    }
  }

  const lines = [
    `# ${sample.code}: ${sample.title}`,
    "",
    `- Status: ${sample.status}`,
    `- Location: ${sample.location || ""}`,
    `- Created: ${sample.createdAt}`,
    "",
    sample.description || "",
    "",
    "## Sample runs",
    "",
  ];
  const sampleComments = (sample.comments ?? []).filter((comment) => comment.status === "ready");
  if (sampleComments.length) {
    lines.push("## Notes & observations", "");
    for (const comment of sampleComments) {
      lines.push(`### ${comment.createdAt}`, "", comment.body || "Files attached");
      for (const image of comment.images) if (imagePath(image)) lines.push("", `![${image.filename}](${imagePath(image)})`);
      for (const attachment of comment.attachments) {
        if (attachment.kind === "link") lines.push("", `[${attachment.title}](${attachment.url})`);
        else if (attachmentPaths.has(attachment.id)) lines.push("", `[${attachment.filename}](${attachmentPaths.get(attachment.id)})`);
      }
      lines.push("");
    }
  }
  for (const run of sample.runs) {
    lines.push(`### Run ${run.sequenceNo}: ${run.templateName} — ${run.templateType} v${run.templateVersion}`, "",
      `- Status: ${run.status}`, `- Plan revision: ${run.planRevisionNumber}`, `- Predecessor run: ${run.predecessorRunId || ""}`, "");
    for (const key of run.initialStateImageKeys) lines.push("", `![Initial substrate](${assetPaths.get(key)})`);
    for (const image of run.initialStateImages ?? []) if (nativeAssetPaths.has(image.url)) lines.push("", `![Initial substrate](${nativeAssetPaths.get(image.url)})`);
    const visibleSteps = run.steps.filter((step) => step.planStatus === "current" || step.actualizedAt).sort((left, right) => left.position - right.position);
    for (const [index, step] of visibleSteps.entries()) {
      lines.push(`#### ${index + 1}. ${step.title} [${step.status}]`, "", `- Origin: ${step.origin}`, `- Tool: ${step.toolName || ""}`, "", step.parametersText || "");
      if (step.commentsText) lines.push("", step.commentsText);
      if (step.deviationNote) lines.push("", `**Deviation:** ${step.deviationNote}`);
      const commonComments = step.comments.filter((comment) => comment.scope === "common");
      const individualComments = step.comments.filter((comment) => comment.scope === "individual");
      if (commonComments.length) {
        lines.push("", "**Common execution comments:**");
        for (const comment of commonComments) {
          lines.push(`- ${comment.body || "Image attached"} (${comment.createdAt})`);
          const images = comment.images?.length ? comment.images : comment.assetKey || comment.assetUrl ? [{ assetKey: comment.assetKey, assetUrl: comment.assetUrl, filename: "Comment image" }] : [];
          for (const image of images) if (imagePath(image)) lines.push(`  ![${image.filename}](${imagePath(image)})`);
          for (const attachment of comment.attachments ?? []) {
            if (attachment.kind === "link") lines.push(`  [${attachment.title}](${attachment.url})`);
            else if (attachmentPaths.has(attachment.id)) lines.push(`  [${attachment.filename}](${attachmentPaths.get(attachment.id)})`);
          }
        }
      }
      if (individualComments.length) {
        lines.push("", "**Individual execution comments:**");
        for (const comment of individualComments) {
          lines.push(`- ${comment.body || "Image attached"} (${comment.createdAt})`);
          const images = comment.images?.length ? comment.images : comment.assetKey || comment.assetUrl ? [{ assetKey: comment.assetKey, assetUrl: comment.assetUrl, filename: "Comment image" }] : [];
          for (const image of images) if (imagePath(image)) lines.push(`  ![${image.filename}](${imagePath(image)})`);
          for (const attachment of comment.attachments ?? []) {
            if (attachment.kind === "link") lines.push(`  [${attachment.title}](${attachment.url})`);
            else if (attachmentPaths.has(attachment.id)) lines.push(`  [${attachment.filename}](${attachmentPaths.get(attachment.id)})`);
          }
        }
      }
      for (const key of [...step.plannedImageKeys, ...step.executionImageKeys]) lines.push("", `![${step.title}](${assetPaths.get(key)})`);
      for (const image of [...(step.plannedImages ?? []), ...(step.executionImages ?? [])]) if (nativeAssetPaths.has(image.url)) lines.push("", `![${step.title}](${nativeAssetPaths.get(image.url)})`);
      lines.push("");
    }
  }
  lines.push("## State verification chain", "");
  for (const verification of sample.stateVerifications) {
    lines.push(`### ${verification.createdAt} — ${verification.result}`, "",
      `- After run step: ${verification.afterRunStepId}`,
      `- Previous verification: ${verification.previousVerificationId || ""}`,
      `- Covered steps: ${verification.coveredRunStepIds.join(", ")}`,
      `- Status: ${verification.status}`, "", verification.note || "", "");
  }
  lines.push(
    "## Timeline",
    "",
  );
  for (const event of [...sample.events].reverse()) {
    lines.push(`### ${event.createdAt} — ${event.kind}`, "", event.body || "");
    if (imagePath(event)) lines.push("", `![${event.body || event.kind}](${imagePath(event)})`);
    lines.push("");
  }

  zip.file("sample.json", JSON.stringify(sample, null, 2));
  zip.file("sample.md", lines.join("\n"));
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeName(sample.code)}.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import type { SampleDetail } from "../../shared/types";

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function assetPath(key: string) {
  return `assets/${key.split("/").map(safeName).join("/")}`;
}

export async function exportSample(sample: SampleDetail) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const assetPaths = new Map<string, string>();

  const keys = new Set<string>();
  for (const event of sample.events) {
    if (event.assetKey) keys.add(event.assetKey);
    if (typeof event.metadata.thumbnailKey === "string") keys.add(event.metadata.thumbnailKey);
  }
  for (const run of sample.runs) {
    for (const step of run.steps) for (const key of [...step.plannedImageKeys, ...step.executionImageKeys]) keys.add(key);
  }
  for (const key of keys) {
    const response = await fetch(`/api/assets/${key}`);
    if (!response.ok) throw new Error(`Could not export asset ${key}`);
    const path = assetPath(key);
    zip.file(path, await response.blob());
    assetPaths.set(key, path);
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
  for (const run of sample.runs) {
    lines.push(`### ${run.templateName} — ${run.templateType} v${run.templateVersion}`, "");
    for (const [index, step] of run.steps.entries()) {
      lines.push(`#### ${index + 1}. ${step.title} [${step.status}]`, "", `- Origin: ${step.origin}`, `- Tool: ${step.toolName || ""}`, "", step.parametersText || "");
      if (step.commentsText) lines.push("", step.commentsText);
      if (step.deviationNote) lines.push("", `**Deviation:** ${step.deviationNote}`);
      for (const key of [...step.plannedImageKeys, ...step.executionImageKeys]) lines.push("", `![${step.title}](${assetPaths.get(key)})`);
      lines.push("");
    }
  }
  lines.push(
    "## Timeline",
    "",
  );
  for (const event of [...sample.events].reverse()) {
    lines.push(`### ${event.createdAt} — ${event.kind}`, "", event.body || "");
    if (event.assetKey) lines.push("", `![${event.body || event.kind}](${assetPaths.get(event.assetKey)})`);
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

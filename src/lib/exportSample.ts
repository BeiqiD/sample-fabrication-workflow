import type { SampleDetail } from "../../shared/types";

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function exportSample(sample: SampleDetail) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const assets = zip.folder("assets")!;
  const assetPaths = new Map<string, string>();

  for (const event of sample.events) {
    if (!event.assetKey || assetPaths.has(event.assetKey)) continue;
    const response = await fetch(`/api/assets/${event.assetKey}`);
    if (!response.ok) throw new Error(`Could not export asset ${event.assetKey}`);
    const basename = safeName(event.assetKey.split("/").pop() || "asset");
    const path = `assets/${basename}`;
    assets.file(basename, await response.blob());
    assetPaths.set(event.assetKey, path);
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
    "## Timeline",
    "",
  ];
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
  URL.revokeObjectURL(url);
}

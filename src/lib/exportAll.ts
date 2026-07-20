import { api } from "./api";

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function exportAll(onProgress?: (completed: number, total: number) => void) {
  const [{ default: JSZip }, manifest] = await Promise.all([import("jszip"), api.getFullExport()]);
  const zip = new JSZip();
  zip.file("export-manifest.json", JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    exportedAt: manifest.exportedAt,
    tables: Object.fromEntries(Object.entries(manifest.tables).map(([name, rows]) => [name, { rowCount: rows.length, path: `tables/${name}.json` }])),
    assets: manifest.assetKeys.map((key) => ({ key, path: `assets/${key.split("/").map(safeSegment).join("/")}` })),
  }, null, 2));
  for (const [name, rows] of Object.entries(manifest.tables)) {
    zip.file(`tables/${safeSegment(name)}.json`, JSON.stringify(rows, null, 2));
  }
  onProgress?.(0, manifest.assetKeys.length);
  let completed = 0;
  for (const key of manifest.assetKeys) {
    const response = await fetch(`/api/assets/${key}`);
    if (!response.ok) throw new Error(`Could not export asset ${key}`);
    zip.file(`assets/${key.split("/").map(safeSegment).join("/")}`, await response.blob());
    completed += 1;
    onProgress?.(completed, manifest.assetKeys.length);
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sample-log-${manifest.exportedAt.slice(0, 10)}.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

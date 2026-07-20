import JSZip from "jszip";
import * as XLSX from "xlsx";
import type { TemplatePreview } from "../../shared/types";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

export async function parseFabuBloxWorkbook(file: File): Promise<TemplatePreview> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheets = workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      defval: null,
      raw: false,
    }),
  }));

  const zip = await JSZip.loadAsync(buffer);
  const imageEntries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith("xl/media/"));
  const images = await Promise.all(imageEntries.map(async (entry) => {
    const filename = entry.name.split("/").pop() || "image";
    const extension = filename.split(".").pop()?.toLowerCase() || "";
    return {
      filename,
      mimeType: MIME_TYPES[extension] || "application/octet-stream",
      data: await entry.async("uint8array"),
    };
  }));

  return {
    name: file.name.replace(/\.xlsx?$/i, ""),
    sourceFile: file.name,
    sheets,
    images,
  };
}

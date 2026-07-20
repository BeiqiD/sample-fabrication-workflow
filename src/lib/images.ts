const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.62;

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return file;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob || blob.size >= file.size) return file;
  const basename = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${basename}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}

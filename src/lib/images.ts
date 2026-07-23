const MAX_EDGE = 1600;
export const MAX_COMMENT_IMAGE_SOURCE_BYTES = 5 * 1024 * 1024;

export class CommentImagePreparationError extends Error {
  constructor(message: string, readonly canAttach = true) {
    super(message);
    this.name = "CommentImagePreparationError";
  }
}

async function canvasBlob(bitmap: ImageBitmap, maxEdge: number, quality: number) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare image uploads");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  if (!blob) throw new Error("This browser could not encode the selected image");
  return blob;
}

export async function compressCommentImage(file: File): Promise<{ main: File; thumbnail: File }> {
  if (!file.type.startsWith("image/")) throw new Error("The selected file is not a decodable image");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const basename = file.name.replace(/\.[^.]+$/, "");
  try {
    const [main, thumbnail] = await Promise.all([
      canvasBlob(bitmap, MAX_EDGE, 0.45),
      canvasBlob(bitmap, 480, 0.35),
    ]);
    return {
      main: new File([main], `${basename}.webp`, { type: "image/webp", lastModified: Date.now() }),
      thumbnail: new File([thumbnail], `${basename}.thumb.webp`, { type: "image/webp", lastModified: Date.now() }),
    };
  } finally { bitmap.close(); }
}

export async function prepareCommentImage(file: File): Promise<File> {
  if (file.size > MAX_COMMENT_IMAGE_SOURCE_BYTES) {
    throw new CommentImagePreparationError("This image is larger than 5 MB and cannot be inserted as a comment image.");
  }
  if (!file.type.startsWith("image/") || /(?:tiff?|raw|dng|cr2|nef|arw)/i.test(file.type)) {
    throw new CommentImagePreparationError("This file cannot be inserted as a comment image.");
  }
  try {
    return (await compressCommentImage(file)).main;
  } catch {
    throw new CommentImagePreparationError("This browser cannot decode the file as a comment image.");
  }
}

export async function compressLayerStackImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) { bitmap.close(); return file; }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.65));
  if (!webp || webp.size >= file.size) return file;
  return new File([webp], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp", lastModified: Date.now() });
}

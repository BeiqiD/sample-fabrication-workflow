import { MAX_COMMENT_IMAGE_UPLOAD_BYTES } from "../../shared/comment-submissions";
import { TaskQueue } from "./taskQueue";

interface DecodedTiffMessage {
  ok: true;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  rgba: ArrayBuffer;
}

interface FailedTiffMessage {
  ok: false;
  error: string;
}

const tiffPreviewQueue = new TaskQueue(1);
const TIFF_PREVIEW_TIMEOUT_MS = 30_000;

function decodeInWorker(file: File) {
  return new Promise<DecodedTiffMessage>((resolve, reject) => {
    const worker = new Worker(new URL("./tiffPreview.worker.ts", import.meta.url), {
      type: "module",
      name: "tiff-comment-preview",
    });
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("The TIFF preview took too long to prepare."));
    }, TIFF_PREVIEW_TIMEOUT_MS);
    const finish = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<DecodedTiffMessage | FailedTiffMessage>) => {
      finish();
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      finish();
      reject(new Error("This browser could not start the TIFF preview decoder."));
    };
    worker.postMessage({ file });
  });
}

function canvasToWebp(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("This browser could not encode the TIFF preview."));
    }, "image/webp", 0.45);
  });
}

export async function prepareTiffCommentImage(file: File) {
  return tiffPreviewQueue.run(async () => {
    const decoded = await decodeInWorker(file);
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot render the TIFF preview.");
    context.putImageData(new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height), 0, 0);
    const webp = await canvasToWebp(canvas);
    canvas.width = 1;
    canvas.height = 1;
    if (webp.size > MAX_COMMENT_IMAGE_UPLOAD_BYTES) {
      throw new Error("The generated TIFF preview is too large to upload.");
    }
    const basename = file.name.replace(/\.[^.]+$/, "");
    return new File([webp], `${basename}.webp`, { type: "image/webp", lastModified: Date.now() });
  });
}

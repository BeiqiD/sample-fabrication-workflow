import { decodeTiffPreview } from "./tiffPreviewCore";

interface TiffWorkerRequest {
  file: File;
}

type TiffWorkerResponse = {
  ok: true;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  rgba: ArrayBuffer;
} | {
  ok: false;
  error: string;
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<TiffWorkerRequest>) => void) | null;
  postMessage: (message: TiffWorkerResponse, transfer?: Transferable[]) => void;
};

workerScope.onmessage = (event) => {
  void (async () => {
    try {
      const decoded = decodeTiffPreview(await event.data.file.arrayBuffer());
      const rgba = decoded.rgba.buffer as ArrayBuffer;
      workerScope.postMessage({
        ok: true,
        width: decoded.width,
        height: decoded.height,
        sourceWidth: decoded.sourceWidth,
        sourceHeight: decoded.sourceHeight,
        rgba,
      }, [rgba]);
    } catch (error) {
      workerScope.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : "The TIFF preview could not be prepared.",
      });
    }
  })();
};

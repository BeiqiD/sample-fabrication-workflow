declare module "utif" {
  export interface TiffIfd {
    [tag: string]: unknown;
    width?: number;
    height?: number;
    data?: Uint8Array;
    isLE?: boolean;
  }

  const UTIF: {
    encode(images: TiffIfd[]): ArrayBuffer;
    encodeImage(rgba: ArrayLike<number>, width: number, height: number, metadata?: Record<string, unknown>): ArrayBuffer;
    decode(buffer: ArrayBuffer): TiffIfd[];
    decodeImage(buffer: ArrayBuffer, image: TiffIfd, images?: TiffIfd[]): void;
    toRGBA8(image: TiffIfd): Uint8Array;
  };

  export default UTIF;
}

import type { CommentImage, FileAssetMediaRef, SampleEvent } from "../../shared/types";

/** Legacy keys remain keys; native media uses its explicit authorized URL. */
export function fileAssetMediaUrls(keys: readonly string[], refs?: readonly FileAssetMediaRef[]): string[] {
  return [...keys.map(key => `/api/assets/${key}`), ...(refs?.map(ref => ref.url) ?? [])];
}
export function commentImageUrl(image: Pick<CommentImage, "assetKey" | "assetUrl">): string | null {
  return image.assetUrl ?? (image.assetKey ? `/api/assets/${image.assetKey}` : null);
}
export function sampleEventAssetUrl(event: Pick<SampleEvent, "assetKey" | "assetUrl">): string | null {
  return event.assetUrl ?? (event.assetKey ? `/api/assets/${event.assetKey}` : null);
}

export const PAGE_LOAD_AUTOFOCUS_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";

type MatchMedia = (query: string) => Pick<MediaQueryList, "matches">;

export function shouldAutoFocusPageField(matchMedia?: MatchMedia) {
  const evaluate = matchMedia
    ?? (typeof window === "undefined" ? null : window.matchMedia.bind(window));
  return evaluate?.(PAGE_LOAD_AUTOFOCUS_MEDIA_QUERY).matches ?? false;
}

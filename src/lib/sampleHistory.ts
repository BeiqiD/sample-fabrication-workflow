export const SAMPLE_HISTORY_PREVIEW_COUNT = 5;

export function visibleSampleHistory<T>(eventsNewestFirst: readonly T[], expanded: boolean): T[] {
  return expanded ? [...eventsNewestFirst] : eventsNewestFirst.slice(0, SAMPLE_HISTORY_PREVIEW_COUNT);
}
